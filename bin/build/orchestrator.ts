/**
 * The build orchestrator: a resumable state machine over `build/[feature]/`.
 *
 * Reads `state.json`, runs the current phase as a fresh subprocess (claude for
 * builder phases, codex for reviewer phases, the script itself for the
 * deterministic gates), applies the pure `transition()`, persists the new
 * state, and loops — until the pipeline reaches `done` or parks in `blocked`
 * (writing `NEEDS-INPUT.md` for a human). Re-running resumes from `state.json`;
 * there is no separate resume path.
 *
 * See `build/build-flow/design.html` — that `.html` is build's OWN design doc.
 * The per-feature input this pipeline reads and builds against is always
 * `build/[feature]/spec.md` (what `/spec` produces; legacy `design.md` is read
 * as a fallback via `resolveSpecPath`); don't conflate the two.
 */

import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import {
  buildCommonProperties,
  resolveDistinctId,
} from "../analytics/common-properties"
import {
  type BlockReason,
  blockReasonCategory,
  phaseVerdictLabel,
} from "../analytics/event-mappers"
import {
  createPipelineAnalytics,
  noopAnalytics,
  type PipelineAnalytics,
} from "../analytics/pipeline-analytics"
import { type LinearConfig, loadConfig } from "../kickoff/config"
import {
  type AutoMergeState,
  applyPendingAutoMerge,
  autoMergeEnableCommand,
  autoMergeReadCommand,
  clearApplyError,
  type PendingApplyDeps,
  parseAutoMergeState,
  readPendingIntent,
  writeApplyError,
  writePendingIntent,
} from "./auto-merge"
import {
  buildAutopsyLines,
  parseWrapperExit,
  readLogTail,
  runMemorystatusProbe,
} from "./autopsy"
import {
  countReviewFindingsAt,
  diffStat,
  readKickoffIdentity,
} from "./build-analytics"
import {
  closeHerdrWorkspace,
  herdrWorkspaceListRaw,
  teardownWorkspace,
} from "./cleanup"
import { installCrashHandlers } from "./crash-handlers"
import { deriveDevUrl, reachable } from "./dev-server"
import {
  decideExternalServer,
  type EnsureStartedDeps,
  ensureDevServerStarted,
  type PaneRef,
  readDevServerPane,
  resolveDevUrl,
} from "./dev-server-control"
import { ensureE2ePlan, runE2eExecute } from "./e2e"
import {
  EVAL_NEW_CASE_SCORE_FLOOR,
  EVAL_REGRESSION_MARGIN,
  type EvalPlanState,
  type EvalScores,
  ensureEvalPlan,
  readBaselineFile,
  readRequiredCases,
  runEvalExecute,
} from "./evals"
import {
  appendCrashRecord,
  buildSignalCrashRecord,
  captureLaunchContext,
  crashLogPath,
  describeSignalCrash,
  isPidAlive,
  launchContextPath,
  readLaunchContext,
} from "./forensics"
import { builderArgs, reviewerArgs, runHarness } from "./harness"
import {
  type Heartbeat,
  heartbeatPath,
  isHeartbeatStale,
  legacyHeartbeatPath,
  readHeartbeat,
  startHeartbeat,
} from "./heartbeat"
import { advanceTicketToInReview, type InReviewDeps } from "./linear-status"
import { type EnsureTicketDeps, ensureLinearTicket } from "./linear-ticket"
import { appendLog } from "./log"
import {
  defaultMarketingDeps,
  validateMarketingScreenshots,
} from "./marketing-screenshots"
import { writeScopedNextDevtoolsConfig } from "./mcp-config"
import { type MonitorPrArgs, type MonitorResult, monitorPr } from "./monitor"
import {
  OPTIONAL_STEPS,
  OPTIONAL_STEPS_FILENAME,
  parseOptionalStepsDeclaration,
  resolveOptionalStep,
  resolveOverride,
} from "./optional-steps"
import {
  type EmbedScreenshotDeps,
  embedScreenshotsInPrBody,
  listImageFiles,
} from "./pr-screenshots"
import {
  buildPrompt,
  e2eExecutePrompt,
  e2ePlanPrompt,
  e2ePlanReviewPrompt,
  evalExecutePrompt,
  evalPlanPrompt,
  evalPlanReviewPrompt,
  fallbackE2ePlanArtifact,
  fallbackEvalPlanArtifact,
  monitorAddressReviewPrompt,
  monitorCiFixPrompt,
  planPrompt,
  planReviewPrompt,
  prPrompt,
  reviewPrompt,
  reviewResponsePrompt,
} from "./prompts"
import {
  commitArtifacts,
  detectBranch,
  detectHeadSha,
  detectPrNumber,
  detectPrUrl,
  detectRepoRoot,
  fetchPrSnapshot,
  fetchPrState,
  forceRemoveWorktreeDir,
  isPrMerged,
  publishArtifacts,
  reconcileWithBase,
  removeWorktree,
  type ShResult,
  sh,
  untrackLegacyHeartbeat,
  worktreeListPorcelain,
} from "./repo"
import { invokeWithSentinelRetry, SENTINEL_RETRY_CAP } from "./sentinel-retry"
import { extractSentryFixes } from "./sentry-fixes"
import { resolveSpecPath, specExists } from "./spec-doc"
import {
  type BuildAnalytics,
  type BuildState,
  buildDir as buildDirOf,
  bumpAnalytics,
  type HarnessEntry,
  initState,
  type OptionalStepsDeclaration,
  readState,
  writeState,
} from "./state"
import {
  type Transition,
  type TransitionSignal,
  transition,
} from "./transitions"
import {
  type RunValidateArgs,
  runValidate,
  validateFailuresPath,
} from "./validate"
import {
  type BuilderVerdict,
  type CodeReviewVerdict,
  parseBuilderVerdict,
  parseCodeReviewVerdict,
  parseE2eExecuteVerdict,
  parseE2eReportVerdict,
  parseEvalExecuteVerdict,
  parseEvalReportVerdict,
  parsePlanReviewVerdict,
} from "./verdicts"

const BASE_BRANCH = "main"
/** Log a bell + warning past this many same-phase iterations (soft budget). */
const SOFT_BUDGET = 25
/** Relaxed monitor poll interval while idle-ready (waiting for a human / main to move). */
const IDLE_POLL_MS = 180_000
/** Hard backstop: escalate if a fix↔revalidate loop won't converge. */
const REVALIDATE_CAP = 50

/** Thrown by a phase that cannot proceed; the main loop parks the run in `blocked`. */
export class EscalateError extends Error {
  constructor(
    readonly phase: string,
    readonly reason: string,
    /**
     * Optional categorical block reason for analytics — when the failure point is
     * statically known at the throw site, pass it so `build_blocked` reports the
     * precise category instead of falling back to substring sniffing.
     */
    readonly category?: BlockReason,
  ) {
    super(`${phase}: ${reason}`)
    this.name = "EscalateError"
  }
}

export type StartupInputs = {
  specExists: boolean
  state: BuildState | null
  needsInputExists: boolean
}

export type StartupDecision =
  | { kind: "halt"; message: string }
  | { kind: "start"; state: BuildState }

/**
 * Decide how to begin a run from on-disk facts. (pure)
 *
 * - No state + no spec → halt (run /spec first).
 * - No state + spec → start fresh (seeding `linearIssueId` when a ticket ref
 *   was passed, so the ensure-ticket step adopts that ticket).
 * - Blocked with NEEDS-INPUT.md still present → halt (human must resolve + delete it).
 * - Already done → halt.
 * - Otherwise → resume: flip status to running, keep the phase.
 *
 * `linearIssueId` is honored only on the fresh-start branch. On resume the
 * recorded state already carries any linked id, so the passed ref is ignored.
 */
export function decideStartup(
  inputs: StartupInputs,
  feature: string,
  branch: string,
  now: string,
  linearIssueId?: string,
  linearIssueUuid?: string,
): StartupDecision {
  if (!inputs.state) {
    if (!inputs.specExists) {
      return {
        kind: "halt",
        message: `no spec.md for "${feature}" — run /spec ${feature} first`,
      }
    }
    return {
      kind: "start",
      state: initState(feature, branch, now, linearIssueId, linearIssueUuid),
    }
  }

  if (inputs.needsInputExists) {
    return {
      kind: "halt",
      message:
        "NEEDS-INPUT.md is present — resolve the blocker, delete the file, then re-run /build",
    }
  }
  if (inputs.state.status === "done" || inputs.state.phase === "done") {
    return { kind: "halt", message: `"${feature}" is already done` }
  }
  return { kind: "start", state: { ...inputs.state, status: "running" } }
}

export type Ctx = {
  repoRoot: string
  feature: string
  buildDir: string
  /**
   * Canonical-input path, resolved fresh on every access (spec.md, or legacy
   * design.md). Derived from `buildDir`, not cached — so a build that renames
   * its own input artifact mid-run (e.g. the A8 design.md → spec.md migration)
   * has its later phases pick up the new filename. Read-only: assigning is a
   * mistake, since the value is recomputed each read.
   */
  readonly specPath: string
  logPath: string
  baseBranch: string
  env: NodeJS.ProcessEnv
  now: () => string
  /**
   * Best-effort analytics emitter. Initialized to a no-op stub in `createCtx`
   * (which runs BEFORE state is seeded, so it cannot know the join key); `run()`
   * reassigns the real {@link PipelineAnalytics} once identity + provider are
   * resolved, before `build_started`. Phase handlers read it at call time.
   */
  analytics: PipelineAnalytics
}

/**
 * Build a {@link Ctx}. `specPath` is a getter that calls
 * `resolveSpecPath(buildDir)` on every access (closing over the `buildDir`
 * parameter, not `this`, so it survives any future spread/destructure), so each
 * phase reads the input artifact's current on-disk name rather than a value
 * cached at startup.
 */
export function createCtx(args: {
  repoRoot: string
  feature: string
  buildDir: string
  baseBranch: string
  env: NodeJS.ProcessEnv
  now: () => string
}): Ctx {
  const { repoRoot, feature, buildDir, baseBranch, env, now } = args
  return {
    repoRoot,
    feature,
    buildDir,
    get specPath() {
      return resolveSpecPath(buildDir)
    },
    logPath: join(buildDir, "build.log"),
    baseBranch,
    env,
    now,
    // No-op until `run()` reassigns the real client once identity is seeded.
    analytics: noopAnalytics(),
  }
}

/**
 * The escalate verdict returned when a builder phase exits without a completion
 * sentinel even after {@link SENTINEL_RETRY_CAP} auto-retries (PRO-639). The
 * reason states that auto-retry was already attempted, so a human reading
 * `NEEDS-INPUT.md` knows the pipeline already tried the mechanical recovery.
 * Exported for a focused unit test.
 */
export const noVerdictEscalate = (
  phase: string,
  retries: number,
): BuilderVerdict => ({
  kind: "escalate",
  reason:
    `${phase} phase produced no completion sentinel after ${retries} auto-retr${retries === 1 ? "y" : "ies"} ` +
    "(incomplete or crashed run — the phase kept exiting without emitting its sentinel)",
})

/**
 * Choose a code-review verdict, preferring the bare sentinel the reviewer
 * writes as the last line of `round-N.md` (the `reviewPrompt` contract) over
 * the verdict parsed from its chat message / stdout. The round file is the
 * reliable artifact; the message phrasing varies (e.g. "...with verdict
 * `BLOCKING`.") and can bury the token mid-sentence where the line parser
 * misses it, which would otherwise false-park the run as "no verdict". Falls
 * back to escalation only when neither source yields a verdict.
 */
export function chooseReviewVerdict(
  fromFile: CodeReviewVerdict | null,
  fromMessage: CodeReviewVerdict | null,
  round: number,
): CodeReviewVerdict {
  return (
    fromFile ??
    fromMessage ?? {
      kind: "escalate",
      reason: `code-review round ${round} produced no CLEAN/BLOCKING/ESCALATE verdict`,
    }
  )
}

/**
 * Run a builder harness and return its raw stdout, without parsing a verdict.
 * Used by callers that need a different sentinel grammar than the standard
 * `PLAN_DONE`/`BUILD_DONE` (e.g. the e2e execute stage's `E2E_PASS`/`E2E_FAIL`).
 */
async function invokeBuilderRaw(
  ctx: Ctx,
  harness: HarnessEntry,
  prompt: string,
  builderOpts: { mcpConfig?: string; strictMcp?: boolean } = {},
): Promise<string> {
  const argv = builderArgs(harness, prompt, builderOpts)
  const { output } = await runHarness({
    bin: harness.bin,
    argv,
    cwd: ctx.repoRoot,
    logPath: ctx.logPath,
  })
  return output
}

/**
 * Run a builder harness with bounded auto-retry on a sentinel-less exit
 * (PRO-639). A phase that exits without emitting any recognized sentinel (the
 * `hasSentinel` predicate) is relaunched up to {@link SENTINEL_RETRY_CAP} times
 * with a corrective note appended to the base prompt. Each retry is logged in
 * `build.log`, counted in the persisted `sentinelRetries` analytics counter, and
 * captured as a `build_phase_retry` event. `state` is threaded so the counter is
 * persisted IN PLACE (reassigning `state.analytics`, not `state`), mirroring how
 * `reviewPhase` persists `revalidateAttempts`, so the main loop's `...state`
 * spread and `build_completed` pick it up.
 */
async function invokeBuilderRawRetrying(
  ctx: Ctx,
  state: BuildState,
  harness: HarnessEntry,
  basePrompt: string,
  hasSentinel: (output: string) => boolean,
  builderOpts: { mcpConfig?: string; strictMcp?: boolean } = {},
): Promise<{ output: string; retries: number }> {
  return invokeWithSentinelRetry({
    runner: (p) => invokeBuilderRaw(ctx, harness, p, builderOpts),
    basePrompt,
    hasSentinel,
    onRetry: (attempt) => {
      appendLog(
        ctx.logPath,
        `phase ${state.phase}: builder exited with no completion sentinel — auto-retry ${attempt}/${SENTINEL_RETRY_CAP}`,
        ctx.now(),
      )
      // Persist the counter IN PLACE so the main loop's `...state` spread and
      // build_completed pick it up (mirrors reviewPhase's revalidateAttempts).
      state.analytics = bumpAnalytics(state, {
        sentinelRetries: (state.analytics?.sentinelRetries ?? 0) + 1,
      }).analytics
      writeState(ctx.repoRoot, state, ctx.now())
      ctx.analytics.capture("build_phase_retry", {
        phase: state.phase,
        attempt,
      })
    },
  })
}

