/**
 * Kickoff configuration: typed `KickoffConfig` loaded from a
 * committed `build/kickoff/config.json`, with env-var overrides for the
 * Linear IDs (which can't be known at plan time — see the design's Open
 * Questions and the plan §0.3/§0.4).
 *
 * The ID fields ship as empty-string placeholders; the operator pins them once
 * (see `build/kickoff/README.md`). Until they're pinned, `validateConfig`
 * hard-stops with the pin instructions so an ingester never silently no-ops.
 *
 * The tunables (Sentry thresholds, caps, concurrency) carry sane defaults so
 * the file only needs the real defaults overridden, and so a freshly-shipped
 * `config.json` is valid as soon as the IDs are filled.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export type LinearConfig = {
  teamId: string
  projectId: string
  triageStateId: string
  readyStateId: string
  inProgressStateId: string
  doneStateId: string
  /** Any workflow state that means "rejected/won't-do" — tombstones its signals. */
  rejectedStateIds: string[]
  sourceObservationsLabelId: string
  sourceSentryLabelId: string
  /**
   * Issues carrying this are under-specified; the dispatcher must never select
   * them. The only label-based gate left in selection.
   */
  needsDefinitionLabelId: string
}

export type SentryConfig = {
  minEvents: number
  minAffectedUsers: number
  lookbackDays: number
  environments: string[]
  requireSeenSinceLatestDeploy: boolean
  staleAfterDeployFallbackDays: number
}

export type CapsConfig = {
  maxNewIssuesPerRun: number
  maxInvestigationsPerRun: number
}

export type WorktreeConfig = {
  /** Which tool provisions build worktrees — see `bin/kickoff/worktree-provider.ts`. */
  provider: "git" | "superset"
  /** Superset project UUID for this repo — required when provider is "superset". */
  supersetProjectId: string
}

export type KickoffConfig = {
  linear: LinearConfig
  sentry: SentryConfig
  caps: CapsConfig
  worktree: WorktreeConfig
  /** How many builds may be in flight at once (default 1; tunable). */
  maxConcurrentBuilds: number
}

/** Tunable defaults (plan §0.4). Linear IDs have no default — they must be pinned. */
export const DEFAULT_SENTRY: SentryConfig = {
  minEvents: 25,
  minAffectedUsers: 3,
  lookbackDays: 14,
  environments: ["production"],
  requireSeenSinceLatestDeploy: true,
  staleAfterDeployFallbackDays: 3,
}

export const DEFAULT_CAPS: CapsConfig = {
  maxNewIssuesPerRun: 5,
  maxInvestigationsPerRun: 3,
}

export const DEFAULT_MAX_CONCURRENT_BUILDS = 1

export const DEFAULT_WORKTREE: WorktreeConfig = {
  provider: "git",
  supersetProjectId: "",
}

const EMPTY_LINEAR: LinearConfig = {
  teamId: "",
  projectId: "",
  triageStateId: "",
  readyStateId: "",
  inProgressStateId: "",
  doneStateId: "",
  rejectedStateIds: [],
  sourceObservationsLabelId: "",
  sourceSentryLabelId: "",
  needsDefinitionLabelId: "",
}

/** Env-var override → config path. Lets a scheduler inject IDs without editing the file. */
const LINEAR_ENV_OVERRIDES: Record<string, keyof LinearConfig> = {
  KICKOFF_LINEAR_TEAM_ID: "teamId",
  KICKOFF_LINEAR_PROJECT_ID: "projectId",
  KICKOFF_LINEAR_TRIAGE_STATE_ID: "triageStateId",
  KICKOFF_LINEAR_READY_STATE_ID: "readyStateId",
  KICKOFF_LINEAR_IN_PROGRESS_STATE_ID: "inProgressStateId",
  KICKOFF_LINEAR_DONE_STATE_ID: "doneStateId",
  KICKOFF_LINEAR_SOURCE_OBSERVATIONS_LABEL_ID: "sourceObservationsLabelId",
  KICKOFF_LINEAR_SOURCE_SENTRY_LABEL_ID: "sourceSentryLabelId",
  KICKOFF_LINEAR_NEEDS_DEFINITION_LABEL_ID: "needsDefinitionLabelId",
}

/**
 * The single Linear-ID fields that must be non-empty before any run.
 * `projectId` is intentionally NOT required — we file into the Product team
 * directly; the field stays on the config so a project can be pinned later.
 */
