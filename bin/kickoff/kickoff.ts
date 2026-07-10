/**
 * ENTRYPOINT: the bridge from the Linear queue back into the build pipeline.
 *
 *   bun run bin/kickoff/kickoff.ts
 *
 * Fills build capacity in one pass (cron-friendly), then exits. Each
 * iteration: select one Ready issue that does not carry needs-definition
 * (claiming it — moving it to In-Progress — BEFORE building, so a re-run/crash can't
 * double-launch), create an isolated worktree on a branch carrying the
 * Linear id (so the PR auto-links + the merge auto-resolves the issue), write
 * the generated `spec.md` INSIDE that worktree, and launch the build there
 * DETACHED — a user-visible `claude "/build <slug>"` supervisor session in a
 * Superset terminal that outlives this process; /build launches `bin/build.ts`
 * in the background and escalates blockers (NEEDS-INPUT.md) to the user.
 * The loop repeats until the select agent reports at-capacity / nothing
 * ready, hard-capped at `maxConcurrentBuilds` launches per run. Launched
 * builds shepherd themselves to a PR; the kickoff run does not wait on them.
 *
 * When a detached launch isn't possible (git provider, superset degraded),
 * the build runs synchronously instead and its exit code ends the run —
 * one build per run in that mode.
 *
 * Ordering is load-bearing (the round-2 blocking fix): worktree FIRST, then the
 * spec write into the worktree, then the build with `cwd = worktreePath` — so
 * the build never starts without its canonical input artifact present.
 *
 * Worktree provisioning is pluggable (`worktree-provider.ts`, selected by
 * `config.worktree.provider`): `gwt add <branch>` (the git/herdr providers, which
 * also run full project setup) or the Superset CLI. The provider owns the
 * worktree's path; kickoff only consumes what `createWorktree` returns (the
 * gwt-reported path, falling back to the provider's prediction).
 *
 * All process boundaries (the select subprocess, worktree creation, the spec
 * write, the `bin/build.ts` launch) are injected so the orchestration is unit-
 * testable without spawning anything.
 */

import { spawn } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  buildCommonProperties,
  resolveDistinctId,
} from "../analytics/common-properties"
import type { KickoffOutcome } from "../analytics/event-mappers"
import {
  createPipelineAnalytics,
  noopAnalytics,
  type PipelineAnalytics,
} from "../analytics/pipeline-analytics"
import { herdrWorkspaceListRaw } from "../build/cleanup"
import { childGroupOptions } from "../build/harness"
import { detectRepoRoot, sh, worktreeListPorcelain } from "../build/repo"
import {
  isCleanupMode,
  isHelpMode,
  isRestoreMode,
  parseCleanupArgs,
} from "./args"
import { kickoffBranch } from "./branch"
import { defaultCleanupDeps, runCleanup } from "./cleanup-mode"
import { type KickoffConfig, loadConfig, validateConfig } from "./config"
import { kickoffHelpText } from "./help"
import { KICKOFF_BASE_REF } from "./kickoff-base"
import { acquireKickoffLock, releaseKickoffLock } from "./kickoff-lock"
import { type LinearGraphql, linearGraphql } from "./linear-client"
import {
  isMonitorMode,
  monitorLoop,
  type PassOutcome,
  resolveMonitorIntervalMs,
} from "./monitor"
import { type RestoreDeps, type RestoreTicket, restore } from "./restore"
import { runDeterministicRestoreSelect } from "./restore-select"
import { runDeterministicSelect, type SelectResult } from "./select"
import { generateSlugDetailed, type SlugResult } from "./slug-llm"
import { specDocFromBrief } from "./spec-doc"
import {
  makeWorktreeProvider,
  type WorktreeHandle,
  type WorktreeProvider,
} from "./worktree-provider"

// Re-exported for back-compat: existing importers (and tests) reference
// `KICKOFF_BASE_REF` from this module. The constant lives in `kickoff-base.ts`
// to avoid a `kickoff.ts ↔ restore.ts` import cycle.
export { KICKOFF_BASE_REF } from "./kickoff-base"

// The select result contract is single-sourced in `./select` (the deterministic
// runner produces it). Re-exported here for back-compat: existing importers and
// tests reference `SelectResult` from this module.
export type { SelectResult } from "./select"

