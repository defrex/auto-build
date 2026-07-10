/**
 * build orchestrator state.
 *
 * `build/[feature]/state.json` is the durable state for the autonomous
 * plan → build → review → PR pipeline. Re-running build reads this file
 * and continues from `phase` — resuming *is* re-running, because all state is
 * on disk. See `build/build-flow/design.html`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { z } from "zod"

/** Pipeline phases, in order. `done` is terminal. */
export const PHASES = [
  "plan",
  "plan-review",
  "build",
  "validate",
  "review",
  "pr",
  "monitor",
  "cleanup",
  "done",
] as const

export const phaseSchema = z.enum(PHASES)
export type Phase = z.infer<typeof phaseSchema>

export const statusSchema = z.enum(["running", "blocked", "done", "failed"])
export type Status = z.infer<typeof statusSchema>

/** One harness binary + optional model, e.g. `{ bin: "claude", model: "opus" }`. */
export const harnessEntrySchema = z.object({
  bin: z.string().min(1),
  model: z.string().min(1).optional(),
})
export type HarnessEntry = z.infer<typeof harnessEntrySchema>

/** Which harness runs each agent-driven phase (validate/monitor are script-run). */
export const harnessMapSchema = z.object({
  plan: harnessEntrySchema,
  "plan-review": harnessEntrySchema,
  build: harnessEntrySchema,
  review: harnessEntrySchema,
  pr: harnessEntrySchema,
})
export type HarnessMap = z.infer<typeof harnessMapSchema>

/** Registered optional-step ids. The rich registry (descriptions, host phase) lives in
 *  `optional-steps.ts`; this enum is the single id source. The registry is a TOTAL map
 *  over this enum (Record<OptionalStepId, …>), so the compiler — not a runtime test —
 *  enforces that every id has a registry entry. */
export const optionalStepIdSchema = z.enum(["e2e", "evals"])
export type OptionalStepId = z.infer<typeof optionalStepIdSchema>

/** One plan-time decision: needed for this ticket + a one-line rationale. */
export const optionalStepDecisionSchema = z.object({
  needed: z.boolean(),
  rationale: z.string().min(1),
})
export type OptionalStepDecision = z.infer<typeof optionalStepDecisionSchema>

/**
 * Plan-time declaration: per-step decision. Modelled as an explicit object with each
 * key OPTIONAL — NOT `z.record(enum, …)`. `noUncheckedIndexedAccess` is OFF in this
 * repo, so a record's index access would type as `Decision` (not `Decision | undefined`),
 * making the fail-safe `?? true` dead/untyped. The explicit-optional object guarantees
 * `declaration.e2e` is `Decision | undefined`.
 *
 * `z.strictObject` (zod v4) — NOT `z.object` — so an UNKNOWN id (e.g. `{"bad": …}`) makes
 * the whole declaration fail to parse rather than being silently stripped to `{}`. That is
 * what routes a malformed declaration to the fail-safe "run all" path (an empty `{}` is a
 * valid declaration meaning "no decisions → every step fails safe to needed"; an
 * unknown-id object is NOT a valid declaration). See parseOptionalStepsDeclaration.
 */
export const optionalStepsSchema = z.strictObject({
  e2e: optionalStepDecisionSchema.optional(),
  evals: optionalStepDecisionSchema.optional(),
})
export type OptionalStepsDeclaration = z.infer<typeof optionalStepsSchema>

/** Human force on/off per step (overrides the planner). Same strict explicit-optional shape. */
export const optionalStepOverridesSchema = z.strictObject({
  e2e: z.enum(["on", "off"]).optional(),
  evals: z.enum(["on", "off"]).optional(),
})
export type OptionalStepOverrides = z.infer<typeof optionalStepOverridesSchema>