async function invokeBuilder(
  ctx: Ctx,
  state: BuildState,
  harness: HarnessEntry,
  prompt: string,
  doneToken: "PLAN_DONE" | "BUILD_DONE",
  builderOpts: { mcpConfig?: string; strictMcp?: boolean } = {},
): Promise<BuilderVerdict> {
  const { output, retries } = await invokeBuilderRawRetrying(
    ctx,
    state,
    harness,
    prompt,
    (o) => parseBuilderVerdict(o, doneToken) != null,
    builderOpts,
  )
  return (
    parseBuilderVerdict(output, doneToken) ??
    noVerdictEscalate(doneToken, retries)
  )
}

async function invokeReviewer<T>(
  ctx: Ctx,
  harness: HarnessEntry,
  prompt: string,
  parse: (output: string) => T | null,
): Promise<T | null> {
  const lastMessage = join(ctx.buildDir, ".build", "last-message.txt")
  mkdirSync(join(ctx.buildDir, ".build"), { recursive: true })
  // Clear any stale message from a previous phase so a crash before the
  // reviewer writes can't surface an old APPROVED/CLEAN/BLOCKING verdict.
  rmSync(lastMessage, { force: true })

  const argv = reviewerArgs(harness, prompt, { outputFile: lastMessage })
  const { code, output } = await runHarness({
    bin: harness.bin,
    argv,
    cwd: ctx.repoRoot,
    logPath: ctx.logPath,
  })
  // A non-zero exit means the reviewer failed — return null so the caller
  // escalates rather than acting on a partial/empty (or stale) verdict.
  if (code !== 0) {
    appendLog(
      ctx.logPath,
      `reviewer (${harness.bin}) exited ${code}`,
      ctx.now(),
    )
    return null
  }
  const fromFile = existsSync(lastMessage)
    ? readFileSync(lastMessage, "utf-8")
    : ""
  return parse(fromFile) ?? parse(output)
}

/**
 * Fold the legacy `BUILD_SKIP_E2E=1` env escape hatch into the persisted override
 * field so the skip is durable and visible to the read-only dashboard (which never
 * reads env). Idempotent; returns the SAME object reference when nothing changes
 * (caller skips the write). Does NOT clear an existing override when the env is
 * unset — a human-set or previously-normalized override is sticky, like any hand
 * edit to state.json. (pure) Exported for test.
 */
export function normalizeEnvOverrides(
  state: BuildState,
  env: NodeJS.ProcessEnv,
): BuildState {
  let next = state
  if (env.BUILD_SKIP_E2E === "1" && next.optionalStepOverrides?.e2e !== "off") {
    next = {
      ...next,
      optionalStepOverrides: { ...next.optionalStepOverrides, e2e: "off" },
    }
  }
  if (
    env.BUILD_SKIP_EVALS === "1" &&
    next.optionalStepOverrides?.evals !== "off"
  ) {
    next = {
      ...next,
      optionalStepOverrides: { ...next.optionalStepOverrides, evals: "off" },
    }
  }
  return next
}

/** The e2e optional step's registry def — a KEYED lookup, not a `.find(...)`. */
const E2E_DEF = OPTIONAL_STEPS.e2e
/** The evals optional step's registry def — a KEYED lookup, not a `.find(...)`. */
const EVALS_DEF = OPTIONAL_STEPS.evals

/**
 * The set of env-var NAMES defined across the same dotenv files evalite loads —
 * `apps/web/.env` and `apps/web/.env.local` (see `apps/web/vitest.config.ts`).
 * A read-only inspect that returns NAMES ONLY (never values — CLAUDE.md forbids
 * printing secrets). A missing file contributes nothing. Line grammar mirrors
 * dotenv's: an optional `export ` prefix, then `KEY=` (whitespace-tolerant).
 * Exported for test.
 */
export function readEnvFileKeys(repoRoot: string): Set<string> {
  const keys = new Set<string>()
  for (const file of [".env", ".env.local"]) {
    const path = join(repoRoot, "apps", "web", file)
    if (!existsSync(path)) continue
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([\w.-]+)\s*=/)
      if (m) keys.add(m[1])
    }
  }
  return keys
}

/**
 * The model API keys the eval harness requires (the eval skill's documented
 * prerequisites: `AI_GATEWAY_API_KEY` for the gateway/driver assertion +
 * `ANTHROPIC_API_KEY` for the real model calls). Requiring BOTH is the fail-safe
 * reading of the spec's "`ANTHROPIC_API_KEY` / `AI_GATEWAY_API_KEY`". Returns
 * which are absent so the escalate message can name the precise missing key(s).
 *
 * A key counts as available if the shell `env` exports it OR one of the dotenv
 * files evalite loads defines it (`fileKeys`, from `readEnvFileKeys`) — because
 * `bunx evalite run` will read those files itself (mirroring
 * `apps/web/vitest.config.ts`). Without the `fileKeys` fallback the preflight
 * would falsely block a normal local setup that keeps the keys in `apps/web/.env`
 * rather than the shell. (pure) Exported for test; `fileKeys` defaults to empty
 * so existing env-only callers/tests are unchanged.
 */
export function hasEvalApiKeys(
  env: NodeJS.ProcessEnv,
  fileKeys: Set<string> = new Set(),
): {
  ok: boolean
  missing: string[]
} {
  const has = (k: string) => Boolean(env[k]) || fileKeys.has(k)
  const missing: string[] = []
  if (!has("AI_GATEWAY_API_KEY")) missing.push("AI_GATEWAY_API_KEY")
  if (!has("ANTHROPIC_API_KEY")) missing.push("ANTHROPIC_API_KEY")
  return { ok: missing.length === 0, missing }
}

/**
 * Three-way result of reading the base branch's committed eval baseline (R2).
 * Distinguishes the genuine bootstrap case (no baseline committed on base yet →
 * allowed as `{}`) from an unreadable/corrupt base (→ escalate, never a false
 * PASS).
 */
export type BaselineBeforeResult =
  | { status: "ok"; scores: EvalScores } // base ref + committed baseline read + parsed
  | { status: "absent" } // base ref RESOLVES, but baselines.json is not committed there yet
  | { status: "unreadable"; detail: string } // base ref unresolvable / git failure / malformed committed baseline

/** A git plumbing runner (spawnSync in production; injectable for test). */
export type GitRunner = (args: string[]) => {
  code: number
  stdout: string
  stderr: string
}

/**
 * Resolve main's committed eval baseline with a robust three-way result, using
 * git plumbing so the bootstrap-vs-unreadable distinction doesn't rely on
 * brittle stderr string-matching (R2). Fail-safe: any unexpected git failure ⇒
 * `unreadable` (block for a human), never a silent `{}`.
 *
 *  1. `git rev-parse --verify --quiet origin/<base>^{commit}` — fails / empty /
 *     throws ⇒ the base ref is unresolvable ⇒ `unreadable`.
 *  2. `git cat-file -e origin/<base>:apps/web/evals/baselines.json` — non-zero
 *     means the ref resolves but the file is not committed there yet ⇒ `absent`
 *     (bootstrap).
 *  3. `git show origin/<base>:apps/web/evals/baselines.json` → parse. A valid
 *     object ⇒ `ok`; unparseable / non-object (a corrupt committed baseline) ⇒
 *     `unreadable` (must NOT degrade to `{}`).
 */