export type KickoffDeps = {
  /** Spawn the select+claim agent and return its parsed result. */
  runSelect: (args: {
    repoRoot: string
    config: KickoffConfig
  }) => Promise<SelectResult>
  /**
   * Whether the slug is already taken — a `build/<slug>` dir in the main tree
   * or ANY live worktree building the same slug (regardless of
   * issue id: two builds sharing `build/<slug>/` would collide at merge).
   */
  buildDirExists: (slug: string) => boolean
  /**
   * Derive the base slug (before any collision suffix) for a claimed issue, with
   * telemetry. Production calls a cheap LLM (`generateSlugDetailed`) for a 1–3
   * word slug and falls back to `slugify(title)` on failure; tests stub it.
   */
  deriveSlug: (args: { title: string; brief: string }) => Promise<SlugResult>
  /**
   * Create the worktree on `branch` based off `base` (never current HEAD) and
   * return its absolute path. The provider owns where the worktree lives.
   */
  createWorktree: (args: {
    slug: string
    branch: string
    base: string
  }) => Promise<string>
  /** Write the spec doc at the given absolute path. */
  writeSpec: (specPath: string, contents: string) => void
  /**
   * Write the kickoff→build identity sidecar (`{issueId, issueUuid}`) at the
   * given absolute path so the downstream build seeds its analytics join key on
   * EVERY event without depending on the best-effort ensure-ticket step. IDs
   * only (payload policy). Best-effort: a failure is logged, never fatal.
   */
  writeIdentity: (
    path: string,
    ids: { issueId: string; issueUuid: string },
  ) => void
  /**
   * Start the build for <slug> with cwd = worktreePath. `detached` means a
   * supervising `/build` session was launched into a terminal that outlives
   * this process (keep filling capacity); `sync` means `bin/build.ts` ran to
   * completion here (its code ends the run). `issueId`/`issueUuid` are threaded
   * into the headless spawn's env as a redundant identity seed (the detached
   * launch relies on the sidecar — see §3.0).
   *
   * `onLaunch` is invoked exactly once at the SPAWN point — the moment the build
   * process is started — so the caller can record `kickoff_build_launched` with
   * launch latency, not completion time. This matters for the sync path: there
   * `runBuild` doesn't resolve until the whole build finishes, so emitting at
   * resolve would make `duration_ms` the build runtime and would queue no
   * launched event while a stalled/killed sync build is still running.
   */
  runBuild: (args: {
    slug: string
    worktreePath: string
    issueId: string
    issueUuid: string
    onLaunch?: (mode: BuildRunResult["mode"]) => void
  }) => Promise<BuildRunResult>
  log: (message: string) => void
}

/** Which kickoff entrypoint a pass ran under — stamped on every pass event. */
export type KickoffMode = "single" | "monitor" | "restore"

/** How a build was run: launched detached, or completed synchronously. */
export type BuildRunResult =
  | { mode: "detached" }
  | { mode: "sync"; code: number }

/**
 * Validate a parsed select result object. NOTE: the deterministic select
 * (`runDeterministicSelect`) builds `SelectResult` directly, so this is no
 * longer on the select path; it is retained as a still-valid `SelectResult`
 * validator (and for its existing tests). A blind cast would let a
 * well-formed-but-wrong object explode deep in the loop AFTER the claim.
 */
export function parseSelectResult(
  value: unknown,
  source: string,
): SelectResult {
  const obj = value as Record<string, unknown> | null
  if (obj && obj.none === true) {
    return { none: true, atCapacity: obj.atCapacity === true }
  }
  const valid =
    obj !== null &&
    typeof obj === "object" &&
    typeof obj.inProgressCount === "number" &&
    typeof obj.issueId === "string" &&
    obj.issueId.trim() !== "" &&
    typeof obj.issueUuid === "string" &&
    typeof obj.title === "string" &&
    obj.title.trim() !== "" &&
    typeof obj.brief === "string" &&
    (obj.source === "observations" ||
      obj.source === "sentry" ||
      obj.source === "groomed")
  if (!valid) {
    throw new Error(
      `select agent wrote an invalid result at ${source}: ${JSON.stringify(value)?.slice(0, 200)}`,
    )
  }
  return obj as SelectResult
}