export const buildStateSchema = z.object({
  feature: z.string().min(1),
  phase: phaseSchema,
  status: statusSchema,
  /** Current code-review round (1-based once review starts; 0 before). */
  reviewRound: z.number().int().nonnegative(),
  branch: z.string().min(1),
  harnessMap: harnessMapSchema,
  /**
   * Linear human identifier for this build's ticket, e.g. "PRO-123". Optional:
   * set by the ensure-ticket step at launch (best-effort); absent on old
   * `state.json` files and before a ticket is ensured, keeping resume compatible.
   */
  linearIssueId: z.string().min(1).optional(),
  /** Linear issue UUID, recorded alongside `linearIssueId`. Optional (see above). */
  linearIssueUuid: z.string().min(1).optional(),
  /**
   * Linear issue title — the human heading for the dashboard. Optional: set by
   * the ensure-ticket step at launch (best-effort); absent on old `state.json`
   * files and before a ticket is ensured, keeping resume compatible.
   */
  linearTitle: z.string().min(1).optional(),
  /**
   * Opening 1–2 sentences of the Linear issue description, already length-capped
   * when persisted. Optional (see `linearTitle`). Surfaced as the dashboard's
   * one-line orientation summary.
   */
  linearSummary: z.string().min(1).optional(),
  /** Canonical Linear issue URL, recorded alongside `linearIssueId`. Optional (see `linearTitle`). */
  linearUrl: z.string().min(1).optional(),
  /**
   * PR number for this build's branch. Optional: set when the monitor resolves
   * the PR at the start of monitoring; absent on old states and before a PR
   * exists. Persisted so the read-only dashboard can surface a prominent link
   * (the panel never shells out).
   */
  prNumber: z.number().int().positive().optional(),
  /** Full PR URL, recorded alongside `prNumber` (see above). Optional. */
  prUrl: z.string().min(1).optional(),
  /**
   * Derived portless dev URL for this build's worktree (see `deriveDevUrl` in
   * `dev-server.ts`). Set ONCE at startup by the orchestrator so every consumer —
   * the externalized dev-server control surface and the read-only dashboard's
   * dev-login URL display — agrees on a single authoritative value rather than
   * each re-deriving it. Optional/absent on old state.json files and before the
   * first run; consumers fall back to re-deriving when absent.
   */
  devUrl: z.string().min(1).optional(),
  /**
   * Plan-time optional-step declaration: per registered optional step, whether it's
   * needed for this ticket + a one-line rationale. Optional — absent on old state.json
   * files and before the plan phase runs; an absent declaration means "run all optional
   * steps" (fail-safe, preserving pre-framework behavior). Re-established on every (re)plan.
   */
  optionalSteps: optionalStepsSchema.optional(),
  /**
   * Human force-on/force-off overrides per optional step, hand-edited like `harnessMap`.
   * Takes precedence over the planner. Optional/absent = no overrides. The legacy
   * `BUILD_SKIP_E2E=1` env var is normalized INTO this field at startup (as e2e="off"),
   * so the override — and thus the skip — is durable and visible to the read-only dashboard.
   */
  optionalStepOverrides: optionalStepOverridesSchema.optional(),
  /**
   * Best-effort analytics lifecycle counters for `build_completed` — rollups that
   * span phases and survive resume. OPTIONAL so old `state.json` files still parse
   * (the read-only dashboard tolerates new optional fields). See `bin/analytics/`.
   */
  analytics: z
    .object({
      /** ISO build start — anchors total_duration_ms / time_to_merge_ms. */
      startedAt: z.string(),
      /** ISO PR-open time — anchors pr_open_to_merge_ms + duration_since_start. */
      prOpenedAt: z.string().optional(),
      planRevisions: z.number().int().nonnegative().default(0),
      validateReentries: z.number().int().nonnegative().default(0),
      revalidateAttempts: z.number().int().nonnegative().default(0),
      monitorPasses: z.number().int().nonnegative().default(0),
      /**
       * Count of builder-phase auto-retries triggered by a sentinel-less exit
       * (PRO-639). `.default(0)` keeps old `state.json` files parsing (resume-safe).
       */
      sentinelRetries: z.number().int().nonnegative().default(0),
      e2eNeeded: z.boolean().optional(),
      e2ePassed: z.boolean().optional(),
      evalsNeeded: z.boolean().optional(),
      evalsPassed: z.boolean().optional(),
      humanIntervention: z.boolean().default(false),
      /**
       * Set true the first time `build_completed` is emitted — dedupes the event
       * across the merged→cleanup transition AND a resume that re-reaches terminal.
       */
      completedEmitted: z.boolean().default(false),
    })
    .optional(),
  updatedAt: z.string(),
})
export type BuildState = z.infer<typeof buildStateSchema>
export type BuildAnalytics = NonNullable<BuildState["analytics"]>