export function readBaselineBefore(
  baseBranch: string,
  git: GitRunner = defaultGitRunner,
): BaselineBeforeResult {
  const path = "apps/web/evals/baselines.json"
  const ref = `origin/${baseBranch}`
  try {
    const rev = git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    if (rev.code !== 0 || rev.stdout.trim() === "") {
      return { status: "unreadable", detail: `base ref ${ref} not found` }
    }
    const catFile = git(["cat-file", "-e", `${ref}:${path}`])
    if (catFile.code !== 0) {
      return { status: "absent" }
    }
    const show = git(["show", `${ref}:${path}`])
    if (show.code !== 0) {
      return {
        status: "unreadable",
        detail: `git show ${ref}:${path} exited ${show.code}`,
      }
    }
    // Distinguish "parsed to a valid object" from "not JSON" INLINE — do not use
    // readBaselineFile's garbage→{} mapping here, so a corrupt committed baseline
    // escalates instead of silently becoming {}.
    let parsed: unknown
    try {
      parsed = JSON.parse(show.stdout)
    } catch {
      return {
        status: "unreadable",
        detail: `committed baseline on ${ref} is malformed (not JSON)`,
      }
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        status: "unreadable",
        detail: `committed baseline on ${ref} is malformed (not an object)`,
      }
    }
    return { status: "ok", scores: readBaselineFile(show.stdout) }
  } catch (err) {
    return {
      status: "unreadable",
      detail: `git failed reading ${ref}:${path}: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** Production git runner (spawnSync at the repo root the orchestrator runs in). */
function defaultGitRunner(args: string[]): ReturnType<GitRunner> {
  const res = spawnSync("git", args, { encoding: "utf-8" })
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  }
}

/**
 * The e2e step of the validate gate, restructured into a deliberate
 * plan → plan-feedback → execute sub-pipeline (see `bin/build/e2e.ts`).
 *
 * Whether e2e runs is now decided by the optional-step framework, not an ad-hoc
 * env check: the plan-time declaration (`state.optionalSteps.e2e`) plus a human
 * override (`state.optionalStepOverrides.e2e`) resolve to run / skip / block via
 * `resolveOptionalStep`. The legacy `BUILD_SKIP_E2E=1` env is normalized into the
 * override at startup (see `normalizeEnvOverrides`), so this function reads
 * persisted state only — never env (besides the `BUILD_E2E_MCP` infra path).
 *
 * - **skipped** (forced off, or not needed) → return `undefined` (no e2e step).
 * - **blocked** (needed, but no `next-devtools` MCP server / `BUILD_E2E_MCP`) →
 *   throw `EscalateError("validate", …)` → `NEEDS-INPUT.md`. This was a SILENT
 *   skip before; a needed step that can't run now blocks for a human. Note the
 *   throw happens when `runValidateGate` CONSTRUCTS the args (before the
 *   deterministic checks run), so a needed-but-no-infra build fails fast at
 *   validate-entry, and can newly block at a review-round revalidation.
 * - **needed** + infra → run exactly as today.
 *
 * - **plan-once** (`ensureE2ePlan`): a bounded plan↔plan-feedback loop, no dev
 *   server, that never blocks on a human. Reuse is gated on a durable completion
 *   marker (`.build/e2e-plan-state.json`), so it runs once per build and is
 *   reused across every build↔validate revisit. The documentation artifacts
 *   (`e2e-plan.md`, `e2e-plan-review.md`) live at the build-dir root and travel
 *   with the PR; the marker stays under gitignored `.build/`.
 * - **execute-always** (`runE2eExecute`): brings up the dev server
 *   (launch-only-if-not-running) and drives the planned flows via the
 *   next-devtools browser MCP, writing `e2e-report.md`.
 *
 * Only the execute builder is scoped to the project's `next-devtools` MCP server
 * (via `--mcp-config <scoped> --strict-mcp-config`), so the autonomous browser
 * run never boots the rest of `.mcp.json` (notably the prod-PII Convex server).
 * `BUILD_E2E_MCP` overrides the config path if you need a custom one.
 *
 * Exported so the gating branches are unit-testable without spawning a harness.
 */
/**
 * Generic, feature-agnostic e2e coverage gate. When a feature commits
 * `build/<feature>/assert-e2e-coverage.ts`, run it with `bun` (cwd = repoRoot,
 * where the orchestrator runs; the checker itself resolves its artifact relative
 * to `import.meta.dir`, so it is cwd-independent) and surface its exit status to
 * the e2e gate. A non-zero exit fails the e2e validate gate exactly like any
 * other e2e failure. A feature that commits no checker is a no-op pass, so this
 * never affects other builds.
 */
export function runFeatureCoverageGate(
  buildDir: string,
  repoRoot: string,
  checkerFilename = "assert-e2e-coverage.ts",
): { ok: boolean; output: string } {
  const checker = join(buildDir, checkerFilename)
  if (!existsSync(checker)) return { ok: true, output: "" } // feature opt-in
  const res = spawnSync("bun", [checker], { cwd: repoRoot, encoding: "utf-8" })
  if (res.status === 0 && res.error == null) return { ok: true, output: "" }
  // `res.error` is set when the spawn itself failed (e.g. `bun` not on PATH);
  // surface its message so the failure reads as a spawn problem, not "exited
  // null" against a missing process.
  const detail = res.error
    ? `could not spawn bun: ${res.error.message}`
    : `${checkerFilename} exited ${res.status ?? "null"}`
  const output =
    `feature coverage gate failed (${detail}):\n` +
    `${res.stdout ?? ""}${res.stderr ?? ""}`.trim()
  return { ok: false, output }
}

/** Injectable deps for {@link makeE2eDevServerRunner} (defaults wire production). */
export type DevServerRunnerDeps = {
  buildDir: string
  devUrl: string
  /** Absolute path to `dev-server-control.ts` (the pane-run launcher target). */
  controlScriptPath: string
  readPane?: (buildDir: string) => PaneRef | null
  ensureStarted?: (deps: EnsureStartedDeps) => Promise<boolean>
  reachableImpl?: (url: string) => Promise<boolean>
}

/**
 * Build the `withDevServer` seam `runE2eExecute` consumes, as a two-context
 * dispatcher over the externalized (pane-managed) dev server:
 *
 *  - **herdr-framed** (a `dev-server-pane.json` is present): own the server —
 *    ensure it's started in the pane (warm reuse if already up), run e2e against
 *    it, and LEAVE IT WARM (no teardown; repeated build↔validate revisits reuse
 *    one server). Never reachable → `EscalateError("validate", …)` → NEEDS-INPUT.
 *  - **non-kickoff** (no pane handle): auto-detect the portless dev URL. A server
 *    already running there is used read-only; nothing reachable → block via
 *    `EscalateError("validate", …)` (PRO-576's "needed step, infra unavailable →
 *    block" rule, specialized to the dev server). Never an in-process spawn.
 *
 * The block/never-reachable → `EscalateError` translation lives here (not in
 * `dev-server-control.ts`, which must not import the orchestrator).
 */
export function makeE2eDevServerRunner(
  deps: DevServerRunnerDeps,
): <T>(run: (devUrl: string) => Promise<T>) => Promise<T> {
  const readPane = deps.readPane ?? readDevServerPane
  const ensureStarted = deps.ensureStarted ?? ensureDevServerStarted
  const reachableImpl = deps.reachableImpl ?? ((u: string) => reachable(u))
  return async <T>(run: (devUrl: string) => Promise<T>): Promise<T> => {
    const paneRef = readPane(deps.buildDir)
    if (paneRef) {
      const up = await ensureStarted({
        buildDir: deps.buildDir,
        paneRef,
        devUrl: deps.devUrl,
        controlScriptPath: deps.controlScriptPath,
      })
      if (!up)
        throw new EscalateError(
          "validate",
          `e2e: dev server never became reachable at ${deps.devUrl} — see the dev-server pane`,
        )
      return run(deps.devUrl) // leave warm; no teardown
    }
    // No pane handle: external-server detection (the non-kickoff context).
    const decision = decideExternalServer(await reachableImpl(deps.devUrl))
    if (decision.kind === "block")
      throw new EscalateError("validate", `e2e: ${decision.reason}`)
    return run(deps.devUrl) // the human's server, read-only
  }
}

export function makeE2e(ctx: Ctx, state: BuildState): RunValidateArgs["e2e"] {
  const scopedPath = join(ctx.buildDir, ".build", "e2e.mcp.json")
  const mcpConfig =
    ctx.env.BUILD_E2E_MCP ??
    writeScopedNextDevtoolsConfig(ctx.repoRoot, scopedPath) ??
    undefined
  const outcome = resolveOptionalStep({
    def: E2E_DEF,
    decision: state.optionalSteps?.e2e,
    // state-only: the legacy BUILD_SKIP_E2E=1 env is normalized into this field.
    override: resolveOverride("e2e", state.optionalStepOverrides),
    infraAvailable: mcpConfig != null,
  })
  if (outcome.state === "skipped") {
    appendLog(
      ctx.logPath,
      `validate: e2e skipped (${outcome.reason})`,
      ctx.now(),
    )
    return undefined
  }
  if (outcome.state === "blocked") {
    // Needed but no next-devtools infra → block for a human (was a SILENT skip before).
    throw new EscalateError("validate", `e2e: ${outcome.reason}`, "e2e-infra")
  }
  // outcome.state === "needed" → run exactly as today. mcpConfig is non-null here
  // (infraAvailable was true), so narrow it for the strict-MCP execute call.
  const e2eMcpConfig = mcpConfig as string

  return async () => {
    // Single authoritative dev URL: the orchestrator persisted it once at
    // startup; resolveDevUrl reads that (falling back to deriving) so the e2e
    // closure, the dashboard, and the control surface all agree.
    const devUrl = resolveDevUrl(ctx.buildDir, ctx.env)
    const planPath = join(ctx.buildDir, "e2e-plan.md")
    const reportPath = join(ctx.buildDir, "e2e-report.md")
    const screenshotsDir = join(ctx.buildDir, "screenshots")
    const statePath = join(ctx.buildDir, ".build", "e2e-plan-state.json")

    // plan-once (no dev server): bounded plan↔feedback loop, never blocks.
    await ensureE2ePlan({
      completionExists: () => existsSync(statePath),
      planExists: () => existsSync(planPath),
      runPlan: (revising) =>
        invokeBuilder(
          ctx,
          state,
          state.harnessMap.build,
          e2ePlanPrompt({
            feature: ctx.feature,
            buildDir: ctx.buildDir,
            specPath: ctx.specPath,
            revising,
          }),
          "PLAN_DONE",
        ),
      runPlanReview: () =>
        invokeReviewer(
          ctx,
          state.harnessMap["plan-review"],
          e2ePlanReviewPrompt({
            feature: ctx.feature,
            buildDir: ctx.buildDir,
            specPath: ctx.specPath,
          }),
          parsePlanReviewVerdict,
        ),
      writeFallbackPlan: (reason) =>
        writeFileSync(planPath, `${fallbackE2ePlanArtifact(reason)}\n`),
      markComplete: (s) => {
        mkdirSync(dirname(statePath), { recursive: true })
        writeFileSync(statePath, `${JSON.stringify(s, null, 2)}\n`)
      },
      log: (m) => appendLog(ctx.logPath, m, ctx.now()),
    })

    // execute-always (dev-server-guarded, strict next-devtools MCP). An e2e
    // FAIL does NOT block the run — a broken flow is a validation failure that
    // routes back to the builder via the validate gate (the failure text
    // becomes validate-failures.md input).
    return runE2eExecute({
      clearReport: () => rmSync(reportPath, { force: true }),
      readReport: () =>
        existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : null,
      // Clear any prior run's screenshots so freshness is structural (same
      // rationale as clearReport). The dir is inside build/<feature>, the exact
      // scope commitArtifacts/publishArtifacts stage, and is NOT gitignored
      // (only build/*/.build/ is) — so a captured shot is committable.
      clearScreenshots: () =>
        rmSync(screenshotsDir, { recursive: true, force: true }),
      // Clear the feature coverage artifact (same freshness rationale as
      // clearReport/clearScreenshots): the committed `e2e-artifact.json` carries
      // the values `assert-e2e-coverage.ts` validates, so a run that PASSes
      // without rewriting it must not let the gate pass against stale values.
      // `e2e-artifact.json` is the pipeline convention for the coverage artifact
      // (sibling to e2e-report.md); a feature with no checker simply has none.
      clearFeatureArtifact: () =>
        rmSync(join(ctx.buildDir, "e2e-artifact.json"), { force: true }),
      listScreenshots: () => listImageFiles(screenshotsDir),
      checkMarketingScreenshots: () =>
        validateMarketingScreenshots(defaultMarketingDeps(ctx)),
      runFeatureCoverageGate: () =>
        runFeatureCoverageGate(ctx.buildDir, ctx.repoRoot),
      withDevServer: makeE2eDevServerRunner({
        buildDir: ctx.buildDir,
        devUrl,
        controlScriptPath: join(
          ctx.repoRoot,
          "bin",
          "build",
          "dev-server-control.ts",
        ),
      }),
      runExecute: async (url) => {
        // Route through the retrying runner (PRO-639) with an e2e-specific
        // sentinel predicate. The e2e verdict is DUAL-SOURCED: a stdout
        // E2E_PASS/E2E_FAIL sentinel OR the durable e2e-report.md TERMINAL
        // verdict line (the PRO-556 fallback in runE2eExecute). The predicate
        // must honor BOTH — otherwise a completed run that wrote a valid report
        // but no stdout sentinel would be misread as "no sentinel" and trigger
        // up to SENTINEL_RETRY_CAP extra (expensive) browser executes with a
        // misleading corrective note, possibly clobbering a passing report.
        // Retry therefore fires only when NEITHER source has a verdict — exactly
        // the crashed/incomplete condition the mechanism targets.
        const hasE2eVerdict = (o: string): boolean =>
          parseE2eExecuteVerdict(o) != null ||
          (existsSync(reportPath) &&
            parseE2eReportVerdict(readFileSync(reportPath, "utf-8")) != null)
        const { output } = await invokeBuilderRawRetrying(
          ctx,
          state,
          state.harnessMap.build,
          e2eExecutePrompt({
            feature: ctx.feature,
            buildDir: ctx.buildDir,
            specPath: ctx.specPath,
            devUrl: url,
            baseBranch: ctx.baseBranch,
          }),
          hasE2eVerdict,
          { mcpConfig: e2eMcpConfig, strictMcp: true },
        )
        // A `null` return (stdout carried no sentinel even after retries) is
        // intentional: it triggers the durable e2e-report.md fallback in
        // `runE2eExecute`, which owns the "no sentinel" failure when neither
        // source has a verdict.
        return parseE2eExecuteVerdict(output)
      },
    })
  }
}

/** Injectable deps for {@link makeEvalConvexRunner} (defaults wire production). */
export type EvalConvexRunnerDeps = {
  /**
   * The Convex-dev URL to probe. Read from `apps/web/.env.local`
   * (`NEXT_PUBLIC_CONVEX_URL`) in production; `null` when it can't be resolved,
   * which is itself an infra block (evals can't run without a Convex dev URL).
   */
  convexUrl: string | null
  reachableImpl?: (url: string) => Promise<boolean>
}

/**
 * Build the `withConvex` seam `runEvalExecute` consumes: probe the Convex-dev
 * deployment and either run the closure or block for a human. We do NOT
 * auto-start Convex in v1 (a future enhancement; recordable as an eval-infra
 * observation) — faithful to "needed but infra unavailable → block for a human".
 * The block → `EscalateError` translation lives here (category `evals-infra`),
 * mirroring `makeE2eDevServerRunner`.
 */
export function makeEvalConvexRunner(
  deps: EvalConvexRunnerDeps,
): <T>(run: () => Promise<T>) => Promise<T> {
  const reachableImpl = deps.reachableImpl ?? ((u: string) => reachable(u))
  return async <T>(run: () => Promise<T>): Promise<T> => {
    if (!deps.convexUrl) {
      throw new EscalateError(
        "validate",
        "evals: could not resolve NEXT_PUBLIC_CONVEX_URL from apps/web/.env.local — start `bunx convex dev`",
        "evals-infra",
      )
    }
    const up = await reachableImpl(deps.convexUrl)
    if (!up) {
      throw new EscalateError(
        "validate",
        `evals: Convex dev not reachable at ${deps.convexUrl} — start \`bunx convex dev\``,
        "evals-infra",
      )
    }
    return run()
  }
}

/**
 * Read `NEXT_PUBLIC_CONVEX_URL` from `apps/web/.env.local` (a read-only inspect,
 * never a write — CLAUDE.md). Returns `null` when the file or the var is absent.
 */
export function readConvexUrl(repoRoot: string): string | null {
  const envPath = join(repoRoot, "apps", "web", ".env.local")
  if (!existsSync(envPath)) return null
  const raw = readFileSync(envPath, "utf-8")
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*NEXT_PUBLIC_CONVEX_URL\s*=\s*(.+)\s*$/)
    if (m) {
      // Strip surrounding quotes if present.
      return m[1].trim().replace(/^["']|["']$/g, "")
    }
  }
  return null
}

/**
 * The evals step of the validate gate: a plan → plan-feedback → execute
 * sub-pipeline (see `bin/build/evals.ts`), mirroring `makeE2e`. Whether it runs
 * is decided by the optional-step framework (plan-time declaration + human
 * override → run / skip / block), swapping e2e's browser/dev-server infra for a
 * model-API-key + Convex-dev infra.
 *
 * - **skipped** (forced off, or not needed) → `undefined` (no evals step).
 * - **blocked** (needed, but a model API key is missing) → `EscalateError`
 *   (category `evals-infra`) naming the missing key(s).
 * - **needed** + keys → the async closure. Inside it:
 *   - `ensureEvalPlan` runs the bounded plan↔feedback loop (never blocks);
 *   - R2: `readBaselineBefore(origin/<base>)` resolves the regression reference
 *     FAIL-FAST (before the paid execute run). `unreadable` → `EscalateError`
 *     (block, no paid run); `absent` → bootstrap `{}` (logged, temporary);
 *     `ok` → the committed scores;
 *   - `runEvalExecute` runs the eval subset under the Convex guard and gates it.
 *
 * The eval execute agent runs with the DEFAULT MCP config (it needs Bash + file
 * tools + Convex CLI), so — unlike e2e — we do NOT pass `strictMcp`.
 *
 * `deps` is a test seam (all optional, defaulting to production): it lets the
 * orchestrator tests drive the closure — the R2 baseline branches especially —
 * without spawning real plan/execute agents or shelling out to git.
 */
export type MakeEvalsDeps = {
  readBaselineBeforeImpl?: (baseBranch: string) => BaselineBeforeResult
  ensureEvalPlanImpl?: typeof ensureEvalPlan
  runEvalExecuteImpl?: typeof runEvalExecute
}