/** Suffix the slug until it doesn't collide with an existing build dir. */
export function uniqueSlug(
  base: string,
  exists: (slug: string) => boolean,
): string {
  if (!exists(base)) return base
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`
    if (!exists(candidate)) return candidate
  }
}

/**
 * Run one kickoff pass: claim + launch detached builds until the select
 * agent reports at-capacity / nothing ready (hard-capped at
 * `maxConcurrentBuilds` launches). Returns the process exit code:
 *  - 0: filled what it could (zero or more detached launches) / sync build succeeded
 *  - 2: a SYNC build ran and blocked/failed (mirrors `bin/build.ts`)
 *  - 1: an issue was claimed (In-Progress) but its build never started —
 *       bounce it back to Triage by hand
 *  - 3: the select agent itself failed — nothing new was claimed (verify in
 *       Linear); already-launched builds keep running
 */
export async function kickoff(
  repoRoot: string,
  config: KickoffConfig,
  deps: KickoffDeps,
  opts: { analytics?: PipelineAnalytics; mode?: KickoffMode } = {},
): Promise<number> {
  const analytics = opts.analytics ?? noopAnalytics()
  const mode = opts.mode ?? "single"
  const passStartMs = Date.now()
  let passStarted = false
  // kickoff_pass_started is emitted after the first runSelect resolves — "start
  // observed", not before-the-loop — so in_progress_count carries the real count;
  // null only when no count is available (none-at-start or the crash path).
  const emitPassStarted = (inProgressCount: number | null) => {
    if (passStarted) return
    passStarted = true
    analytics.capture("kickoff_pass_started", {
      mode,
      max_concurrent_builds: config.maxConcurrentBuilds,
      in_progress_count: inProgressCount,
      // Pass-level: no single issue spans the pass. Keys PRESENT, value null.
      issue_id: null,
      issue_uuid: null,
      branch: null,
      slug: null,
    })
  }

  const launchedIssueIds = new Set<string>()
  let launched = 0
  // Emit kickoff_pass_completed then return the exit code. `outcome` is constrained
  // to the 7 spec values; failure-point granularity beyond the enum lives in
  // `exit_code` + the additive `at_capacity_stranded` flag.
  const finish = (
    outcome: KickoffOutcome,
    code: number,
    extra?: Record<string, unknown>,
  ): number => {
    analytics.capture("kickoff_pass_completed", {
      outcome,
      exit_code: code,
      launched_count: launched,
      duration_ms: Date.now() - passStartMs,
      issue_id: null,
      issue_uuid: null,
      branch: null,
      slug: null,
      ...extra,
    })
    return code
  }

  for (;;) {
    let selection: SelectResult
    try {
      selection = await deps.runSelect({ repoRoot, config })
    } catch (err) {
      emitPassStarted(null)
      deps.log(
        `select agent failed — nothing new claimed (verify in Linear): ${(err as Error).message}`,
      )
      return finish("select-crash", 3)
    }

    emitPassStarted(selection.none ? null : selection.inProgressCount)

    if (selection.none) {
      deps.log(
        selection.atCapacity
          ? "at capacity — nothing (more) launched"
          : "nothing ready — nothing (more) launched",
      )
      return finish(selection.atCapacity ? "at-capacity" : "nothing-ready", 0)
    }

    // A misbehaving select agent re-returning an already-launched issue
    // would otherwise slug-suffix its way into duplicate builds of one ticket.
    if (launchedIssueIds.has(selection.issueId)) {
      deps.log(
        `select agent returned ${selection.issueId} again this run — stopping to avoid a duplicate build`,
      )
      return finish("duplicate", 1)
    }

    // [PR3-1] Emit the claim for EVERY genuinely-new In-Progress issue (a non-none
    // selection means the agent ALREADY claimed it) — BEFORE the capacity guard, so
    // the claimed-but-stranded path still records the claim. slug/branch aren't
    // derived yet → explicit null (keys present); issue_id is real so the build
    // group attaches.
    analytics.capture("kickoff_issue_claimed", {
      issue_id: selection.issueId,
      issue_uuid: selection.issueUuid,
      source: selection.source,
      in_progress_count: selection.inProgressCount,
      branch: null,
      slug: null,
    })

    // Belt-and-suspenders capacity gate (the agent also enforces this). A
    // non-none selection means the agent ALREADY claimed the issue — exiting
    // quietly would strand it In-Progress, so name it and signal the operator.
    if (selection.inProgressCount >= config.maxConcurrentBuilds) {
      deps.log(
        `${selection.issueId} claimed despite capacity (${selection.inProgressCount} >= ${config.maxConcurrentBuilds}) — stranded In-Progress; bounce it back to Triage by hand`,
      )
      return finish("at-capacity", 1, { at_capacity_stranded: true })
    }

    launchedIssueIds.add(selection.issueId)
    const slugResult = await deps.deriveSlug({
      title: selection.title,
      brief: selection.brief,
    })
    const slug = uniqueSlug(slugResult.slug, deps.buildDirExists)
    const branch = kickoffBranch(selection.issueId, slug)
    analytics.capture("kickoff_slug_derived", {
      used_fallback: slugResult.usedFallback,
      model: slugResult.model,
      duration_ms: slugResult.durationMs,
      issue_id: selection.issueId,
      issue_uuid: selection.issueUuid,
      slug,
      branch,
    })

    // Failed launch: any failure BEFORE the build starts. The issue is already
    // claimed (In-Progress); v1 leaves it for the operator to bounce back to
    // Triage by hand (design-sanctioned). Already-launched builds keep running.
    // 1. Worktree FIRST — anchored to the canonical base ref, not current HEAD.
    let worktreePath: string
    const worktreeStart = Date.now()
    try {
      worktreePath = await deps.createWorktree({
        slug,
        branch,
        base: KICKOFF_BASE_REF,
      })
    } catch (err) {
      analytics.capture("kickoff_worktree_created", {
        provider: config.worktree.provider,
        success: false,
        duration_ms: Date.now() - worktreeStart,
        issue_id: selection.issueId,
        issue_uuid: selection.issueUuid,
        slug,
        branch,
      })
      deps.log(
        `${selection.issueId} claimed but build never launched: ${(err as Error).message}`,
      )
      return finish("worktree-fail", 1)
    }
    analytics.capture("kickoff_worktree_created", {
      provider: config.worktree.provider,
      success: true,
      duration_ms: Date.now() - worktreeStart,
      issue_id: selection.issueId,
      issue_uuid: selection.issueUuid,
      slug,
      branch,
    })
    try {
      // 2. Spec INSIDE the worktree (verbatim brief — no generated header/footer).
      deps.writeSpec(
        join(worktreePath, "build", slug, "spec.md"),
        specDocFromBrief(selection.brief),
      )
      // 2b. Identity sidecar next to the spec so the build seeds its analytics
      // join key on every event (best-effort — a failure NEVER aborts the launch).
      try {
        deps.writeIdentity(
          join(worktreePath, "build", slug, ".kickoff-identity.json"),
          { issueId: selection.issueId, issueUuid: selection.issueUuid },
        )
      } catch (err) {
        deps.log(
          `failed to write kickoff identity sidecar (non-fatal): ${(err as Error).message}`,
        )
      }
    } catch (err) {
      deps.log(
        `${selection.issueId} claimed but build never launched: ${(err as Error).message}`,
      )
      return finish("worktree-fail", 1)
    }

    // 3. Launch the build with cwd = worktreePath.
    let result: BuildRunResult
    const launchStart = Date.now()
    // Emit kickoff_build_launched at the SPAWN point (via runBuild's onLaunch),
    // not at resolve. The sync path's runBuild blocks until the whole build
    // finishes, so a resolve-time emit would record build runtime as duration_ms
    // and would queue no launched event while a stalled sync build runs. Guarded
    // so it fires once; the post-resolve call is a back-compat fallback for deps
    // that don't invoke onLaunch (it no-ops once onLaunch already fired).
    let launchCaptured = false
    const captureLaunch = (mode: BuildRunResult["mode"]) => {
      if (launchCaptured) return
      launchCaptured = true
      analytics.capture("kickoff_build_launched", {
        launch_mode: mode,
        duration_ms: Date.now() - launchStart,
        issue_id: selection.issueId,
        issue_uuid: selection.issueUuid,
        slug,
        branch,
      })
    }
    try {
      result = await deps.runBuild({
        slug,
        worktreePath,
        issueId: selection.issueId,
        issueUuid: selection.issueUuid,
        onLaunch: captureLaunch,
      })
    } catch (err) {
      // The launch errored mid-flight — the build's state is unknown, so don't
      // blindly bounce + re-launch without checking the workspace.
      deps.log(
        `${selection.issueId} build launch failed (state unknown — check the workspace before re-launching): ${(err as Error).message}`,
      )
      return finish("launch-fail", 1)
    }
    // Fallback for deps that never called onLaunch (e.g. test stubs): record the
    // launch now using the resolved mode. No-ops if onLaunch already fired.
    captureLaunch(result.mode)

    if (result.mode === "sync") {
      // No detached runtime available — one synchronous build per run. It DID
      // launch (count it so launched_count never undercounts the sync path); a
      // nonzero build exit is carried by exit_code + build_completed.
      launched++
      deps.log(
        `${selection.issueId} build exited ${result.code} (branch ${branch})`,
      )
      return finish("launched", result.code)
    }

    deps.log(`${selection.issueId} build launched detached (branch ${branch})`)
    launched++
    if (launched >= config.maxConcurrentBuilds) {
      deps.log(
        `launched ${launched}/${config.maxConcurrentBuilds} builds — at capacity for this run`,
      )
      return finish("launched", 0)
    }
  }
}

/**
 * Visible-build contract (the double-build guard lives here):
 *  - the provider launches a detached visible build → `{mode: "detached"}`;
 *  - it returns false (couldn't launch) or is unsupported → run `headless`
 *    synchronously and return its code;
 *  - it THROWS (launch state unknown) → propagate WITHOUT running `headless` —
 *    the build may have started and a second launch would double-build.
 */
export async function runBuildWithProvider(args: {
  provider: Pick<WorktreeProvider, "startVisibleBuild">
  handle: WorktreeHandle
  slug: string
  worktreePath: string
  headless: () => Promise<number>
  onLaunch?: (mode: BuildRunResult["mode"]) => void
}): Promise<BuildRunResult> {
  if (args.provider.startVisibleBuild) {
    const started = await args.provider.startVisibleBuild({
      handle: args.handle,
      worktreePath: args.worktreePath,
      slug: args.slug,
    })
    if (started) {
      // Detached launch is the spawn point — the visible session is now live.
      args.onLaunch?.("detached")
      return { mode: "detached" }
    }
  }
  // Sync path: signal the launch BEFORE awaiting the (blocking) headless build,
  // so launch latency — not the full build runtime — lands in duration_ms.
  args.onLaunch?.("sync")
  return { mode: "sync", code: await args.headless() }
}

// --- Default (production) dependency wiring -------------------------------

export function defaultDeps(
  repoRoot: string,
  config: KickoffConfig,
  opts: { graphql?: LinearGraphql; detachChildren?: boolean } = {},
): KickoffDeps {
  const graphql = opts.graphql ?? linearGraphql
  const detach = opts.detachChildren ?? false
  const log = (message: string) =>
    process.stdout.write(`[kickoff] ${message}\n`)
  const provider = makeWorktreeProvider({
    provider: config.worktree.provider,
    supersetProjectId: config.worktree.supersetProjectId,
    log,
  })
  // The fill loop is strictly sequential (createWorktree → runBuild per
  // iteration), so the latest handle always belongs to the build being
  // launched; the closure avoids widening the KickoffDeps contract.
  let handle: WorktreeHandle = {}
  return {
    // Deterministic select: a direct Linear API pull + claim (no agent). Throws
    // on any API failure, which the kickoff loop treats as "failure, not empty
    // queue" — only an empty/blocked queue returns `{none:true}`.
    runSelect: ({ config }) =>
      runDeterministicSelect({ config }, { graphql, log }),
    // Collide against BOTH the main tree's build dir and a live (possibly
    // stalled) worktree, so a re-run never reuses a slug whose
    // worktree still exists (which would make worktree creation fail).
    buildDirExists: (slug) =>
      existsSync(join(repoRoot, "build", slug)) ||
      provider.slugInUse({ repoRoot, slug }),
    deriveSlug: (args) => generateSlugDetailed(args),
    createWorktree: async ({ slug, branch, base }) => {
      handle = await provider.create({ repoRoot, slug, branch, base })
      provider.surface?.(handle)
      // The gwt-reported path (git/herdr) wins; superset (no `path` on the
      // handle) falls back to the computed prediction.
      return handle.path ?? provider.pathFor({ repoRoot, slug, branch })
    },
    writeSpec: (specPath, contents) => {
      mkdirSync(dirname(specPath), { recursive: true })
      writeFileSync(specPath, contents)
    },
    writeIdentity: (path, ids) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(ids, null, 2)}\n`)
    },
    runBuild: ({ slug, worktreePath, issueId, issueUuid, onLaunch }) =>
      runBuildWithProvider({
        provider,
        handle,
        slug,
        worktreePath,
        onLaunch,
        headless: () =>
          new Promise((resolve, reject) => {
            // Launch via the survivor wrapper (bash) rather than bun directly:
            // it records the bun process's exit code + derived signal label to
            // build.log so an uncatchable SIGKILL/segfault is still attributable.
            // cwd=worktreePath makes both bin/build/run.sh and the
            // wrapper-internal build/<slug>/build.log resolve inside the worktree.
            const child = spawn("bash", ["bin/build/run.sh", slug], {
              stdio: "inherit",
              cwd: worktreePath,
              // Redundant identity seed for the headless/direct path. The detached
              // launch can't set env on the new terminal and relies on the sidecar.
              env: {
                ...process.env,
                BUILD_LINEAR_ISSUE_ID: issueId,
                BUILD_LINEAR_ISSUE_UUID: issueUuid,
              },
              ...childGroupOptions(detach),
            })
            child.on("error", reject)
            // A signal-killed child has no code — map it to 2 (blocked/failed)
            // so exit 1 stays unambiguous ("claimed but never launched").
            child.on("close", (c) => resolve(c ?? 2))
          }),
      }),
    log,
  }
}

