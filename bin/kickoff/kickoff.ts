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
 * `config.worktree.provider`): plain `git worktree add` or the Superset CLI.
 * The provider owns the worktree's path; kickoff only consumes what
 * `createWorktree` returns.
 *
 * All process boundaries (the select subprocess, worktree creation, the spec
 * write, the `bin/build.ts` launch) are injected so the orchestration is unit-
 * testable without spawning anything.
 */

import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { builderArgs, runHarness } from "../build/harness"
import { detectRepoRoot } from "../build/repo"
import { kickoffBranch, slugify } from "./branch"
import { type KickoffConfig, loadConfig, validateConfig } from "./config"
import { acquireKickoffLock, releaseKickoffLock } from "./kickoff-lock"
import { kickoffSelectPrompt } from "./prompts"
import { specDocFromBrief } from "./spec-doc"
import {
  makeWorktreeProvider,
  type WorktreeHandle,
  type WorktreeProvider,
} from "./worktree-provider"

/**
 * The ref branches are based on. The kickoff run may run from any
 * checkout (a stale local `main`, a feature branch, another worktree), so the
 * worktree MUST be anchored to this remote-tracking ref rather than the
 * kickoff run's current HEAD — otherwise a build can inherit unrelated local
 * changes and PR against the wrong base.
 */
export const KICKOFF_BASE_REF = "main"

export type SelectResult =
  | { none: true; atCapacity?: boolean }
  | {
      none?: false
      inProgressCount: number
      issueId: string
      issueUuid: string
      title: string
      brief: string
      source: "observations" | "sentry"
    }

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
   * Start the build for <slug> with cwd = worktreePath. `detached` means a
   * supervising `/build` session was launched into a terminal that outlives
   * this process (keep filling capacity); `sync` means `bin/build.ts` ran to
   * completion here (its code ends the run).
   */
  runBuild: (args: {
    slug: string
    worktreePath: string
  }) => Promise<BuildRunResult>
  log: (message: string) => void
}

/** How a build was run: launched detached, or completed synchronously. */
export type BuildRunResult =
  | { mode: "detached" }
  | { mode: "sync"; code: number }