export function makeEvals(
  ctx: Ctx,
  state: BuildState,
  deps: MakeEvalsDeps = {},
): RunValidateArgs["evals"] {
  const readBaselineBeforeImpl =
    deps.readBaselineBeforeImpl ?? ((b: string) => readBaselineBefore(b))
  const ensureEvalPlanImpl = deps.ensureEvalPlanImpl ?? ensureEvalPlan
  const runEvalExecuteImpl = deps.runEvalExecuteImpl ?? runEvalExecute
  // Mirror evalite's env sources: the shell env PLUS `apps/web/.env[.local]`,
  // which `bunx evalite run` loads itself. Checking only `ctx.env` would falsely
  // block a normal local setup that keeps the keys in the dotenv files.
  const keys = hasEvalApiKeys(ctx.env, readEnvFileKeys(ctx.repoRoot))
  const outcome = resolveOptionalStep({
    def: EVALS_DEF,
    decision: state.optionalSteps?.evals,
    override: resolveOverride("evals", state.optionalStepOverrides),
    infraAvailable: keys.ok,
  })
  if (outcome.state === "skipped") {
    appendLog(
      ctx.logPath,
      `validate: evals skipped (${outcome.reason})`,
      ctx.now(),
    )
    return undefined
  }
  if (outcome.state === "blocked") {
    // Needed but a model API key is missing → block for a human.
    throw new EscalateError(
      "validate",
      `evals: model API keys unavailable (missing ${keys.missing.join(", ")}); set them in apps/web/.env or force evals off`,
      "evals-infra",
    )
  }

  return async () => {
    const planPath = join(ctx.buildDir, "eval-plan.md")
    const reportPath = join(ctx.buildDir, "eval-report.md")
    const runJsonPath = join(ctx.buildDir, "eval-run.json")
    const requiredCasesPath = join(ctx.buildDir, "eval-required-cases.json")
    const baselinesPath = join(
      ctx.repoRoot,
      "apps",
      "web",
      "evals",
      "baselines.json",
    )
    const markerPath = join(ctx.buildDir, ".build", "eval-plan-state.json")

    // R2 baseline resolution — FAIL-FAST, before ANY paid work (plan or execute).
    // origin/<base> is immutable to the agent, so reading it early is strictly
    // better: an unreadable ref blocks for a human at the cheapest possible point
    // (no plan agent, no execute agent, no eval run).
    const before = readBaselineBeforeImpl(ctx.baseBranch)
    let baselineBefore: EvalScores
    if (before.status === "unreadable") {
      throw new EscalateError(
        "validate",
        `evals: could not read the base branch's committed baseline (origin/${ctx.baseBranch}:apps/web/evals/baselines.json) — ${before.detail}; the regression gate has no reference, so blocking for a human rather than passing`,
        "evals-infra",
      )
    }
    if (before.status === "absent") {
      appendLog(
        ctx.logPath,
        `evals: no committed baseline on origin/${ctx.baseBranch} yet — first eval-covered build; regression gate has no prior reference. Expected only for this feature's initial landing.`,
        ctx.now(),
      )
      baselineBefore = {}
    } else {
      baselineBefore = before.scores
    }

    // plan-once (no infra): bounded plan↔feedback loop, never blocks. Snapshots
    // the reviewed required set into the marker so the gate reads an immutable
    // required set (not the mutable working-tree JSON).
    await ensureEvalPlanImpl({
      completionExists: () => existsSync(markerPath),
      planExists: () => existsSync(planPath),
      runPlan: (revising) =>
        invokeBuilder(
          ctx,
          state,
          state.harnessMap.build,
          evalPlanPrompt({
            feature: ctx.feature,
            buildDir: ctx.buildDir,
            specPath: ctx.specPath,
            baseBranch: ctx.baseBranch,
            revising,
          }),
          "PLAN_DONE",
        ),
      runPlanReview: () =>
        invokeReviewer(
          ctx,
          state.harnessMap["plan-review"],
          evalPlanReviewPrompt({
            feature: ctx.feature,
            buildDir: ctx.buildDir,
            specPath: ctx.specPath,
          }),
          parsePlanReviewVerdict,
        ),
      writeFallbackPlan: (reason) =>
        writeFileSync(
          planPath,
          `${fallbackEvalPlanArtifact(reason, ctx.baseBranch)}\n`,
        ),
      // The fallback path writes only the plan artifact, not
      // eval-required-cases.json, so this snapshot is `[]`. We deliberately read
      // the immutable marker (never the mutable working-tree JSON — that is the
      // anti-tamper property; re-snapshotting after execute would reopen the bypass
      // this design closes). An empty required snapshot no longer silently passes:
      // the coverage-contract floor in `runEvalExecute` FAILS a needed run whose
      // required set is empty AND that commits no explicit assert-eval-coverage.ts
      // checker — so a fallback build must earn coverage via that checker, rather
      // than passing on any unrelated scored case. This closes the gap where a
      // prompt change with no associated eval case could pass on the emptyRun floor.
      readRequiredCasesForSnapshot: () =>
        readRequiredCasesFile(requiredCasesPath),
      markComplete: (s) => {
        mkdirSync(dirname(markerPath), { recursive: true })
        writeFileSync(markerPath, `${JSON.stringify(s, null, 2)}\n`)
      },
      log: (m) => appendLog(ctx.logPath, m, ctx.now()),
    })

    return runEvalExecuteImpl({
      baselineBefore,
      withConvex: makeEvalConvexRunner({
        convexUrl: readConvexUrl(ctx.repoRoot),
      }),
      clearReport: () => rmSync(reportPath, { force: true }),
      readReport: () =>
        existsSync(reportPath) ? readFileSync(reportPath, "utf-8") : null,
      clearRunJson: () => rmSync(runJsonPath, { force: true }),
      readRunJson: () =>
        existsSync(runJsonPath) ? readFileSync(runJsonPath, "utf-8") : null,
      readBaselineAfter: () =>
        readBaselineFile(
          existsSync(baselinesPath)
            ? readFileSync(baselinesPath, "utf-8")
            : null,
        ),
      // Read the required set from the plan-completion MARKER (immutable to the
      // execute agent), NOT the mutable working-tree eval-required-cases.json.
      readRequiredCases: () => readRequiredCasesFromMarker(markerPath),
      // `eval-artifact.json` is the pipeline convention for the coverage artifact
      // (sibling to eval-report.md); a feature with no checker simply has none.
      clearFeatureArtifact: () =>
        rmSync(join(ctx.buildDir, "eval-artifact.json"), { force: true }),
      runFeatureCoverageGate: () =>
        runFeatureCoverageGate(
          ctx.buildDir,
          ctx.repoRoot,
          "assert-eval-coverage.ts",
        ),
      // The explicit coverage checker's PRESENCE (not just its pass) is what lets
      // an empty required-case snapshot through the coverage-contract floor.
      hasFeatureCoverageGate: () =>
        existsSync(join(ctx.buildDir, "assert-eval-coverage.ts")),
      margin: EVAL_REGRESSION_MARGIN,
      newCaseFloor: EVAL_NEW_CASE_SCORE_FLOOR,
      log: (m) => appendLog(ctx.logPath, m, ctx.now()),
      writeReportGate: (details) => {
        // Append the machine verdict table beneath the agent's prose report.
        const rows = details.cases
          .map(
            (c) =>
              `| ${c.name} | ${fmtBaselineCell(c.before)} | ${fmtBaselineCell(c.produced)} | ${fmtBaselineCell(c.after)} | ${c.verdict} |`,
          )
          .join("\n")
        const table = [
          "",
          `## Machine-checked eval gate (margin ${details.margin})`,
          "",
          "| case | baselineBefore (main) | produced | baselineAfter (this build) | verdict |",
          "| --- | --- | --- | --- | --- |",
          rows,
          "",
        ].join("\n")
        if (existsSync(reportPath)) appendFileSync(reportPath, table)
      },
      runExecute: async () => {
        // Dual-sourced verdict (stdout sentinel OR eval-report.md terminal line),
        // mirroring makeE2e — retry fires only when NEITHER source has a verdict.
        const hasEvalVerdict = (o: string): boolean =>
          parseEvalExecuteVerdict(o) != null ||
          (existsSync(reportPath) &&
            parseEvalReportVerdict(readFileSync(reportPath, "utf-8")) != null)
        const { output } = await invokeBuilderRawRetrying(
          ctx,
          state,
          state.harnessMap.build,
          evalExecutePrompt({
            feature: ctx.feature,
            buildDir: ctx.buildDir,
            specPath: ctx.specPath,
            baseBranch: ctx.baseBranch,
          }),
          hasEvalVerdict,
          // DEFAULT MCP — the eval agent needs Bash + file tools + Convex CLI.
        )
        return parseEvalExecuteVerdict(output)
      },
    })
  }
}

/** Format a nullable baseline/score cell for the machine verdict table. */
function fmtBaselineCell(n: number | null): string {
  return n === null ? "—" : n.toFixed(3)
}

/** Read the working-tree `eval-required-cases.json` (for the plan-time snapshot). */
function readRequiredCasesFile(path: string): string[] {
  return readRequiredCases(
    existsSync(path) ? readFileSync(path, "utf-8") : null,
  )
}

/**
 * Read the plan-reviewed required patterns from the completion MARKER
 * (`.build/eval-plan-state.json` → `EvalPlanState.requiredCases`). This is the
 * gate's source of truth for coverage — immutable to the execute agent, unlike
 * the working-tree JSON. Returns `[]` when the marker is absent/unparseable.
 */
function readRequiredCasesFromMarker(markerPath: string): string[] {
  if (!existsSync(markerPath)) return []
  try {
    const parsed = JSON.parse(
      readFileSync(markerPath, "utf-8"),
    ) as Partial<EvalPlanState>
    return Array.isArray(parsed.requiredCases) ? parsed.requiredCases : []
  } catch {
    return []
  }
}

/**
 * Production wiring for the ensure-ticket step (mirrors `kickoff.ts`'s
 * `defaultDeps`). Spawns `claude` with **non-strict** MCP so the Linear server
 * from `.mcp.json` is available (same as the kickoff loop's select step — we do
 * NOT pass the scoped next-devtools config here). Logs warnings to `build.log`.
 */
export function defaultEnsureDeps(
  ctx: Ctx,
  runHarnessFn: typeof runHarness = runHarness,
): EnsureTicketDeps {
  return {
    runEnsureAgent: async ({ prompt, resultPath }) => {
      mkdirSync(dirname(resultPath), { recursive: true })
      // Clear any stale result so a crash before the agent writes can't surface
      // an old id (mirrors the kickoff loop's select-result handling).
      rmSync(resultPath, { force: true })
      const argv = builderArgs({ bin: "claude", model: "opus" }, prompt)
      const { code } = await runHarnessFn({
        bin: "claude",
        argv,
        cwd: ctx.repoRoot,
        logPath: ctx.logPath,
      })
      return {
        code: code ?? 1,
        resultRaw: existsSync(resultPath)
          ? readFileSync(resultPath, "utf-8")
          : null,
      }
    },
    log: (message) => appendLog(ctx.logPath, message, ctx.now()),
  }
}

/**
 * Production wiring for the In-Review move step (mirrors `defaultEnsureDeps`).
 * Spawns `claude` with **non-strict** MCP so the Linear server from `.mcp.json`
 * is available, reads the agent's result file back, and logs to `build.log`.
 */
export function defaultStatusDeps(
  ctx: Ctx,
  runHarnessFn: typeof runHarness = runHarness,
): InReviewDeps {
  return {
    runStatusAgent: async ({ prompt, resultPath }) => {
      mkdirSync(dirname(resultPath), { recursive: true })
      // Clear any stale result so a crash before the agent writes can't surface
      // an old verdict (mirrors defaultEnsureDeps).
      rmSync(resultPath, { force: true })
      const argv = builderArgs({ bin: "claude", model: "opus" }, prompt)
      const { code } = await runHarnessFn({
        bin: "claude",
        argv,
        cwd: ctx.repoRoot,
        logPath: ctx.logPath,
      })
      return {
        code: code ?? 1,
        resultRaw: existsSync(resultPath)
          ? readFileSync(resultPath, "utf-8")
          : null,
      }
    },
    log: (message) => appendLog(ctx.logPath, message, ctx.now()),
  }
}

/** Milliseconds from the build's analytics `startedAt` to `nowIso`. 0 if unknown. */
function durationSinceStartMs(state: BuildState, nowIso: string): number {
  const startedAt = state.analytics?.startedAt
  if (!startedAt) return 0
  const ms = Date.parse(nowIso) - Date.parse(startedAt)
  return Number.isNaN(ms) || ms < 0 ? 0 : ms
}

async function runValidateGate(
  ctx: Ctx,
  state: BuildState,
  attempt: number,
): Promise<boolean> {
  const result = await runValidate({
    repoRoot: ctx.repoRoot,
    logPath: ctx.logPath,
    e2e: makeE2e(ctx, state),
    evals: makeEvals(ctx, state),
  })
  // One analytics event per check, carrying the attempt number.
  for (const r of result.results) {
    ctx.analytics.capture("build_validate_result", {
      check: r.name,
      passed: r.ok,
      attempt,
    })
  }
  // Record e2e/evals need/pass from the CheckResult presence/ok for build_completed.
  const e2eResult = result.results.find((r) => r.name === "e2e")
  const evalsResult = result.results.find((r) => r.name === "evals")
  if (state.analytics) {
    state.analytics = {
      ...state.analytics,
      e2eNeeded: e2eResult != null,
      ...(e2eResult != null ? { e2ePassed: e2eResult.ok } : {}),
      evalsNeeded: evalsResult != null,
      ...(evalsResult != null ? { evalsPassed: evalsResult.ok } : {}),
    }
  }
  const failures = validateFailuresPath(ctx.buildDir)
  if (result.pass) {
    rmSync(failures, { force: true })
    return true
  }
  writeFileSync(failures, `${result.failureText}\n`)
  return false
}

// --- phase handlers ---------------------------------------------------------

/** One-line summary of a declaration for the build.log breadcrumb, e.g. `e2e=needed`. */
function summarizeDecl(decl: OptionalStepsDeclaration): string {
  const parts = Object.entries(decl).map(
    ([id, d]) => `${id}=${d?.needed ? "needed" : "not-needed"}`,
  )
  return parts.length ? parts.join(", ") : "no decisions"
}

/**
 * Read + persist the plan agent's optional-steps declaration into state. Exported
 * for test. Missing/unparseable ⇒ `state.optionalSteps` left undefined ⇒ fail-safe
 * "run all". Mutates + persists `state` (mirrors reviewPhase's mutate-then-writeState),
 * so the declaration survives even if planPhase later throws.
 */
export function recordOptionalStepsDeclaration(
  ctx: Ctx,
  state: BuildState,
): void {
  const declPath = join(ctx.buildDir, OPTIONAL_STEPS_FILENAME)
  const decl = parseOptionalStepsDeclaration(
    existsSync(declPath) ? readFileSync(declPath, "utf-8") : null,
  )
  state.optionalSteps = decl ?? undefined
  writeState(ctx.repoRoot, state, ctx.now())
  appendLog(
    ctx.logPath,
    decl
      ? `plan: optional-steps declaration recorded (${summarizeDecl(decl)})`
      : "plan: no parseable optional-steps.json — defaulting all optional steps to needed",
    ctx.now(),
  )
}