/**
 * Run one kickoff pass with the single-writer pid lock held around it (acquire
 * → kickoff → release, the release in a `finally`). Returns `{skipped:true}` on
 * lock contention (another pass/cron is mid-run) or `{code}` with the kickoff
 * exit code. The lock is never held across a sleep — the monitor only ever
 * calls this, so a concurrent one-shot cron is blocked at most for one pass.
 *
 * `makeDeps` is called fresh per pass so the worktree-provider `handle` closure
 * in `defaultDeps` is never reused across ticks. `detachChildren` (monitor mode
 * only) spawns the pass's select/build children in their own process group so a
 * terminal SIGINT can't tear down an in-flight claim/build.
 */
export async function runKickoffPass(
  repoRoot: string,
  config: KickoffConfig,
  opts: {
    acquireLock?: (repoRoot: string) => boolean
    releaseLock?: (repoRoot: string) => void
    makeDeps?: () => KickoffDeps
    detachChildren?: boolean
    /** Best-effort analytics (one client per process). Defaults to no-op. */
    analytics?: PipelineAnalytics
    /** Which entrypoint this pass ran under (single/monitor). Defaults "single". */
    mode?: KickoffMode
  } = {},
): Promise<PassOutcome> {
  const acquire = opts.acquireLock ?? acquireKickoffLock
  const release = opts.releaseLock ?? releaseKickoffLock
  const makeDeps =
    opts.makeDeps ??
    (() =>
      defaultDeps(repoRoot, config, { detachChildren: opts.detachChildren }))
  // Single-writer guard: a cron tick can overlap a still-running kickoff run
  // (sync fallback builds block for hours). Claims must stay sequential.
  if (!acquire(repoRoot)) return { skipped: true }
  try {
    return {
      code: await kickoff(repoRoot, config, makeDeps(), {
        analytics: opts.analytics,
        mode: opts.mode ?? "single",
      }),
    }
  } finally {
    release(repoRoot)
  }
}