const REQUIRED_LINEAR_KEYS: (keyof LinearConfig)[] = [
  "teamId",
  "triageStateId",
  "readyStateId",
  "inProgressStateId",
  "doneStateId",
  "sourceObservationsLabelId",
  "sourceSentryLabelId",
  "needsDefinitionLabelId",
]

/** Repo-relative path to the committed config file. */
export function configPath(repoRoot: string): string {
  return join(repoRoot, "build", "kickoff", "config.json")
}

/**
 * Merge a parsed `config.json` object + env over the tunable defaults into a
 * fully-resolved `KickoffConfig`. Pure (no fs) so it's unit-testable.
 */
export function resolveConfig(
  raw: unknown,
  env: Record<string, string | undefined> = {},
): KickoffConfig {
  const obj = (raw ?? {}) as Record<string, unknown>
  const linearRaw = (obj.linear ?? {}) as Partial<LinearConfig>
  const sentryRaw = (obj.sentry ?? {}) as Partial<SentryConfig>
  const capsRaw = (obj.caps ?? {}) as Partial<CapsConfig>
  const worktreeRaw = (obj.worktree ?? {}) as Partial<WorktreeConfig>

  const linear: LinearConfig = { ...EMPTY_LINEAR, ...linearRaw }
  // rejectedStateIds is an array — guard against a missing/non-array value.
  linear.rejectedStateIds = Array.isArray(linearRaw.rejectedStateIds)
    ? linearRaw.rejectedStateIds
    : []

  for (const [envKey, field] of Object.entries(LINEAR_ENV_OVERRIDES)) {
    const v = env[envKey]
    if (v != null && v !== "") (linear[field] as string) = v
  }

  const worktree: WorktreeConfig = { ...DEFAULT_WORKTREE, ...worktreeRaw }
  const providerEnv = env.KICKOFF_WORKTREE_PROVIDER
  if (providerEnv != null && providerEnv !== "") {
    worktree.provider = providerEnv as WorktreeConfig["provider"]
  }
  const projectEnv = env.KICKOFF_SUPERSET_PROJECT_ID
  if (projectEnv != null && projectEnv !== "") {
    worktree.supersetProjectId = projectEnv
  }

  return {
    linear,
    sentry: { ...DEFAULT_SENTRY, ...sentryRaw },
    caps: { ...DEFAULT_CAPS, ...capsRaw },
    worktree,
    maxConcurrentBuilds:
      typeof obj.maxConcurrentBuilds === "number"
        ? obj.maxConcurrentBuilds
        : DEFAULT_MAX_CONCURRENT_BUILDS,
  }
}

/**
 * Throw a clear, operator-facing error if any required Linear ID is unset.
 * This is the "config-pin gate" before first use (plan §0.3).
 */
export function validateConfig(config: KickoffConfig): void {
  const missing = REQUIRED_LINEAR_KEYS.filter(
    (k) => !((config.linear[k] as string) ?? "").trim(),
  )
  if (missing.length > 0) {
    throw new Error(
      [
        "kickoff is not configured.",
        `Unset Linear IDs: ${missing.join(", ")}.`,
        "Pin them in build/kickoff/config.json (or via KICKOFF_LINEAR_* env vars).",
        "See build/kickoff/README.md → Setup for how to list the IDs via Linear MCP.",
      ].join(" "),
    )
  }

  const { worktree } = config
  if (worktree.provider !== "git" && worktree.provider !== "superset") {
    throw new Error(
      `unknown worktree provider "${worktree.provider}" — expected "git" or "superset" (build/kickoff/config.json → worktree.provider).`,
    )
  }
  // `?? ""` guards a JSON `null`, which survives the defaults spread.
  if (
    worktree.provider === "superset" &&
    !(worktree.supersetProjectId ?? "").trim()
  ) {
    throw new Error(
      "worktree provider 'superset' requires worktree.supersetProjectId — find it with `superset projects list --json` and pin it in build/kickoff/config.json.",
    )
  }
}

/**
 * Read + resolve `config.json` from disk. Returns the resolved config without
 * validating IDs (so callers can inspect it); call `validateConfig` to gate.
 */
export function loadConfig(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
): KickoffConfig {
  const path = configPath(repoRoot)
  const raw = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf-8")) as unknown)
    : {}
  return resolveConfig(raw, env)
}