async function planPhase(
  ctx: Ctx,
  state: BuildState,
): Promise<TransitionSignal> {
  // Clear-first (refresh): on a NEEDS_REVISION re-plan, if the agent rewrites
  // plan.md but forgets to rewrite optional-steps.json, the absent file fails
  // safe to "run all" — it can never silently re-persist the stale declaration.
  rmSync(join(ctx.buildDir, OPTIONAL_STEPS_FILENAME), { force: true })
  const revising = existsSync(join(ctx.buildDir, "plan-review.md"))
  const prompt = planPrompt({
    feature: ctx.feature,
    buildDir: ctx.buildDir,
    specPath: ctx.specPath,
    revising,
  })
  const verdict = await invokeBuilder(
    ctx,
    state,
    state.harnessMap.plan,
    prompt,
    "PLAN_DONE",
  )
  if (verdict.kind !== "escalate") recordOptionalStepsDeclaration(ctx, state)
  return { phase: "plan", verdict }
}

async function planReviewPhase(
  ctx: Ctx,
  state: BuildState,
): Promise<TransitionSignal> {
  const prompt = planReviewPrompt({
    feature: ctx.feature,
    buildDir: ctx.buildDir,
    specPath: ctx.specPath,
  })
  const verdict = await invokeReviewer(
    ctx,
    state.harnessMap["plan-review"],
    prompt,
    parsePlanReviewVerdict,
  )
  return {
    phase: "plan-review",
    verdict: verdict ?? {
      kind: "escalate",
      reason:
        "plan-review produced no APPROVED/NEEDS_REVISION/ESCALATE verdict",
    },
  }
}

async function buildPhase(
  ctx: Ctx,
  state: BuildState,
): Promise<TransitionSignal> {
  const failures = validateFailuresPath(ctx.buildDir)
  const prompt = buildPrompt({
    feature: ctx.feature,
    buildDir: ctx.buildDir,
    specPath: ctx.specPath,
    validateFailuresPath: existsSync(failures) ? failures : undefined,
  })
  const verdict = await invokeBuilder(
    ctx,
    state,
    state.harnessMap.build,
    prompt,
    "BUILD_DONE",
  )
  return { phase: "build", verdict }
}

async function validatePhase(
  ctx: Ctx,
  state: BuildState,
): Promise<TransitionSignal> {
  // The standalone validate phase is re-entered fresh on every build→validate
  // loop, so it has no local counter — derive `attempt` from the persisted
  // re-entry count (build_validate_result.attempt would otherwise always be 0).
  const attempt = state.analytics?.validateReentries ?? 0
  return { phase: "validate", pass: await runValidateGate(ctx, state, attempt) }
}

async function reviewPhase(
  ctx: Ctx,
  state: BuildState,
): Promise<TransitionSignal> {
  if (state.reviewRound === 0) {
    state.reviewRound = 1
    writeState(ctx.repoRoot, state, ctx.now())
  }
  const round = state.reviewRound
  mkdirSync(join(ctx.buildDir, "review"), { recursive: true })
  const roundStartedAt = Date.now()

  const roundFile = join(ctx.buildDir, "review", `round-${round}.md`)
  const roundVerdict = () =>
    existsSync(roundFile)
      ? parseCodeReviewVerdict(readFileSync(roundFile, "utf-8"))
      : null

  // Resumability: if this round's findings file already exists with a verdict,
  // the reviewer already ran — recover the verdict from disk instead of
  // re-invoking (which would overwrite any in-file builder responses).
  let verdict = roundVerdict()
  if (!verdict) {
    const fromMessage = await invokeReviewer(
      ctx,
      state.harnessMap.review,
      reviewPrompt({
        feature: ctx.feature,
        buildDir: ctx.buildDir,
        specPath: ctx.specPath,
        round,
        baseBranch: ctx.baseBranch,
      }),
      parseCodeReviewVerdict,
    )
    // Prefer the bare sentinel the reviewer just wrote to the round file over
    // its chat-message phrasing (see chooseReviewVerdict).
    verdict = chooseReviewVerdict(roundVerdict(), fromMessage, round)
  }

  // A review round closes once its verdict is resolved (clean/blocking/escalate).
  ctx.analytics.capture("build_review_round", {
    round,
    verdict: phaseVerdictLabel({ phase: "review", verdict }),
    finding_count: countReviewFindingsAt(roundFile),
    duration_ms: Date.now() - roundStartedAt,
  })

  if (verdict.kind !== "blocking") return { phase: "review", verdict }

  // Blocking: the builder responds in-file, then the validate gate re-runs.
  const response = await invokeBuilder(
    ctx,
    state,
    state.harnessMap.build,
    reviewResponsePrompt({
      feature: ctx.feature,
      buildDir: ctx.buildDir,
      round,
    }),
    "BUILD_DONE",
  )
  if (response.kind === "escalate") {
    return {
      phase: "review",
      verdict: { kind: "escalate", reason: response.reason },
    }
  }

  let attempt = 0
  while (!(await runValidateGate(ctx, state, attempt))) {
    attempt++
    // Persist the revalidation-attempt count for build_completed. Mutate
    // state.analytics IN PLACE (mirrors how reviewPhase mutates state.reviewRound)
    // so the orchestrator's `...state` spread picks it up — a reassignment would
    // not propagate back to the caller's `state` reference.
    if (state.analytics) {
      state.analytics = {
        ...state.analytics,
        revalidateAttempts: state.analytics.revalidateAttempts + 1,
      }
      writeState(ctx.repoRoot, state, ctx.now())
    }
    if (attempt >= SOFT_BUDGET)
      softBudgetWarning(ctx, `review round ${round} revalidation`, attempt)
    if (attempt >= REVALIDATE_CAP) {
      return {
        phase: "review",
        verdict: {
          kind: "escalate",
          reason: `validation still failing after ${attempt} fix attempts in review round ${round} — not converging`,
        },
      }
    }
    const fix = await invokeBuilder(
      ctx,
      state,
      state.harnessMap.build,
      buildPhasePrompt(ctx),
      "BUILD_DONE",
    )
    if (fix.kind === "escalate") {
      return {
        phase: "review",
        verdict: { kind: "escalate", reason: fix.reason },
      }
    }
  }
  return { phase: "review", verdict: { kind: "blocking" } }
}

function buildPhasePrompt(ctx: Ctx): string {
  const failures = validateFailuresPath(ctx.buildDir)
  return buildPrompt({
    feature: ctx.feature,
    buildDir: ctx.buildDir,
    specPath: ctx.specPath,
    validateFailuresPath: existsSync(failures) ? failures : undefined,
  })
}

/**
 * Builder invoker seam, injectable so `prPhase` can be unit-tested without
 * spawning a real harness subprocess. Defaults to the module's `invokeBuilder`.
 */
export type PrPhaseInvoke = (
  ctx: Ctx,
  harness: HarnessEntry,
  prompt: string,
  doneToken: "PLAN_DONE" | "BUILD_DONE",
) => Promise<BuilderVerdict>

/**
 * Production wiring for the PR-body screenshot embed step. PUBLISHES the build
 * record to the PR branch first, then resolves repo/sha/body via `gh`/`git`
 * so the deterministic embed can write SHA-pinned blob-view links. Reuses
 * existing repo helpers; injectable in `prPhase` so the embed is unit-testable
 * without git/gh.
 *
 * Durability: links point at the GitHub blob view pinned to the published commit
 * SHA. Because the repo is private, inline raw images don't render; click-through
 * blob links resolve in GitHub's authenticated UI. The SHA survives squash-merge
 * branch deletion via refs/pull/<n>/head, so links keep resolving after merge.
 */
export function defaultEmbedDeps(ctx: Ctx): EmbedScreenshotDeps {
  return {
    publish: () => publishArtifacts(ctx.repoRoot, ctx.feature),
    listScreenshots: () => listImageFiles(join(ctx.buildDir, "screenshots")),
    nameWithOwner: () => {
      const r = sh(
        [
          "gh",
          "repo",
          "view",
          "--json",
          "nameWithOwner",
          "-q",
          ".nameWithOwner",
        ],
        ctx.repoRoot,
      )
      const v = r.stdout.trim()
      return r.code === 0 && v !== "" ? v : null
    },
    // Read AFTER publish(); the commit that actually contains the published
    // screenshots, and re-read on each PR-phase run so the latest commit is pinned.
    headSha: () => {
      const s = detectHeadSha(ctx.repoRoot)
      return s === "" ? null : s
    },
    prBody: () => {
      const r = sh(
        ["gh", "pr", "view", "--json", "body", "-q", ".body"],
        ctx.repoRoot,
      )
      return r.code === 0 ? r.stdout : null
    },
    editPrBody: (body) => {
      const r = sh(["gh", "pr", "edit", "--body", body], ctx.repoRoot)
      return r.code === 0
    },
    log: (m) => appendLog(ctx.logPath, m, ctx.now()),
  }
}

/**
 * PR phase: reads the spec for `<!-- sentry-fixes: <SHORT-ID> -->` markers and
 * threads the short-ids into `prPrompt`, so the PR carries `fixes <SHORT-ID>`
 * (in a branch commit) and Sentry auto-resolves the issue once the fix ships.
 *
 * After `/pr open` succeeds (non-escalate verdict), embeds the committed
 * verification screenshots into the PR body as a DETERMINISTIC post-step:
 * publishes build/<feature> to the branch first, then upserts a SHA-pinned
 * blob-link block — re-applied on every PR-phase run so it survives `/pr`
 * regenerating the body.
 */
export async function prPhase(
  ctx: Ctx,
  state: BuildState,
  // The seam signature stays state-free so existing injected-invoke tests remain
  // valid; the production default binds `state` here (a later param default may
  // reference the earlier `state` param) so the PR builder gets sentinel retry.
  invoke: PrPhaseInvoke = (c, h, p, d) => invokeBuilder(c, state, h, p, d),
  embed: EmbedScreenshotDeps = defaultEmbedDeps(ctx),
): Promise<TransitionSignal> {
  const specContents = existsSync(ctx.specPath)
    ? readFileSync(ctx.specPath, "utf-8")
    : ""
  const sentryShortIds = extractSentryFixes(specContents)
  const verdict = await invoke(
    ctx,
    state.harnessMap.pr,
    prPrompt(ctx.feature, state.linearIssueId, sentryShortIds),
    "BUILD_DONE",
  )
  // On escalate there is no PR to embed into — skip. Otherwise publish-then-embed
  // the screenshots (the deps enforce publish-before-URL ordering internally).
  // A `failed` result means screenshots EXIST but couldn't be published/embedded;
  // since the state machine advances to monitor next (no guaranteed PR-phase
  // retry), escalate so the PR never ships without the required verification
  // block on a transient git/gh failure.
  if (verdict.kind !== "escalate") {
    const embedResult = embedScreenshotsInPrBody(ctx.feature, embed)
    if (embedResult.status === "failed") {
      throw new EscalateError(
        "pr",
        `verification screenshots could not be embedded in the PR body: ${embedResult.reason}`,
      )
    }
  }
  return { phase: "pr", verdict }
}

/**
 * Injectable IO for {@link monitorPhase}, so the In-Review move ordering and the
 * monitor poll loop are integration-testable without `gh`/`git`, the Linear MCP
 * subprocess, or an unbounded poll loop (mirrors {@link CleanupDeps} /
 * {@link defaultStatusDeps}). The seam is deliberately scoped to the
 * subprocess/network boundaries: pure-fs work (`writeState`) stays real.
 *
 * - `detectPrNumber`/`detectPrUrl` keep `gh` out of tests; `detectPrNumber`
 *   returning `null` is also the no-PR escalation path.
 * - `linear` carries the configured state ids gating the In-Review move (real:
 *   `loadConfig(...).linear`), injected so the gate inputs are explicit.
 * - `statusDeps` is the fake Linear MCP agent under test (real:
 *   `defaultStatusDeps(ctx)`), whose `log` writes the real `build.log`.
 * - `runMonitor` drives the otherwise-unbounded PR-poll loop (real:
 *   `monitorPr`), injected so a test can terminate it after one pass.
 */
export type MonitorDeps = {
  /** Resolve the PR number for the branch (real: detectPrNumber via gh). */
  detectPrNumber: (repoRoot: string) => number | null
  /** Resolve the PR URL (real: detectPrUrl via gh). */
  detectPrUrl: (repoRoot: string, prNumber: number) => string | null
  /** CONFIGURED Linear state ids for the In-Review move gate. */
  linear: LinearConfig
  /** The In-Review move deps — the fake Linear MCP agent in tests. */
  statusDeps: InReviewDeps
  /** Drive the PR-poll loop (real: monitorPr). Injected so tests terminate it. */
  runMonitor: (args: MonitorPrArgs) => Promise<MonitorResult>
  /**
   * Re-read the live PR state after a failed monitor rebase to distinguish a
   * merged-mid-flight recovery from a genuine conflict (real: fetchPrState via
   * gh). Returns the raw state string ("OPEN"/"MERGED"/"CLOSED"/"UNKNOWN").
   */
  fetchPrState: (repoRoot: string, prNumber: number) => string
  /**
   * Apply an armed pre-PR auto-merge intent to the new PR (PRO-660). Best-effort
   * + idempotent: a no-op when nothing is armed; a rejected enable keeps the
   * intent armed for the next poll pass AND records a panel-visible apply-error
   * notice. (real: applyPendingAutoMerge via defaultPendingApplyDeps)
   */
  applyPendingAutoMerge: (prNumber: number) => void
  /**
   * Reconcile the branch with its base (merge origin/<base> in + plain push) when
   * the branch is behind (real: reconcileWithBase via git). Injected so the
   * monitor-phase test can assert the exact git command sequence with a capturing
   * exec, and so the PRO-588 recovery can be driven deterministically.
   */
  reconcileWithBase: (
    repoRoot: string,
    baseBranch: string,
    feature: string,
  ) => ShResult
}

/**
 * Production wiring for {@link monitorPhase}: binds the SAME functions the phase
 * body used inline (`detectPrNumber`/`detectPrUrl`/`monitorPr`, the configured
 * `linear` from `loadConfig`, and `defaultStatusDeps`). The default-deps contract
 * is behavior-preserving — `run()` passes no deps, so production behavior is
 * unchanged by the seam.
 */
