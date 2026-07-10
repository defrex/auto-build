/**
 * The optional-step framework for the build pipeline.
 *
 * An *optional step* is a named, independently-gateable unit of build work that
 * runs only when the change actually calls for it. The plan phase declares which
 * steps a ticket needs (persisted to `state.json`); the orchestrator gates each
 * step (run / skip / block); the dashboard renders the outcome.
 *
 * This module owns the registry ({@link OPTIONAL_STEPS}) and the PURE resolution,
 * lifecycle, view, and parse helpers. It imports the persisted schemas/types from
 * `state.ts` only — the dependency is one-directional (no circular import).
 * E2E is the first (and, in this scope, only) registered step; see `orchestrator.ts`
 * `makeE2e` for its concrete host-phase hook.
 */

import {
  type OptionalStepDecision,
  type OptionalStepId,
  type OptionalStepOverrides,
  type OptionalStepsDeclaration,
  optionalStepsSchema,
  PHASES,
  type Phase,
} from "./state"

export type OptionalStepDef = {
  id: OptionalStepId
  /** When the planner should mark this step needed (criteria text, surfaced in the plan prompt). */
  appliesWhen: string
  /** The pipeline phase this step runs within (for dashboard lifecycle). */
  hostPhase: Phase
}

/** The single source of registered optional steps, as a TOTAL map over OptionalStepId so the
 *  COMPILER enforces that every id has an entry (no runtime sync test needed). Adding a future
 *  optional step (e.g. design review) = add the id to `optionalStepIdSchema` (state.ts) + a schema
 *  key + an entry here; prompts/dashboard/shared-resolution then derive from this map. (The
 *  concrete runtime step still needs a one-time host-phase hook — see Risks in the plan.) */
export const OPTIONAL_STEPS: Record<OptionalStepId, OptionalStepDef> = {
  e2e: {
    id: "e2e",
    appliesWhen:
      "the change exercises behavior that unit tests can't fully cover — UI flows, " +
      "integration paths, or anything that warrants driving the running app. A change " +
      "fully covered by unit tests (e.g. a pure-backend change with no user-facing " +
      "surface) does NOT need e2e.",
    hostPhase: "validate",
  },
  evals: {
    id: "evals",
    appliesWhen:
      "the change adds or modifies any text fed to a model — a connector " +
      "system-prompt section, the assembled agent system prompt " +
      "(apps/web/src/lib/agent/system-prompt.ts), a default/seeded user-space or " +
      "automation prompt, the permission-agent prompt, or a judge/scorer rubric. " +
      "A change that touches no model-facing text (pure backend/UI/refactor with " +
      "no prompt delta) does NOT need evals.",
    hostPhase: "validate",
  },
}

/** Iteration helper (registry is a keyed map, not a list — use this anywhere you'd `.map`). */
export const optionalStepDefs = (): OptionalStepDef[] =>
  Object.values(OPTIONAL_STEPS)

export type OptionalStepIntent = { needed: boolean; skipReason?: string }

/** Override > decision, fail-safe to needed. (pure) */
export function resolveOptionalStepIntent(
  decision: OptionalStepDecision | undefined,
  override: "on" | "off" | undefined,
): OptionalStepIntent {
  if (override === "off") return { needed: false, skipReason: "forced off" }
  const needed = override === "on" ? true : (decision?.needed ?? true)
  return needed ? { needed: true } : { needed: false, skipReason: "not needed" }
}

export type OptionalStepOutcome =
  | { state: "needed" }
  | { state: "skipped"; reason: string }
  | { state: "blocked"; reason: string }

/** Full gating decision incl. infra. (pure) */
export function resolveOptionalStep(args: {
  def: OptionalStepDef
  decision: OptionalStepDecision | undefined
  override: "on" | "off" | undefined
  infraAvailable: boolean
}): OptionalStepOutcome {
  const intent = resolveOptionalStepIntent(args.decision, args.override)
  if (!intent.needed)
    return { state: "skipped", reason: intent.skipReason as string }
  if (args.infraAvailable) return { state: "needed" }
  return {
    state: "blocked",
    reason:
      `the "${args.def.id}" optional step is needed but its required infrastructure ` +
      "is unavailable; wire it up, or force the step off, then re-run",
  }
}

/** Resolve a human override for `id` from PERSISTED state only (no env — env is normalized
 *  into optionalStepOverrides at startup; see normalizeEnvOverrides). (pure) */
export function resolveOverride(
  id: OptionalStepId,
  overrides: OptionalStepOverrides | undefined,
): "on" | "off" | undefined {
  return overrides?.[id]
}

export type OptionalStepLifecycle = "pending" | "running" | "done"

/** Coarse lifecycle from the host phase vs the current phase, using PHASES order. (pure) */
export function optionalStepLifecycle(
  host: Phase,
  current: Phase,
): OptionalStepLifecycle {
  const ci = PHASES.indexOf(current)
  const hi = PHASES.indexOf(host)
  if (ci < hi) return "pending"
  if (ci === hi) return "running"
  return "done"
}

export type OptionalStepView =
  | { id: OptionalStepId; status: OptionalStepLifecycle }
  | { id: OptionalStepId; status: "skipped"; reason: string }

/** Per-step view for the dashboard — purely from persisted state, no infra. Overrides come from
 *  `optionalStepOverrides` (state.json), into which the legacy `BUILD_SKIP_E2E=1` env has already
 *  been normalized at startup — so a force-off IS reflected here. The dashboard is a separate
 *  process; it never reads env. (pure) */
export function optionalStepViews(args: {
  phase: Phase
  optionalSteps?: OptionalStepsDeclaration
  optionalStepOverrides?: OptionalStepOverrides
}): OptionalStepView[] {
  return optionalStepDefs().map((def) => {
    const intent = resolveOptionalStepIntent(
      args.optionalSteps?.[def.id],
      args.optionalStepOverrides?.[def.id], // state-only; env already normalized in
    )
    if (!intent.needed)
      return {
        id: def.id,
        status: "skipped" as const,
        reason: intent.skipReason as string,
      }
    return {
      id: def.id,
      status: optionalStepLifecycle(def.hostPhase, args.phase),
    }
  })
}

/** Parse the plan agent's optional-steps.json into a typed declaration; null when missing,
 *  malformed JSON, or schema-invalid (incl. unknown ids, thanks to z.strictObject). Caller fails
 *  safe to "run all" on null. (pure given the string) */
export function parseOptionalStepsDeclaration(
  raw: string | null,
): OptionalStepsDeclaration | null {
  if (raw == null) return null
  try {
    return optionalStepsSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Build-dir-relative filename the plan agent writes / orchestrator reads. */
export const OPTIONAL_STEPS_FILENAME = "optional-steps.json"