/**
 * Monitor mode production wiring: install signal handlers, resolve the
 * interval, and drive `monitorLoop` with an interruptible `setTimeout` sleep.
 * Never returns until a SIGINT/SIGTERM is received. The loop logic itself is
 * unit-tested via `monitorLoop`; this function is signals + real timers (the
 * same class of untested production wiring as `main()` and the raw spawns).
 */
async function runMonitor(
  repoRoot: string,
  config: KickoffConfig,
  log: (m: string) => void,
  analytics: PipelineAnalytics,
): Promise<void> {
  const intervalMs = resolveMonitorIntervalMs(process.env)
  let stopRequested = false
  let wake: (() => void) | null = null
  const requestStop = () => {
    stopRequested = true
    wake?.() // resolve an in-flight sleep immediately
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, requestStop)

  log(`monitor mode — interval ${intervalMs / 1000}s (SIGINT/SIGTERM to stop)`)
  try {
    await monitorLoop({
      // detachChildren: true → the pass's select/build children run in their
      // own process group, so a terminal SIGINT can't kill them mid-pass (the
      // loop's post-pass check then exits cleanly once the pass finishes).
      runPass: () =>
        runKickoffPass(repoRoot, config, {
          detachChildren: true,
          analytics,
          mode: "monitor",
        }),
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(() => {
            wake = null
            resolve()
          }, ms)
          wake = () => {
            clearTimeout(t)
            wake = null
            resolve()
          }
        }),
      shouldStop: () => stopRequested,
      now: () => new Date(),
      intervalMs,
      log,
    })
  } finally {
    // Clean teardown so a second runMonitor in one process (future test/embed)
    // doesn't leak listeners. Harmless in prod (we exit right after).
    for (const sig of ["SIGINT", "SIGTERM"] as const)
      process.off(sig, requestStop)
  }
}