/**
 * Validate the select agent's parsed result file. A blind cast would let a
 * well-formed-but-wrong object explode deep in the loop AFTER the claim
 * happened — keep every agent-output failure inside the runSelect contract.
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
    (obj.source === "observations" || obj.source === "sentry")
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
): Promise<number> {
  const launchedIssueIds = new Set<string>()
  for (let launched = 0; ; ) {
    let selection: SelectResult
    try {
      selection = await deps.runSelect({ repoRoot, config })
    } catch (err) {
      deps.log(
        `select agent failed — nothing new claimed (verify in Linear): ${(err as Error).message}`,
      )
      return 3
    }

    if (selection.none) {
      deps.log(
        selection.atCapacity
          ? "at capacity — nothing (more) launched"
          : "nothing ready — nothing (more) launched",
      )
      return 0
    }

    // A misbehaving select agent re-returning an already-launched issue
    // would otherwise slug-suffix its way into duplicate builds of one ticket.
    if (launchedIssueIds.has(selection.issueId)) {
      deps.log(
        `select agent returned ${selection.issueId} again this run — stopping to avoid a duplicate build`,
      )
      return 1
    }

    // Belt-and-suspenders capacity gate (the agent also enforces this). A
    // non-none selection means the agent ALREADY claimed the issue — exiting
    // quietly would strand it In-Progress, so name it and signal the operator.
    if (selection.inProgressCount >= config.maxConcurrentBuilds) {
      deps.log(
        `${selection.issueId} claimed despite capacity (${selection.inProgressCount} >= ${config.maxConcurrentBuilds}) — stranded In-Progress; bounce it back to Triage by hand`,
      )
      return 1
    }

    launchedIssueIds.add(selection.issueId)
    const slug = uniqueSlug(slugify(selection.title), deps.buildDirExists)
    const branch = kickoffBranch(selection.issueId, slug)

    // Failed launch: any failure BEFORE the build starts. The issue is already
    // claimed (In-Progress); v1 leaves it for the operator to bounce back to
    // Triage by hand (design-sanctioned). Already-launched builds keep running.
    let worktreePath: string
    try {
      // 1. Worktree FIRST — anchored to the canonical base ref, not current HEAD.
      worktreePath = await deps.createWorktree({
        slug,
        branch,
        base: KICKOFF_BASE_REF,
      })
      // 2. Spec INSIDE the worktree (verbatim brief — no generated header/footer).
      deps.writeSpec(
        join(worktreePath, "build", slug, "spec.md"),
        specDocFromBrief(selection.brief),
      )
    } catch (err) {
      deps.log(
        `${selection.issueId} claimed but build never launched: ${(err as Error).message}`,
      )
      return 1
    }

    // 3. Launch the build with cwd = worktreePath.
    let result: BuildRunResult
    try {
      result = await deps.runBuild({ slug, worktreePath })
    } catch (err) {
      // The launch errored mid-flight — the build's state is unknown, so don't
      // blindly bounce + re-launch without checking the workspace.
      deps.log(
        `${selection.issueId} build launch failed (state unknown — check the workspace before re-launching): ${(err as Error).message}`,
      )
      return 1
    }

    if (result.mode === "sync") {
      // No detached runtime available — one synchronous build per run.
      deps.log(
        `${selection.issueId} build exited ${result.code} (branch ${branch})`,
      )
      return result.code
    }

    deps.log(`${selection.issueId} build launched detached (branch ${branch})`)
    launched++
    if (launched >= config.maxConcurrentBuilds) {
      deps.log(
        `launched ${launched}/${config.maxConcurrentBuilds} builds — at capacity for this run`,
      )
      return 0
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
}): Promise<BuildRunResult> {
  if (args.provider.startVisibleBuild) {
    const started = await args.provider.startVisibleBuild({
      handle: args.handle,
      worktreePath: args.worktreePath,
      slug: args.slug,
    })
    if (started) return { mode: "detached" }
  }
  return { mode: "sync", code: await args.headless() }
}

// --- Default (production) dependency wiring -------------------------------

export function defaultDeps(
  repoRoot: string,
  config: KickoffConfig,
  runHarnessFn: typeof runHarness = runHarness,
): KickoffDeps {
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
    runSelect: async ({ config }) => {
      const resultPath = join(
        repoRoot,
        "build",
        "kickoff",
        ".kickoff",
        "select-result.json",
      )
      mkdirSync(dirname(resultPath), { recursive: true })
      rmSync(resultPath, { force: true })
      const prompt = kickoffSelectPrompt({ config, resultPath })
      const argv = builderArgs({ bin: "claude", model: "opus" }, prompt)
      const logPath = join(
        repoRoot,
        "build",
        "kickoff",
        ".kickoff",
        "select.log",
      )
      const { code } = await runHarnessFn({
        bin: "claude",
        argv,
        cwd: repoRoot,
        logPath,
      })
      // The select agent's contract is to ALWAYS write the result file —
      // `{none:true}` when nothing's ready, `{...}` when it claimed one. A
      // non-zero exit or a missing/malformed file therefore means the agent
      // FAILED (Linear MCP auth, tooling crash, prompt error), NOT an empty
      // queue. Surfacing that as a thrown error keeps the headless/scheduled
      // contract honest instead of masking outages as "nothing launched".
      if (code !== 0) {
        throw new Error(
          `select agent exited ${code}; see ${logPath} (treating as failure, not empty queue)`,
        )
      }
      if (!existsSync(resultPath)) {
        throw new Error(
          `select agent exited 0 but wrote no result at ${resultPath}; see ${logPath}`,
        )
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(resultPath, "utf-8"))
      } catch (err) {
        throw new Error(
          `select agent wrote malformed JSON at ${resultPath}: ${(err as Error).message}`,
        )
      }
      return parseSelectResult(parsed, resultPath)
    },
    // Collide against BOTH the main tree's build dir and a live (possibly
    // stalled) worktree, so a re-run never reuses a slug whose
    // worktree still exists (which would make worktree creation fail).
    buildDirExists: (slug) =>
      existsSync(join(repoRoot, "build", slug)) ||
      provider.slugInUse({ repoRoot, slug }),
    createWorktree: async ({ slug, branch, base }) => {
      handle = await provider.create({ repoRoot, slug, branch, base })
      provider.surface?.(handle)
      return provider.pathFor({ repoRoot, slug, branch })
    },
    writeSpec: (specPath, contents) => {
      mkdirSync(dirname(specPath), { recursive: true })
      writeFileSync(specPath, contents)
    },
    runBuild: ({ slug, worktreePath }) =>
      runBuildWithProvider({
        provider,
        handle,
        slug,
        worktreePath,
        headless: () =>
          new Promise((resolve, reject) => {
            const child = spawn("bun", ["run", "bin/build.ts", slug], {
              stdio: "inherit",
              cwd: worktreePath,
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

async function main(): Promise<void> {
  const repoRoot = detectRepoRoot()
  const config = loadConfig(repoRoot)
  validateConfig(config)
  // Single-writer guard: a cron tick can overlap a still-running kickoff run
  // (sync fallback builds block for hours). Claims must stay sequential.
  if (!acquireKickoffLock(repoRoot)) {
    process.stdout.write(
      "[kickoff] another kickoff run is already running — exiting\n",
    )
    process.exit(0)
  }
  let code: number
  try {
    code = await kickoff(repoRoot, config, defaultDeps(repoRoot, config))
  } finally {
    releaseKickoffLock(repoRoot)
  }
  process.exit(code)
}

if (import.meta.main) {
  await main()
}