/**
 * Default harness assignment: claude/opus plans & builds, codex reviews.
 * Overridable per-feature by editing `state.json` → `harnessMap`.
 */
export function defaultHarnessMap(): HarnessMap {
  return {
    plan: { bin: "claude", model: "opus" },
    "plan-review": { bin: "codex" },
    build: { bin: "claude", model: "opus" },
    review: { bin: "codex" },
    pr: { bin: "claude", model: "opus" },
  }
}

/** Absolute path to a feature's build dir, given the repo root. */
export function buildDir(repoRoot: string, feature: string): string {
  return join(repoRoot, "build", feature)
}

/** Absolute path to a feature's `state.json`. */
export function statePath(repoRoot: string, feature: string): string {
  return join(buildDir(repoRoot, feature), "state.json")
}

/** A fresh state object at the start of the pipeline. */
export function initState(
  feature: string,
  branch: string,
  now: string,
  linearIssueId?: string,
  linearIssueUuid?: string,
): BuildState {
  return {
    feature,
    phase: "plan",
    status: "running",
    reviewRound: 0,
    branch,
    harnessMap: defaultHarnessMap(),
    // Seeded only on a fresh ticket-ref build (`/build PRO-123`) so the
    // ensure-ticket step runs in existing-id (sync-only) mode and adopts the
    // ticket instead of searching/creating a duplicate. Empty → omit. The uuid
    // is seeded alongside the id (kickoff propagates both — see kickoff §3.0).
    ...(linearIssueId ? { linearIssueId } : {}),
    ...(linearIssueUuid ? { linearIssueUuid } : {}),
    // Seed the analytics lifecycle counters at build start.
    analytics: {
      startedAt: now,
      planRevisions: 0,
      validateReentries: 0,
      revalidateAttempts: 0,
      monitorPasses: 0,
      sentinelRetries: 0,
      humanIntervention: false,
      completedEmitted: false,
    },
    updatedAt: now,
  }
}

/**
 * Return a new state with `patch` merged into the analytics block, defaulting a
 * missing block (states predating the field) so phase handlers and the main loop
 * mutate counters uniformly. Pure — does not persist. (Caller `writeState`s.)
 */
export function bumpAnalytics(
  state: BuildState,
  patch: Partial<BuildAnalytics>,
): BuildState {
  const base: BuildAnalytics = state.analytics ?? {
    startedAt: state.updatedAt,
    planRevisions: 0,
    validateReentries: 0,
    revalidateAttempts: 0,
    monitorPasses: 0,
    sentinelRetries: 0,
    humanIntervention: false,
    completedEmitted: false,
  }
  return { ...state, analytics: { ...base, ...patch } }
}

/** Read + validate `state.json`, or `null` if it doesn't exist yet. */
export function readState(
  repoRoot: string,
  feature: string,
): BuildState | null {
  const path = statePath(repoRoot, feature)
  if (!existsSync(path)) return null
  return buildStateSchema.parse(JSON.parse(readFileSync(path, "utf-8")))
}

/** Persist state to `state.json`, stamping `updatedAt`. Creates the build dir if needed. */
export function writeState(
  repoRoot: string,
  state: BuildState,
  now: string,
): BuildState {
  const stamped = { ...state, updatedAt: now }
  const path = statePath(repoRoot, state.feature)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(stamped, null, 2)}\n`)
  return stamped
}