// --- Restore (production) dependency wiring -------------------------------

/**
 * Git argv that fetches `<branch>` AND creates `refs/remotes/origin/<branch>`.
 *
 * A bare `git fetch origin <branch>` only writes `FETCH_HEAD`. It updates
 * `origin/<branch>` *opportunistically*, but only when the clone's configured
 * `remote.origin.fetch` refspec maps the branch — which a `--single-branch`
 * (narrowed-refspec) clone does NOT do. In that clone `origin/<branch>` stays
 * absent, so the downstream `git ls-tree origin/<branch>:build` and
 * `git worktree add ... origin/<branch>` both fail. The explicit destination
 * refspec forces the remote-tracking ref regardless of the configured refspec.
 */
export function fetchRemoteBranchArgs(branch: string): string[] {
  return [
    "git",
    "fetch",
    "origin",
    `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]
}

/**
 * Wire the production `RestoreDeps`: the deterministic restore select (Linear
 * API pull) + the git/herdr CLI boundaries. Mirrors `defaultDeps`; injected so
 * `restore()` stays spawn-free in tests.
 */
export function defaultRestoreDeps(
  repoRoot: string,
  config: KickoffConfig,
  opts: { graphql?: LinearGraphql } = {},
): RestoreDeps {
  const graphql = opts.graphql ?? linearGraphql
  const log = (message: string) =>
    process.stdout.write(`[kickoff] ${message}\n`)
  const provider = makeWorktreeProvider({ provider: "herdr", log })
  return {
    // Deterministic restore select: a read-only Linear API pull (no agent).
    runRestoreSelect: (): Promise<RestoreTicket[]> =>
      runDeterministicRestoreSelect({ config }, { graphql, log }),
    listAllBranches: () => {
      const r = sh(
        [
          "git",
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads",
          "refs/remotes/origin",
        ],
        repoRoot,
      )
      return r.code === 0 ? r.stdout.split("\n").filter((l) => l.trim()) : []
    },
    remoteBranchExists: (branch) =>
      sh(
        ["git", "ls-remote", "--exit-code", "--heads", "origin", branch],
        repoRoot,
      ).code === 0,
    fetchRemoteBranch: (branch) => {
      // Best-effort: prime origin/<branch> for the slug inspection. The
      // authoritative fetch (which throws on failure) is in createWorktree's
      // remote path, so a transient failure here just falls the slug back.
      sh(fetchRemoteBranchArgs(branch), repoRoot)
    },
    worktreeListPorcelain: () => worktreeListPorcelain(repoRoot),
    pathExists: (path) => existsSync(path),
    lsTreeBuildDirs: (sourceRef) => {
      const r = sh(
        ["git", "ls-tree", "-d", "--name-only", `${sourceRef}:build`],
        repoRoot,
      )
      return r.code === 0 ? r.stdout.split("\n").filter((l) => l.trim()) : []
    },
    prMerged: (sourceRef) => {
      // Light, best-effort: a missing PR (or any gh error) must never block a
      // restore, so any non-MERGED result is treated as "not merged".
      const branch = sourceRef.replace(/^origin\//, "")
      const r = sh(
        ["gh", "pr", "view", branch, "--json", "state", "-q", ".state"],
        repoRoot,
      )
      return r.code === 0 && r.stdout.trim() === "MERGED"
    },
    createWorktree: ({ branch }) => {
      // `gwt add <branch>` covers all three modes the old hand-rolled logic
      // implemented: it checks out an existing local branch, fetches + tracks a
      // remote-only branch, or branches a fresh one off `origin/<default>` — and
      // runs `worktree-init.sh` for full project setup. The worktree lands at
      // `gwtWorktreeDir(mainPath, branch)`, the same path `restoreOne` computed
      // and passed in. (`path`/`mode`/`base` are now gwt's concern.)
      if (sh(["gwt", "--version"], repoRoot).code !== 0) {
        throw new Error(
          "gwt not found on PATH — restore worktree creation requires the gwt CLI. Install it and retry.",
        )
      }
      const r = sh(["gwt", "add", branch], repoRoot)
      if (r.code !== 0)
        throw new Error(`gwt add ${branch} failed: ${r.stderr || r.stdout}`)
    },
    herdrWorkspaceListRaw: () => herdrWorkspaceListRaw(repoRoot),
    herdrPaneListRaw: (workspaceId) => {
      const r = sh(
        ["herdr", "pane", "list", "--workspace", workspaceId],
        repoRoot,
      )
      return r.code === 0 ? r.stdout : ""
    },
    paneIsDashboard: (paneId) => {
      const r = sh(
        ["herdr", "pane", "process-info", "--pane", paneId],
        repoRoot,
      )
      if (r.code !== 0) return false
      try {
        const parsed = JSON.parse(r.stdout) as {
          result?: {
            process_info?: {
              foreground_processes?: Array<{
                argv?: string[]
                cmdline?: string
                name?: string
              }>
            }
          }
        }
        const procs = parsed.result?.process_info?.foreground_processes ?? []
        return procs.some((p) => {
          const hay = [p.cmdline, ...(p.argv ?? []), p.name]
            .filter(Boolean)
            .join(" ")
          return hay.includes("dashboard.ts")
        })
      } catch {
        return false
      }
    },
    startWorkspace: ({ worktreePath, slug }) => {
      // The herdr provider always defines startVisibleBuild; assert it for TS.
      const start = provider.startVisibleBuild
      if (!start) return Promise.resolve(false)
      return start({ handle: {}, worktreePath, slug })
    },
    runInPane: ({ paneId, slug }) =>
      sh(["herdr", "pane", "run", paneId, `claude "/build ${slug}"`], repoRoot)
        .code === 0,
    log,
  }
}

/**
 * Run one restore pass: validate config, hard-stop on a non-herdr provider
 * (v1), take the kickoff pid lock (restore creates worktrees — the same
 * single-writer surface as a fill pass), then rebuild every in-scope ticket's
 * local environment. Returns the process exit code:
 *  - 0: restored what it could (best-effort) / lock contention skip
 *  - 2: a non-herdr provider — nothing restored (herdr-only in v1)
 *  - 3: the restore select agent itself failed — nothing restored
 */
export async function runRestore(
  repoRoot: string,
  config: KickoffConfig,
  opts: { makeDeps?: () => RestoreDeps; analytics?: PipelineAnalytics } = {},
): Promise<number> {
  const log = (m: string) => process.stdout.write(`[kickoff] ${m}\n`)
  // Light-touch restore instrumentation: only the pass-level pair (mode:restore).
  // Per-ticket restore internals stay un-instrumented (out of the spec's table).
  const analytics = opts.analytics ?? noopAnalytics()
  const passStartMs = Date.now()
  analytics.capture("kickoff_pass_started", {
    mode: "restore",
    max_concurrent_builds: config.maxConcurrentBuilds,
    in_progress_count: null,
    issue_id: null,
    issue_uuid: null,
    branch: null,
    slug: null,
  })
  const finish = (outcome: KickoffOutcome, code: number): number => {
    analytics.capture("kickoff_pass_completed", {
      outcome,
      exit_code: code,
      launched_count: 0,
      duration_ms: Date.now() - passStartMs,
      issue_id: null,
      issue_uuid: null,
      branch: null,
      slug: null,
    })
    return code
  }
  validateConfig(config)
  if (config.worktree.provider !== "herdr") {
    log(
      `restore supports the herdr provider only in v1 (config.worktree.provider = ${config.worktree.provider}); not restoring.`,
    )
    return finish("launch-fail", 2)
  }
  if (!acquireKickoffLock(repoRoot)) {
    log("another kickoff run holds the lock — skipping restore")
    return finish("launched", 0)
  }
  try {
    const makeDeps =
      opts.makeDeps ?? (() => defaultRestoreDeps(repoRoot, config))
    const code = await restore(repoRoot, config, makeDeps())
    return finish(code === 2 ? "launch-fail" : "launched", code)
  } catch (err) {
    // The only throw that reaches here is a restore select-agent failure
    // (per-ticket failures are caught inside `restore`).
    log(
      `restore select agent failed — nothing restored (verify in Linear): ${(err as Error).message}`,
    )
    return finish("select-crash", 3)
  } finally {
    releaseKickoffLock(repoRoot)
  }
}

/** Bounded-flush analytics, then exit. The flush never throws (see §1.1). */
async function shutdownAndExit(
  analytics: PipelineAnalytics,
  code: number,
): Promise<never> {
  await analytics.shutdown()
  process.exit(code)
}

async function main(): Promise<void> {
  const repoRoot = detectRepoRoot()
  const argv = process.argv
  const log = (m: string) => process.stdout.write(`[kickoff] ${m}\n`)

  // `--help` short-circuits before any other mode — needs no config or lock.
  if (isHelpMode(argv)) {
    process.stdout.write(`${kickoffHelpText()}\n`)
    process.exit(0)
  }

  // Conflicting-mode guard — pick exactly one arg-style mode.
  if (isCleanupMode(argv) && isRestoreMode(argv)) {
    log("pick one of --cleanup / --restore")
    process.exit(1)
  }

  // `--cleanup` needs no config or Linear IDs and takes no pid lock — it targets
  // a single worktree and must stay runnable while a `--watch` monitor runs.
  if (isCleanupMode(argv)) {
    process.exit(
      await runCleanup(repoRoot, parseCleanupArgs(argv), defaultCleanupDeps()),
    )
  }

  const config = loadConfig(repoRoot)

  // One analytics client per process, constructed after loadConfig (so the
  // worktree provider + run_env are known). Issue/slug/branch are filled per
  // event; the base common object carries process/provider/run_env/tooling_sha.
  const analytics = createPipelineAnalytics({
    common: buildCommonProperties({
      process: "kickoff",
      repoRoot,
      env: process.env,
      worktreeProvider: config.worktree.provider ?? null,
    }),
    distinctId: resolveDistinctId(repoRoot),
  })

  if (isRestoreMode(argv)) {
    await shutdownAndExit(
      analytics,
      await runRestore(repoRoot, config, { analytics }),
    )
  }

  validateConfig(config)

  if (isMonitorMode(argv)) {
    await runMonitor(repoRoot, config, log, analytics)
    await shutdownAndExit(analytics, 0)
  }

  const outcome = await runKickoffPass(repoRoot, config, {
    analytics,
    mode: "single",
  })
  if ("skipped" in outcome) {
    log("another kickoff run is already running — exiting")
    return await shutdownAndExit(analytics, 0)
  }
  await shutdownAndExit(analytics, outcome.code)
}

if (import.meta.main) {
  await main()
}