export function defaultMonitorDeps(ctx: Ctx): MonitorDeps {
  return {
    detectPrNumber,
    detectPrUrl,
    linear: loadConfig(ctx.repoRoot, ctx.env).linear,
    statusDeps: defaultStatusDeps(ctx),
    runMonitor: monitorPr,
    fetchPrState: (repoRoot, prNumber) => fetchPrState(repoRoot, prNumber),
    applyPendingAutoMerge: (prNumber) =>
      applyPendingAutoMerge(defaultPendingApplyDeps(ctx, prNumber)),
    reconcileWithBase: (repoRoot, baseBranch, feature) =>
      reconcileWithBase(repoRoot, baseBranch, feature),
  }
}

/**
 * Production wiring for the PRO-660 build-side auto-merge applier. Lives here (not
 * in `auto-merge.ts`) so the pure applier + marker/apply-error helpers never
 * import `Ctx` from `orchestrator.ts` (a cycle). Binds the real `gh`/fs/log IO.
 *
 * `Date.now()` (real epoch ms) is used only in this untested production wiring —
 * `ctx.now()` returns a string log stamp, not epoch ms, so it can't feed `atMs`.
 * The pure applier is tested with injected spy deps that never touch `Date.now`.
 */
export function defaultPendingApplyDeps(
  ctx: Ctx,
  prNumber: number,
): PendingApplyDeps {
  return {
    readPending: () => readPendingIntent(ctx.buildDir),
    clearPending: () => writePendingIntent(ctx.buildDir, false),
    enable: () => sh(autoMergeEnableCommand(prNumber), ctx.repoRoot),
    confirmState: (): AutoMergeState => {
      const r = sh(autoMergeReadCommand(prNumber), ctx.repoRoot)
      if (r.code !== 0) return "unknown"
      try {
        return parseAutoMergeState(JSON.parse(r.stdout))
      } catch {
        return "unknown"
      }
    },
    // Best-effort: a failure to persist the panel notice must never break the
    // retry loop, so both file writes are swallowed.
    recordApplyError: (detail) => {
      try {
        writeApplyError(ctx.buildDir, detail, Date.now())
      } catch {}
    },
    clearApplyError: () => {
      try {
        clearApplyError(ctx.buildDir)
      } catch {}
    },
    log: (m) => appendLog(ctx.logPath, m, ctx.now()),
  }
}

/**
 * Monitor phase: detect the PR, persist its identity, forward-only advance the
 * Linear ticket to In Review (best-effort), then run the PR-poll loop until the
 * PR is merged/closed by a human.
 *
 * `deps` is injectable ({@link MonitorDeps}) so the status-mutation ordering and
 * the poll loop are integration-testable in-process; defaults
 * ({@link defaultMonitorDeps}) wire the real `gh`/`git`/MCP IO, so production
 * behavior is unchanged.
 */
export async function monitorPhase(
  ctx: Ctx,
  state: BuildState,
  deps: MonitorDeps = defaultMonitorDeps(ctx),
): Promise<TransitionSignal> {
  const prNumber = deps.detectPrNumber(ctx.repoRoot)
  if (prNumber === null) {
    throw new EscalateError(
      "monitor",
      "no PR found for the branch — the pr phase did not open one",
    )
  }
  // First-time-only: the PR number is first known here (the pr phase opens the
  // PR via the agent but doesn't capture the number). Stamp prOpenedAt + emit
  // build_pr_opened exactly once, guarded on the PR number being previously unset.
  const firstSeenPr = state.prNumber == null
  // Persist PR identity so the read-only dashboard can surface a prominent link
  // (the panel never shells out). Mutate-then-writeState mirrors reviewPhase.
  state.prNumber = prNumber
  const prUrl = deps.detectPrUrl(ctx.repoRoot, prNumber)
  if (prUrl) state.prUrl = prUrl
  if (firstSeenPr) {
    const openedAt = ctx.now()
    if (state.analytics)
      state.analytics = { ...state.analytics, prOpenedAt: openedAt }
    ctx.analytics.capture("build_pr_opened", {
      pr_number: prNumber,
      duration_since_start_ms: durationSinceStartMs(state, openedAt),
    })
  }
  let monitorPasses = 0
  writeState(ctx.repoRoot, state, ctx.now())
  // PR confirmed → forward-only advance the ticket to In Review (best-effort).
  // Runs AFTER PR detection (so a no-PR pr phase escalates first and the board
  // never drifts to "In Review" with no PR) and BEFORE monitorPr begins polling
  // (so the board reflects "in review" at the very start of polling). Never
  // throws, so the monitor loop below runs exactly as it does today. `deps.linear`
  // (default: `loadConfig(...).linear`, not `validateConfig`): an unpinned
  // checkout warn-skips and keeps monitoring.
  await advanceTicketToInReview(
    {
      buildDir: ctx.buildDir,
      feature: ctx.feature,
      linear: deps.linear,
      state,
    },
    deps.statusDeps,
  )
  // PRO-660: the PR now exists → apply an armed pre-PR auto-merge intent.
  // Best-effort + honest (logs + records a panel notice, never throws); a
  // rejected enable stays armed and is retried on every poll pass below until
  // GitHub accepts it or the user disarms. Runs deterministically in the phase
  // body (not dependent on runMonitor calling poll) for the first attempt.
  deps.applyPendingAutoMerge(prNumber)
  const result = await deps.runMonitor({
    poll: async () => {
      monitorPasses++
      // Retry the armed intent until accepted/disarmed; keeps the apply-error
      // file's `atMs` fresh while a failure persists. No-ops (one fs read + a
      // force-remove of any stale error file) once the marker is gone.
      deps.applyPendingAutoMerge(prNumber)
      return fetchPrSnapshot(ctx.repoRoot, prNumber, ctx.baseBranch)
    },
    idleIntervalMs: IDLE_POLL_MS,
    // Publish the complete build record onto the still-open PR branch BEFORE
    // announcing ready. Returns the repo PublishResult verbatim (PublishOutcome
    // is the identical discriminated union). No build.log line is written here:
    // writing one would re-dirty the tree and make the next publish push again,
    // never reaching "clean". A "failed" keeps the loop active and retries on the
    // next ready pass; a persistent failure is bounded by maxPublishFailures and
    // surfaces as a `gave-up` escalation below.
    publishArtifacts: () => {
      const r = publishArtifacts(ctx.repoRoot, ctx.feature)
      ctx.analytics.capture("build_monitor_action", {
        action: "publish",
        success: r.status !== "failed",
      })
      if (r.status === "failed")
        process.stderr.write(
          `build: artifact publish failed (${r.detail}); will retry next poll\n`,
        )
      return r
    },
    // Notification only. Deliberately does NOT appendLog(ctx.logPath, …): writing
    // to the tracked build.log here would re-dirty the verified-green head right
    // after publishArtifacts() returned "clean", so the next idle poll would
    // re-publish + rerun CI with nothing changed on main (infinite churn). stdout
    // is a separate sink from build.log (see softBudgetWarning), so the bell and
    // status line are safe. The human also sees the green PR on GitHub.
    onReady: () => notifyPrReady(),
    act: async (action) => {
      // A thrown EscalateError propagates out of monitorPr → the main loop,
      // parking the run in `blocked` rather than spinning the poll forever.
      if (action.kind === "rebase") {
        // The action kind is historically named "rebase"; it now reconciles the
        // branch with its base via `git merge` + plain push (see reconcileWithBase).
        appendLog(
          ctx.logPath,
          "monitor: reconciling base into branch (merge)",
          ctx.now(),
        )
        const reconcileResult = deps.reconcileWithBase(
          ctx.repoRoot,
          ctx.baseBranch,
          ctx.feature,
        )
        if (reconcileResult.code !== 0) {
          // A squash merge landing mid-flight makes the branch read
          // behind/diverged and the merge conflict, but the work has actually
          // shipped. Re-read the PR's CURRENT state before treating this as a
          // human blocker: if it is now terminal, the reconcile was
          // doomed-but-irrelevant — recover and let the next poll exit `done`.
          // reconcileWithBase already ran `git merge --abort`, so the tree is
          // clean. A non-terminal/UNKNOWN read falls through to escalate
          // (fail-safe: a genuine conflict on an open PR still needs a human).
          const currentState = deps.fetchPrState(ctx.repoRoot, prNumber)
          if (currentState === "MERGED" || currentState === "CLOSED") {
            appendLog(
              ctx.logPath,
              `monitor: reconcile conflicted but PR is ${currentState} — recovering (no human needed)`,
              ctx.now(),
            )
            ctx.analytics.capture("build_monitor_action", {
              // Historical analytics value — the action now merges (see above).
              action: "rebase",
              success: true,
            })
            return // swallow: next poll sees terminal state → monitorPr returns done
          }
          // reconcileWithBase may fail at the pre-reconcile artifact commit OR the
          // merge itself; the stderr disambiguates which, so the label stays
          // generic ("rebase step") rather than asserting a conflict. Capture the
          // failed intervention before escalating — a reconcile that needs a human
          // is exactly the escalation point analytics must see. The raw failure
          // reason stays out of the payload; the EscalateError carries it.
          ctx.analytics.capture("build_monitor_action", {
            action: "rebase",
            success: false,
          })
          throw new EscalateError(
            "monitor",
            `rebase step failed (needs a human): ${reconcileResult.stderr.trim() || "see git output"}`,
            "rebase-conflict",
          )
        }
        ctx.analytics.capture("build_monitor_action", {
          action: "rebase",
          success: true,
        })
      } else if (action.kind === "fix-ci") {
        appendLog(
          ctx.logPath,
          `monitor: fixing CI (${action.failingChecks.join(", ")})`,
          ctx.now(),
        )
        const verdict = await invokeBuilder(
          ctx,
          state,
          state.harnessMap.build,
          monitorCiFixPrompt(ctx.feature, action.failingChecks),
          "BUILD_DONE",
        )
        if (verdict.kind === "escalate") {
          // Failed CI-fix intervention — capture before escalating so the
          // analytics see the escalation, not just successful fixes. The raw
          // reason rides on the EscalateError, not the payload.
          ctx.analytics.capture("build_monitor_action", {
            action: "fix-ci",
            success: false,
          })
          throw new EscalateError("monitor", verdict.reason, "ci-fix-escalate")
        }
        ctx.analytics.capture("build_monitor_action", {
          action: "fix-ci",
          success: true,
        })
      } else if (action.kind === "address-review") {
        appendLog(ctx.logPath, "monitor: addressing review threads", ctx.now())
        const verdict = await invokeBuilder(
          ctx,
          state,
          state.harnessMap.build,
          monitorAddressReviewPrompt(ctx.feature, prNumber),
          "BUILD_DONE",
        )
        if (verdict.kind === "escalate") {
          // Failed review-thread intervention — capture before escalating so the
          // analytics see the escalation, not just successful resolutions. The
          // raw reason rides on the EscalateError, not the payload.
          ctx.analytics.capture("build_monitor_action", {
            action: "address-review",
            success: false,
          })
          throw new EscalateError("monitor", verdict.reason, "review-escalate")
        }
        ctx.analytics.capture("build_monitor_action", {
          action: "address-review",
          success: true,
        })
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    onSoftBudget: (passes) => softBudgetWarning(ctx, "PR monitoring", passes),
    softBudgetPasses: SOFT_BUDGET,
  })
  // Fold the in-memory poll count into the persisted counter (in place, so the
  // orchestrator's `...state` spread picks it up). On a mid-monitor crash+resume
  // this under-counts — acceptable under the best-effort mandate.
  if (state.analytics) {
    state.analytics = {
      ...state.analytics,
      monitorPasses: state.analytics.monitorPasses + monitorPasses,
    }
  }
  if (result.outcome === "gave-up") {
    // The loop exhausted its backstop without reaching a mergeable state —
    // escalate rather than falsely marking the whole build done.
    throw new EscalateError("monitor", result.reason)
  }
  appendLog(ctx.logPath, `monitor: ${result.reason}`, ctx.now())
  return { phase: "monitor", done: true, merged: result.merged }
}

/** Frame-render pause before destructive teardown: > the dashboard's ~1s poll. */
const CLEANUP_FRAME_MS = 1_500

/**
 * Injectable IO for {@link cleanupPhase}, so every routing branch is unit-
 * testable without real `git`/`gh`/`herdr` (mirrors `defaultStatusDeps`).
 */
export type CleanupDeps = {
  isPrMerged: (repoRoot: string, prNumber: number) => boolean
  worktreeListPorcelain: (repoRoot: string) => string
  herdrWorkspaceListRaw: (cwd: string) => string
  removeWorktree: (fromMain: string, worktreePath: string) => ShResult
  forceRemoveWorktreeDir: (fromMain: string, worktreePath: string) => ShResult
  closeHerdrWorkspace: (cwd: string, workspaceId: string) => ShResult
  log: (line: string) => void
  stderr: (s: string) => void
  sleep: (ms: number) => Promise<void>
  exit: () => never
}

function defaultCleanupDeps(ctx: Ctx): CleanupDeps {
  return {
    isPrMerged: (repoRoot, prNumber) => isPrMerged(repoRoot, prNumber),
    worktreeListPorcelain: (repoRoot) => worktreeListPorcelain(repoRoot),
    herdrWorkspaceListRaw: (cwd) => herdrWorkspaceListRaw(cwd),
    removeWorktree: (fromMain, worktreePath) =>
      removeWorktree(fromMain, worktreePath),
    forceRemoveWorktreeDir: (fromMain, worktreePath) =>
      forceRemoveWorktreeDir(fromMain, worktreePath),
    closeHerdrWorkspace: (cwd, workspaceId) =>
      closeHerdrWorkspace(cwd, workspaceId),
    log: (line) => appendLog(ctx.logPath, line, ctx.now()),
    stderr: (s) => process.stderr.write(s),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    exit: () => process.exit(0),
  }
}

/**
 * Post-merge teardown: remove this build's git worktree and close its framing
 * herdr workspace. Best-effort, idempotent, and a complete no-op for any build
 * not running inside a herdr-framed kickoff worktree.
 *
 * Write-after-delete is the subtle correctness point: once the gate passes the
 * close is attempted and the build dir is (typically) GONE, so the handler must
 * NEVER return to the main loop (whose `writeState`/`commitArtifacts` would
 * recreate a stray dir under the removed path and corrupt git's worktree
 * bookkeeping). Only the pre-gate no-op paths return a `done` signal; once the
 * gate passes we always `deps.exit()` — even when the worktree couldn't be fully
 * removed (the spec prioritizes a prompt close over preserving local artifacts).
 */
export async function cleanupPhase(
  ctx: Ctx,
  state: BuildState,
  deps: CleanupDeps = defaultCleanupDeps(ctx),
): Promise<TransitionSignal> {
  // 1. Idempotent re-check — only ever tear down a genuinely-merged PR.
  if (
    state.prNumber == null ||
    !deps.isPrMerged(ctx.repoRoot, state.prNumber)
  ) {
    deps.log("cleanup: PR not merged / no PR — nothing to tear down")
    return { phase: "cleanup", done: true }
  }
  // 2. Gate + teardown via the shared helper: it only ever tears down an
  //    in-scope kickoff worktree framed by an unambiguous matching herdr
  //    workspace. A headless kickoff worktree (no workspace) is intentionally
  //    left intact — the path alone doesn't prove the build is herdr-framed
  //    (the herdr provider falls back to a headless build on many paths). The
  //    `onBeforeRemove` hook reproduces the "merged — cleaning up" frame + the
  //    dashboard's poll pause, run only after the gate passes.
  const outcome = await teardownWorkspace({
    targetPath: ctx.repoRoot,
    slug: ctx.feature,
    io: {
      worktreeListPorcelain: deps.worktreeListPorcelain,
      herdrWorkspaceListRaw: deps.herdrWorkspaceListRaw,
      removeWorktree: deps.removeWorktree,
      forceRemoveWorktreeDir: deps.forceRemoveWorktreeDir,
      closeHerdrWorkspace: deps.closeHerdrWorkspace,
    },
    onBeforeRemove: async () => {
      deps.log("cleanup: merged — removing worktree & closing herdr workspace")
      await deps.sleep(CLEANUP_FRAME_MS)
    },
  })
  if (outcome.kind === "noop") {
    deps.log("cleanup: no-op (not a herdr-framed kickoff build)")
    return { phase: "cleanup", done: true }
  }
  // Gate passed → close was attempted. Never return to the main loop:
  // on a clean removal the build dir is GONE (a return would corrupt git's
  // worktree bookkeeping), and on a failed removal the spec prioritizes a
  // prompt close over preserving local build artifacts. Either way: log, exit.
  if (outcome.worktreeRemoveError != null) {
    deps.stderr(
      `build: worktree not fully removed (${outcome.worktreeRemoveError.trim()}); leftover files left on disk — prune manually\n`,
    )
  }
  if (outcome.workspaceCloseFailed != null) {
    deps.stderr(
      `build: herdr workspace close failed (${outcome.workspaceCloseFailed.trim()}); close manually\n`,
    )
  }
  // This phase calls process.exit, so its loop-top build_phase_started would
  // otherwise have no matching completed. Emit a synthetic completed to balance
  // the pair, then bounded-flush analytics (build_completed already fired at the
  // monitor→cleanup transition, so events are captured even if the flush loses).
  ctx.analytics.capture("build_phase_completed", {
    phase: "cleanup",
    duration_ms: 0,
  })
  await ctx.analytics.shutdown()
  return deps.exit()
}

/**
 * Notify a human that the PR is in the announced-ready state. Notification ONLY:
 * a bell + a stdout status line, writing NOTHING to the tracked build dir. Wiring
 * an `appendLog` here would re-dirty the verified-green head right after
 * publishArtifacts() returned "clean", so the next idle poll would re-publish and
 * rerun CI with nothing changed on main (infinite churn). stdout is a separate
 * sink from build.log, so this is safe. Exported so the "writes nothing to
 * build.log" contract can be locked by a unit test.
 */
export function notifyPrReady(
  write: (s: string) => void = (s) => process.stdout.write(s),
): void {
  write("\x07") // bell: human can merge
  write("build: PR ready — mergeable & current; watching until merged\n")
}

function softBudgetWarning(ctx: Ctx, label: string, count: number): void {
  process.stdout.write("\x07")
  appendLog(
    ctx.logPath,
    `⚠ soft budget: ${label} has run ${count} iterations without converging`,
    ctx.now(),
  )
}

function runPhase(ctx: Ctx, state: BuildState): Promise<TransitionSignal> {
  switch (state.phase) {
    case "plan":
      return planPhase(ctx, state)
    case "plan-review":
      return planReviewPhase(ctx, state)
    case "build":
      return buildPhase(ctx, state)
    case "validate":
      return validatePhase(ctx, state)
    case "review":
      return reviewPhase(ctx, state)
    case "pr":
      return prPhase(ctx, state)
    case "monitor":
      return monitorPhase(ctx, state)
    case "cleanup":
      return cleanupPhase(ctx, state)
    case "done":
      return Promise.resolve({ phase: "monitor", done: true })
  }
}

/** The escalate reason carried by a signal, if any. */
function escalateReason(signal: TransitionSignal): string | null {
  if ("verdict" in signal && signal.verdict.kind === "escalate") {
    return signal.verdict.reason
  }
  return null
}

function writeNeedsInput(
  ctx: Ctx,
  phase: string,
  reason: string,
  category?: BlockReason,
): void {
  // build_blocked carries only the categorical reason (payload policy), preferring
  // an explicit category from the write site over substring sniffing of `reason`.
  ctx.analytics.capture("build_blocked", {
    phase,
    reason: blockReasonCategory(phase, reason, category),
  })
  const body = [
    "# build needs input",
    "",
    `**Feature:** ${ctx.feature}`,
    `**Blocked at phase:** ${phase}`,
    `**Reason:** ${reason}`,
    "",
    "## How to resume",
    "",
    "1. Resolve the blocker — edit the relevant artifact in this build dir, or add your decision below.",
    "2. Delete this file (`NEEDS-INPUT.md`).",
    `3. Re-run \`/build ${ctx.feature}\` — it resumes from \`state.json\`.`,
    "",
    "## Your decision",
    "",
    "",
  ].join("\n")
  writeFileSync(join(ctx.buildDir, "NEEDS-INPUT.md"), body)
  process.stdout.write("\x07") // terminal bell
}

/** The `harness_bin`/`harness_model` for a phase: the agent harness, or "script". */
function phaseHarnessInfo(state: BuildState): {
  harness_bin: string
  harness_model?: string
} {
  const map = state.harnessMap
  switch (state.phase) {
    case "plan":
      return { harness_bin: map.plan.bin, harness_model: map.plan.model }
    case "plan-review":
      return {
        harness_bin: map["plan-review"].bin,
        harness_model: map["plan-review"].model,
      }
    case "build":
      return { harness_bin: map.build.bin, harness_model: map.build.model }
    case "review":
      return { harness_bin: map.review.bin, harness_model: map.review.model }
    case "pr":
      return { harness_bin: map.pr.bin, harness_model: map.pr.model }
    default:
      // validate / monitor / cleanup / done — deterministic, script-run.
      return { harness_bin: "script" }
  }
}

/** The terminal outcome of a build, for `build_completed.outcome`. */
export type BuildOutcome = "merged" | "closed-unmerged" | "blocked"

/**
 * Emit the `build_completed` rollup exactly once (guarded by persisted
 * `completedEmitted`). The `outcome` is decided at the call site where the
 * deciding data is in scope; it is NOT re-derived here. Returns the state with
 * `completedEmitted` set, or the input state unchanged when already emitted.
 * Best-effort — `capture` never throws. Exported for focused unit tests.
 */
export function emitBuildCompleted(
  ctx: Ctx,
  state: BuildState,
  outcome: BuildOutcome,
): BuildState {
  if (state.analytics?.completedEmitted) return state
  const a = state.analytics
  const nowMs = Date.parse(ctx.now())
  const startedAtMs = a ? Date.parse(a.startedAt) : Number.NaN
  const haveStart = a != null && !Number.isNaN(startedAtMs)
  const merged = outcome === "merged"
  const totalDurationMs = haveStart ? Math.max(0, nowMs - startedAtMs) : 0
  // [PR5-1] time_to_merge_ms is the FULL build-start→merge span (anchored on
  // startedAt, which always exists), not just the PR-open tail.
  const timeToMergeMs =
    merged && haveStart ? Math.max(0, nowMs - startedAtMs) : null
  const prOpenedAtMs = a?.prOpenedAt ? Date.parse(a.prOpenedAt) : Number.NaN
  const prOpenToMergeMs =
    merged && a?.prOpenedAt && !Number.isNaN(prOpenedAtMs)
      ? Math.max(0, nowMs - prOpenedAtMs)
      : null
  const stats = diffStat(ctx.repoRoot, ctx.baseBranch)
  ctx.analytics.capture("build_completed", {
    outcome,
    total_duration_ms: totalDurationMs,
    time_to_merge_ms: timeToMergeMs,
    pr_open_to_merge_ms: prOpenToMergeMs,
    plan_revisions: a?.planRevisions ?? 0,
    validate_reentries: a?.validateReentries ?? 0,
    review_rounds: state.reviewRound,
    revalidate_attempts: a?.revalidateAttempts ?? 0,
    monitor_passes: a?.monitorPasses ?? 0,
    sentinel_retries: a?.sentinelRetries ?? 0,
    files_changed: stats.filesChanged,
    lines_added: stats.linesAdded,
    lines_removed: stats.linesRemoved,
    e2e_needed: a?.e2eNeeded ?? state.optionalSteps?.e2e?.needed ?? null,
    e2e_passed: a?.e2ePassed ?? null,
    evals_needed: a?.evalsNeeded ?? state.optionalSteps?.evals?.needed ?? null,
    evals_passed: a?.evalsPassed ?? null,
    human_intervention: a?.humanIntervention ?? false,
  })
  return bumpAnalytics(state, { completedEmitted: true })
}

/** Injectable forensics deps for `writeRelaunchAutopsy` (real ones by default). */
export type AutopsyDeps = {
  readHeartbeat: (path: string) => Heartbeat | null
  readLogTail: (logPath: string) => string
  runProbe: (args: { pid?: number }) => string[]
}

function defaultAutopsyDeps(): AutopsyDeps {
  return {
    readHeartbeat,
    readLogTail,
    runProbe: runMemorystatusProbe,
  }
}

/**
 * On (re)launch, if the prior run for this feature ended abnormally — `state.json`
 * stuck on `running` AND a stale/missing heartbeat — append an autopsy to
 * `build.log`: prior phase, approximate time of death, and the wrapper's recorded
 * exit (or the "tree killed together" fallback), plus a best-effort memorystatus
 * probe. A FRESH heartbeat (an apparently-live concurrent run) yields an explicit
 * `autopsy: skipped` line and no probe — never a false "ended abnormally".
 *
 * Append-only forensics: never mutates the live run's state, so the worst case of
 * a mis-timed freshness read is one spurious log line, not corruption. Exported +
 * fully injectable for focused unit tests (full `run()` isn't test-driven).
 */
export function writeRelaunchAutopsy(args: {
  priorState: BuildState | null
  buildDir: string
  logPath: string
  now: () => string
  deps?: AutopsyDeps
}): void {
  const { priorState, buildDir, logPath, now } = args
  if (priorState?.status !== "running") return
  const deps = args.deps ?? defaultAutopsyDeps()
  // Read the new gitignored .build/ location first, then fall back to the
  // pre-PRO-667 tracked location so a build that was mid-run when the move
  // shipped still yields an accurate time-of-death (and isn't falsely slandered
  // as dead). This fallback runs before the one-time convergence removal in
  // run(), so the legacy file is still on disk when we need it.
  const hb =
    deps.readHeartbeat(heartbeatPath(buildDir)) ??
    deps.readHeartbeat(legacyHeartbeatPath(buildDir))
  const nowMs = Date.parse(now())
  if (!isHeartbeatStale({ heartbeat: hb, nowMs })) {
    // Fresh heartbeat ⇒ another orchestrator for this feature is (apparently)
    // alive. Do NOT append a false "ended abnormally" autopsy or run the probe.
    appendLog(
      logPath,
      `autopsy: skipped — prior heartbeat is fresh (last-alive≈${hb?.ts}, pid=${hb?.pid}); an active build appears to be running`,
      now(),
    )
    return
  }
  const wrapperExit = parseWrapperExit(deps.readLogTail(logPath))
  for (const line of buildAutopsyLines({
    priorPhase: priorState.phase,
    heartbeat: hb,
    priorUpdatedAt: priorState.updatedAt,
    wrapperExit,
  })) {
    appendLog(logPath, line, now())
  }
  for (const line of deps.runProbe({ pid: hb?.pid })) {
    appendLog(logPath, line, now())
  }
  // Durable circle-back record: everything the log lines say, structured, plus
  // the dead run's launch context (who spawned it) — the piece needed to
  // attribute an external kill after the fact. Covers deaths where the
  // in-process signal handler never ran (SIGKILL / whole-tree teardown).
  appendCrashRecord(crashLogPath(buildDir), {
    kind: "autopsy",
    ts: now(),
    priorPhase: priorState.phase,
    lastAlive: hb?.ts ?? priorState.updatedAt,
    pid: hb?.pid ?? null,
    wrapperExit,
    launch: readLaunchContext(launchContextPath(buildDir)),
  })
}

export type RunArgs = {
  feature: string
  cwd?: string
  env?: NodeJS.ProcessEnv
  now?: () => string
}

/**
 * Run (or resume) the pipeline for `feature` to completion or a blocker.
 * Returns the terminal state.
 */
export async function run({
  feature,
  cwd = process.cwd(),
  env = process.env,
  now = () => new Date().toISOString(),
}: RunArgs): Promise<BuildState> {
  const repoRoot = detectRepoRoot(cwd)
  const branch = detectBranch(repoRoot)
  const buildDir = buildDirOf(repoRoot, feature)
  const ctx = createCtx({
    repoRoot,
    feature,
    buildDir,
    baseBranch: BASE_BRANCH,
    env,
    now,
  })

  const priorState = readState(repoRoot, feature)
  const resume = priorState != null
  // Relaunch forensics: if the prior run ended abnormally (status still
  // `running` + a stale/missing heartbeat), append an autopsy to build.log so the
  // death is attributable. A fresh heartbeat (a live concurrent run) is left
  // un-slandered with an explicit `autopsy: skipped` line. Append-only — never
  // mutates state.
  writeRelaunchAutopsy({
    priorState,
    buildDir,
    logPath: ctx.logPath,
    now,
  })
  // [PRO-667] One-time convergence for in-flight builds: if this dir still has
  // the pre-move, git-tracked build/<feature>/heartbeat.json, untrack it now
  // that the heartbeat lives in gitignored .build/. Runs AFTER the autopsy
  // (whose fallback may still read the legacy file) and BEFORE startHeartbeat.
  // Best-effort: the staged deletion rides the next commitArtifacts as a
  // legitimate one-time commit; a failure here must never take the run down.
  try {
    const removed = untrackLegacyHeartbeat(repoRoot, feature)
    if (removed.code !== 0)
      // `sh` returns a non-zero ShResult rather than throwing, so a failed
      // `git rm` (e.g. index lock) skips the catch below — log it explicitly so
      // a legacy file left tracked (and still churning) has an on-disk trace. It
      // self-heals on the next launch.
      appendLog(
        ctx.logPath,
        `converge: untrackLegacyHeartbeat git rm failed (non-fatal, code=${removed.code}): ${removed.stderr.trim()}`,
        now(),
      )
    else if (removed.stdout.trim() !== "")
      appendLog(
        ctx.logPath,
        "converge: untracked legacy build/<feature>/heartbeat.json (PRO-667)",
        now(),
      )
  } catch (err) {
    appendLog(
      ctx.logPath,
      `converge: untrackLegacyHeartbeat failed (non-fatal): ${String(err)}`,
      now(),
    )
  }
  // [PR7-1] Seed the kickoff→build join key BEFORE the loop, independent of the
  // best-effort ensure-ticket step. Precedence: persisted state (resume, handled
  // inside decideStartup) → env (the /build PRO-123 path + kickoff's headless
  // spawn) → the worktree sidecar (the detached launch where env didn't cross the
  // terminal boundary). The seed feeds ONLY the fresh-start branch.
  const sidecar = readKickoffIdentity(repoRoot, feature)
  const seedIssueId =
    env.BUILD_LINEAR_ISSUE_ID?.trim() || sidecar.issueId || undefined
  const seedIssueUuid =
    env.BUILD_LINEAR_ISSUE_UUID?.trim() || sidecar.issueUuid || undefined

  const decision = decideStartup(
    {
      specExists: specExists(buildDir),
      state: priorState,
      needsInputExists: existsSync(join(buildDir, "NEEDS-INPUT.md")),
    },
    feature,
    branch,
    now(),
    seedIssueId,
    seedIssueUuid,
  )

  if (decision.kind === "halt") {
    // Only log into the build dir for a real feature; don't create one for a typo.
    if (existsSync(buildDir))
      appendLog(ctx.logPath, `halt: ${decision.message}`, now())
    process.stdout.write(`build: ${decision.message}\n`)
    return readState(repoRoot, feature) ?? initState(feature, branch, now())
  }

  let state = writeState(repoRoot, decision.state, now())
  // Normalize the legacy BUILD_SKIP_E2E=1 escape hatch into the persisted override
  // BEFORE the main loop, so the gate and the read-only dashboard both read
  // state.optionalStepOverrides only (single source of truth). Runs on every launch
  // (fresh + resume); idempotent + only writes when it actually changed.
  const normalized = normalizeEnvOverrides(state, env)
  if (normalized !== state) state = writeState(repoRoot, normalized, now())
  // Derive + persist the portless dev URL once, so every consumer (the e2e
  // dev-server control surface and the read-only dashboard's dev-login URLs)
  // reads one authoritative value rather than re-deriving it. Idempotent: only
  // writes when it actually changed.
  const devUrl = deriveDevUrl(env, repoRoot)
  if (state.devUrl !== devUrl)
    state = writeState(repoRoot, { ...state, devUrl }, now())
  appendLog(ctx.logPath, `start: phase=${state.phase} branch=${branch}`, now())

  // Liveness heartbeat — rewrites heartbeat.json every 15 s (well under the
  // monitor's 180 s idle poll) so a later relaunch can recover time-of-death and
  // tell a dead prior run from a live concurrent one. Stopped on every normal
  // exit (below) and by the crash handlers; a live interval would otherwise keep
  // the process alive past return.
  const heartbeat = startHeartbeat({ path: heartbeatPath(buildDir), now })

  // Launch forensics — record who spawned this orchestrator (ancestry + the
  // session-identifying env subset) to gitignored .build/launch.json and one
  // build.log line. A later signal handler or relaunch autopsy embeds it into
  // tracked crashes.jsonl, so an external kill is attributable after the fact.
  const launch = captureLaunchContext({ buildDir, env, now })
  appendLog(
    ctx.logPath,
    `launch: pid=${launch.pid} ppid=${launch.ppid} ancestry=${launch.ancestry.map((e) => `${e.pid} ${e.command}`).join(" ← ")}`,
    now(),
  )

  // Death-attribution safety net for the ASYNC faults the phase loop's try/catch
  // can't see: OS signals (H4), uncaught/unhandled rejections (in-process crash),
  // and a write-side EPIPE echoing child stdout (H2 — logged once, non-fatal).
  installCrashHandlers({
    logLine: (m) => appendLog(ctx.logPath, m, now()),
    onSignal: (sig) => {
      heartbeat.stop()
      // Durable kill evidence — the structured record lands before the human
      // lines below (the sender may follow up with an untrappable SIGKILL;
      // crash-handlers has already appended its one `signal: received` line).
      try {
        const phase = readState(repoRoot, feature)?.phase ?? state.phase
        const record = buildSignalCrashRecord({
          signal: sig,
          now,
          pid: process.pid,
          ppid: process.ppid,
          phase,
          launch,
          parentAlive: isPidAlive(launch.ppid),
        })
        appendCrashRecord(crashLogPath(buildDir), record)
        for (const line of describeSignalCrash(record))
          appendLog(ctx.logPath, line, now())
      } catch {
        // Forensics must never block the exit path.
      }
    },
    onUncaught: (err, origin) => {
      // Best-effort park: the crash-handler already wrote the authoritative
      // `uncaught (...)` fingerprint line to build.log BEFORE calling us, so
      // attribution survives even if the park below throws. Re-read from disk
      // (avoid a stale loop-variable closure) and reuse the existing park-writer,
      // so an async crash parks identically to a thrown phase — a crash never
      // masquerades as a kill.
      try {
        const cur = readState(repoRoot, feature)
        const phase = cur?.phase ?? state.phase
        writeState(repoRoot, { ...(cur ?? state), status: "blocked" }, now())
        writeNeedsInput(
          ctx,
          phase,
          `uncaught ${origin}: ${(err as Error)?.message ?? String(err)}`,
        )
      } catch {
        // Secondary failure while parking — swallow so the handler still reaches
        // heartbeat.stop() + exit(1); the fingerprint line is already on disk.
      }
      heartbeat.stop()
    },
  })

  // Ensure a Linear ticket exists + its description is synced to the spec, once
  // per launch (best-effort — never throws, never blocks). `loadConfig` (not
  // `validateConfig`): an unpinned config warns-and-skips so ordinary checkouts
  // without the kickoff setup keep building. On resume this re-syncs by
  // design, so a human spec edit before a re-run propagates (file wins).
  const kickoffConfig = loadConfig(repoRoot, env)
  state = writeState(
    repoRoot,
    await ensureLinearTicket(
      {
        buildDir,
        specPath: ctx.specPath,
        feature,
        config: kickoffConfig,
        state,
      },
      defaultEnsureDeps(ctx),
    ),
    now(),
  )

  // Identity + provider are now resolved (seed → state, possibly enriched by
  // ensure-ticket); construct the REAL analytics client from the seeded common
  // props and reassign ctx.analytics (was a no-op stub from createCtx). Phase
  // handlers read ctx.analytics at call time, so every later emit uses it.
  ctx.analytics = createPipelineAnalytics({
    common: buildCommonProperties({
      process: "build",
      repoRoot,
      env,
      worktreeProvider: kickoffConfig.worktree.provider ?? null,
      issueId: state.linearIssueId ?? null,
      issueUuid: state.linearIssueUuid ?? null,
      branch: state.branch,
      slug: state.feature,
    }),
    distinctId: resolveDistinctId(repoRoot),
    env,
  })
  ctx.analytics.capture("build_started", {
    resume,
    start_phase: state.phase,
  })

  while (state.status === "running" && state.phase !== "done") {
    appendLog(ctx.logPath, `▶ phase: ${state.phase}`, now())
    const phaseStartedAt = Date.now()
    ctx.analytics.capture("build_phase_started", {
      phase: state.phase,
      ...phaseHarnessInfo(state),
    })

    let signal: TransitionSignal
    try {
      signal = await runPhase(ctx, state)
    } catch (error) {
      const phase = error instanceof EscalateError ? error.phase : state.phase
      const reason =
        error instanceof EscalateError
          ? error.reason
          : `unexpected error: ${(error as Error).message}`
      const category =
        error instanceof EscalateError ? error.category : undefined
      // [PR2-1] A throwing phase still "exits" — emit the terminal phase-completed
      // so the funnel has no holes (EscalateError → ESCALATE; any other throw →
      // ERROR), BEFORE build_blocked. Use `state.phase` (the phase that emitted
      // build_phase_started this iteration) so the started/completed pair stays
      // balanced even when an escalation is thrown from a NESTED phase — e.g. the
      // e2e-infra escalate originates in `validate` but can fire while the loop is
      // in `review` (revalidation). `build_blocked` below keeps `phase` (the true
      // failure origin) so the block reason still points at the real source.
      ctx.analytics.capture("build_phase_completed", {
        phase: state.phase,
        verdict: error instanceof EscalateError ? "ESCALATE" : "ERROR",
        duration_ms: Date.now() - phaseStartedAt,
      })
      state = bumpAnalytics(state, { humanIntervention: true })
      state = writeState(repoRoot, { ...state, status: "blocked" }, now())
      writeNeedsInput(ctx, phase, reason, category)
      appendLog(ctx.logPath, `BLOCKED: ${reason}`, now())
      break
    }

    ctx.analytics.capture("build_phase_completed", {
      phase: signal.phase,
      verdict: phaseVerdictLabel(signal),
      duration_ms: Date.now() - phaseStartedAt,
    })

    const next: Transition = transition(signal)

    // Persisted counter bumps keyed on the genuine transition signal.
    const analyticsPatch: Partial<BuildAnalytics> = {}
    if (
      signal.phase === "plan-review" &&
      signal.verdict.kind === "needs_revision"
    ) {
      analyticsPatch.planRevisions = (state.analytics?.planRevisions ?? 0) + 1
    }
    if (signal.phase === "validate" && signal.pass === false) {
      analyticsPatch.validateReentries =
        (state.analytics?.validateReentries ?? 0) + 1
    }
    if (next.status === "blocked") analyticsPatch.humanIntervention = true

    let nextState = bumpAnalytics(state, analyticsPatch)
    nextState = {
      ...nextState,
      phase: next.phase,
      status: next.status,
      reviewRound: next.bumpReviewRound
        ? state.reviewRound + 1
        : state.reviewRound,
    }

    // [PR6-1] build_completed fires in-loop at the monitor terminal transitions,
    // where both signal.merged and next are in scope. The post-loop block only
    // ever emits "blocked".
    if (signal.phase === "monitor" && signal.done && next.phase === "cleanup") {
      nextState = emitBuildCompleted(ctx, nextState, "merged")
    } else if (
      signal.phase === "monitor" &&
      signal.done &&
      signal.merged !== true &&
      next.phase === "done"
    ) {
      nextState = emitBuildCompleted(ctx, nextState, "closed-unmerged")
    }

    state = writeState(repoRoot, nextState, now())
    appendLog(
      ctx.logPath,
      `→ phase=${state.phase} status=${state.status}`,
      now(),
    )

    if (state.status === "blocked") {
      const reason = escalateReason(signal) ?? "phase could not proceed"
      writeNeedsInput(ctx, signal.phase, reason)
      appendLog(ctx.logPath, `BLOCKED: ${reason}`, now())
    }
  }

  if (state.status === "done") {
    // Log BEFORE committing so the final build.log line lands inside the commit
    // (same ordering rationale as before). The human-facing PR record already
    // landed via the in-loop publish pushes; state.json=done + this line are
    // local bookkeeping. Commit locally (NO push) so the worktree ends clean — a
    // merged branch can't be pushed to, and a closed branch's record already rode
    // along on the publish/rebase pushes.
    appendLog(ctx.logPath, "✓ done — PR merged/closed by a human", now())
    commitArtifacts(repoRoot, feature)
  } else if (state.status === "blocked") {
    // Escalation: the branch is still open. Publish the record (build.log/
    // state.json/plan/review) so the human sees why it parked. Best-effort.
    appendLog(ctx.logPath, "BLOCKED — see NEEDS-INPUT.md", now())
    // [PR6-1] The post-loop terminal block emits ONLY the blocked outcome (it
    // needs no signal — state.status is persisted). Covers both the in-loop
    // break (throw/escalate) and any post-loop blocked branch.
    state = emitBuildCompleted(ctx, state, "blocked")
    state = writeState(repoRoot, state, now())
    const r = publishArtifacts(repoRoot, feature)
    if (r.status === "failed")
      process.stderr.write(
        `build: artifacts committed locally but push failed (${r.detail}); push manually\n`,
      )
  }
  // Stop the liveness heartbeat before returning so the interval can't keep the
  // process alive past run() (the cleanupPhase process.exit path tears the
  // interval down on its own). Idempotent with the crash-handler stops.
  heartbeat.stop()
  // The single mandatory bounded flush for the common return paths (the
  // cleanupPhase process.exit path flushes there). Never throws.
  await ctx.analytics.shutdown()
  return state
}
