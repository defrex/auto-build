/**
 * The evals sub-pipeline: a deliberate plan → plan-feedback → execute flow that
 * runs inside the validate gate (see `bin/build/orchestrator.ts` `makeEvals`).
 * Mirrors `bin/build/e2e.ts` 1:1 — a bounded plan↔feedback loop that never blocks
 * on a human (`ensureEvalPlan`), and an execute-always run under an infra guard
 * (`runEvalExecute`) — swapping the browser/dev-server infra for Convex-dev +
 * model-API-keys, and "drive flows → screenshots" for "ensure coverage → run
 * subset → compare baseline".
 *
 * The gate (`evaluateEvalRegression`) compares THREE per-case score maps:
 *   - `baselineBefore` — the baseline as committed on `origin/<base>` (resolved
 *     upstream in `makeEvals`, immune to any in-build edit — the anti-bypass
 *     reference);
 *   - `produced` — this run's per-case `averageScore`, from Evalite's
 *     `--outputPath` JSON;
 *   - `baselineAfter` — the working-tree `baselines.json` this build refreshed.
 *
 * All the loop + gate logic is dependency-injected pure-ish functions so it is
 * unit-testable without spawning subprocesses or touching evalite/Convex/git.
 */

import {
  type EvalScores,
  parseEvalRunScores,
} from "../../apps/web/evals/lib/eval-scores"
import type { CheckResult } from "./validate"
import type {
  BuilderVerdict,
  EvalExecuteVerdict,
  PlanReviewVerdict,
} from "./verdicts"
import { parseEvalReportVerdict } from "./verdicts"

// Re-export the shared pure helpers so `bin/build` consumers have a single
// import site (the orchestrator wires `readBaselineFile` / `parseEvalRunScores`).
export {
  type BaselineDriftRow,
  computeBaselineDrift,
  type EvalScores,
  parseEvalRunScores,
  readBaselineFile,
  readRequiredCases,
} from "../../apps/web/evals/lib/eval-scores"

/** Max plan revisions before proceeding with the best plan (never blocks). */
export const EVAL_PLAN_REVISION_CAP = 2

/**
 * Per-case absolute margin absorbing run-to-run LLM-judge noise. A produced
 * score must fall MORE than this below a reference before it counts as a
 * regression / under-baseline. Tunable v1 default (spec §"noise threshold is a
 * tunable default").
 */
export const EVAL_REGRESSION_MARGIN = 0.15

/**
 * Absolute quality bar a NEWLY-authored case (one absent from `baselineBefore`)
 * must clear. The relative checks (regression vs main; consistency vs the
 * agent-committed `baselineAfter`) don't stop a new case from passing at a
 * genuinely low score as long as the agent honestly baselines that low score;
 * this is the absolute "clears its own scorers" bar the spec requires. Scoped to
 * NEW cases so it never bounces a pre-existing case that legitimately scores low.
 * Tunable v1 default.
 */
export const EVAL_NEW_CASE_SCORE_FLOOR = 0.6

/** Persisted record that the bounded plan↔feedback loop completed. */
export type EvalPlanState = {
  decision:
    | "approved" // reviewer APPROVED the plan
    | "revision-cap" // hit the bounded revision cap; proceeding with best plan
    | "reviewer-escalated" // reviewer emitted ESCALATE; proceeding with best plan
    | "reviewer-no-verdict" // reviewer produced no parseable verdict; proceeding
    | "fallback" // planner produced no artifact; installed fallback plan
  /**
   * Snapshot of the plan-reviewed required case patterns, read from
   * `eval-required-cases.json` at plan-completion time. The GATE reads the
   * required set from THIS marker (not the mutable working-tree JSON), so the
   * execute agent — which rewrites files this build — cannot shrink the required
   * set to exactly what it happened to run. Same tamper-resistance the
   * `git show origin/<base>` baseline gives the regression reference.
   */
  requiredCases: string[]
}

export type EnsureEvalPlanDeps = {
  /** True once the durable completion marker (`.build/eval-plan-state.json`) exists. */
  completionExists: () => boolean
  /** True once an `eval-plan.md` artifact exists on disk. */
  planExists: () => boolean
  /** Author/revise the plan. `revising` is true when a prior critique informs this pass. */
  runPlan: (revising: boolean) => Promise<BuilderVerdict>
  /** Critique the current plan; `null` when no parseable verdict was produced. */
  runPlanReview: () => Promise<PlanReviewVerdict | null>
  /** Write a minimal fallback `eval-plan.md` when the planner produced none. */
  writeFallbackPlan: (reason: string) => void
  /**
   * Snapshot the plan-reviewed required patterns at completion time (read from
   * the working-tree `eval-required-cases.json`). Called once, right before
   * `markComplete`, so the marker freezes the reviewed required set before the
   * execute agent can touch the working-tree JSON.
   */
  readRequiredCasesForSnapshot: () => string[]
  /** Persist the completion marker with the final decision + required-case snapshot. */
  markComplete: (state: EvalPlanState) => void
  log: (msg: string) => void
  maxRevisions?: number
}

/**
 * Plan-once: bounded plan↔feedback loop. Never blocks on a human. Structurally
 * identical to `ensureE2ePlan`, plus a `requiredCases` snapshot folded into the
 * completion marker so the gate can trust an immutable required set.
 *
 * Reuse is gated on the durable COMPLETION MARKER, not on `eval-plan.md` alone,
 * so a run that wrote a plan but crashed before feedback will, on resume, run the
 * feedback loop from that artifact rather than skipping straight to execute.
 */
export async function ensureEvalPlan(deps: EnsureEvalPlanDeps): Promise<void> {
  const complete = (decision: EvalPlanState["decision"]): void =>
    deps.markComplete({
      decision,
      requiredCases: deps.readRequiredCasesForSnapshot(),
    })

  if (deps.completionExists() && deps.planExists()) {
    deps.log("evals: reusing completed plan")
    return
  }
  const max = deps.maxRevisions ?? EVAL_PLAN_REVISION_CAP

  // Resume case: a prior run wrote `eval-plan.md` but never completed feedback.
  let needPlan = !deps.planExists()

  for (let attempt = 0; attempt <= max; attempt++) {
    if (needPlan) {
      const verdict = await deps.runPlan(attempt > 0)
      if (!deps.planExists()) {
        const reason =
          verdict.kind === "escalate"
            ? verdict.reason
            : "planner produced no eval-plan.md"
        deps.writeFallbackPlan(reason)
        complete("fallback")
        deps.log(`evals: no plan written (${reason}); installed fallback plan`)
        return
      }
    }
    needPlan = true // any subsequent iteration must regenerate via revising

    const review = await deps.runPlanReview()
    if (!review) {
      complete("reviewer-no-verdict")
      deps.log(
        "evals: plan review produced no verdict; proceeding with best plan",
      )
      return
    }
    if (review.kind === "approved") {
      complete("approved")
      return
    }
    if (review.kind === "escalate") {
      complete("reviewer-escalated")
      deps.log("evals: plan review escalated; proceeding with best plan")
      return
    }
    // needs_revision → loop (bounded by `max`)
  }
  complete("revision-cap")
  deps.log("evals: plan revision cap reached; proceeding with best plan")
}

/** The regression/coverage gate result. `ok` iff no run was empty and every list is empty. */
export type EvalRegressionResult = {
  ok: boolean
  /** `produced` is empty — a prompt changed but no case ran. */
  emptyRun: boolean
  /** `required` patterns that matched no produced case. */
  missingCoverage: string[]
  /** existing cases (∈ baselineBefore) whose produced score dropped beyond margin vs main. */
  regressions: string[]
  /** produced cases absent from `baselineAfter` (the agent ran a case but committed no baseline entry). */
  missingBaseline: string[]
  /** produced cases below their `baselineAfter` entry beyond margin (aspirational baseline). */
  underBaseline: string[]
  /** NEW cases (∉ baselineBefore) whose produced score is below the absolute floor. */
  belowFloor: string[]
}

/**
 * The gate (see the module header + the plan's "The gate, precisely"). PURE.
 *
 * `ok = !emptyRun && every list empty`. `regressions` are measured against
 * `baselineBefore` (main's committed baseline), which is immutable to the
 * execute agent, so lowering the working-tree `baselineAfter` for a regressed
 * case cannot mask a regression. `belowFloor` is scoped to NEW cases only.
 */
export function evaluateEvalRegression(args: {
  produced: EvalScores
  baselineBefore: EvalScores
  baselineAfter: EvalScores
  required: string[]
  margin: number
  newCaseFloor: number
}): EvalRegressionResult {
  const {
    produced,
    baselineBefore,
    baselineAfter,
    required,
    margin,
    newCaseFloor,
  } = args
  const producedNames = Object.keys(produced)
  const emptyRun = producedNames.length === 0

  const missingCoverage = required.filter(
    (pattern) => !producedNames.some((name) => name.includes(pattern)),
  )

  const regressions: string[] = []
  const missingBaseline: string[] = []
  const underBaseline: string[] = []
  const belowFloor: string[] = []

  for (const name of producedNames) {
    const score = produced[name]
    // Regression vs main's committed baseline (the unbypassable reference).
    if (name in baselineBefore && score < baselineBefore[name] - margin) {
      regressions.push(name)
    }
    // Consistency vs the baseline the agent committed this build.
    if (!(name in baselineAfter)) {
      missingBaseline.push(name)
    } else if (score < baselineAfter[name] - margin) {
      underBaseline.push(name)
    }
    // Absolute floor for newly-authored cases (not governed by the vs-main check).
    if (!(name in baselineBefore) && score < newCaseFloor) {
      belowFloor.push(name)
    }
  }

  const ok =
    !emptyRun &&
    missingCoverage.length === 0 &&
    regressions.length === 0 &&
    missingBaseline.length === 0 &&
    underBaseline.length === 0 &&
    belowFloor.length === 0
  return {
    ok,
    emptyRun,
    missingCoverage,
    regressions,
    missingBaseline,
    underBaseline,
    belowFloor,
  }
}

/** A machine-checked per-case verdict row the gate appends to `eval-report.md`. */
export type EvalGateReport = {
  cases: {
    name: string
    before: number | null
    produced: number | null
    after: number | null
    verdict: string
  }[]
  margin: number
}

/**
 * Build the audit-trail table (base-branch baseline / produced / refreshed
 * baseline / per-case verdict) from the resolved gate inputs + result. PURE.
 */
export function buildEvalGateReport(args: {
  produced: EvalScores
  baselineBefore: EvalScores
  baselineAfter: EvalScores
  result: EvalRegressionResult
  margin: number
}): EvalGateReport {
  const { produced, baselineBefore, baselineAfter, result, margin } = args
  const names = new Set<string>([
    ...Object.keys(baselineBefore),
    ...Object.keys(produced),
    ...Object.keys(baselineAfter),
  ])
  const verdictFor = (name: string): string => {
    if (result.regressions.includes(name)) return "REGRESSION vs main"
    if (result.missingBaseline.includes(name)) return "no committed baseline"
    if (result.underBaseline.includes(name)) return "under committed baseline"
    if (result.belowFloor.includes(name)) return "below new-case floor"
    if (name in produced) return "ok"
    return "not run"
  }
  const cases = [...names].sort().map((name) => ({
    name,
    before: name in baselineBefore ? baselineBefore[name] : null,
    produced: name in produced ? produced[name] : null,
    after: name in baselineAfter ? baselineAfter[name] : null,
    verdict: verdictFor(name),
  }))
  return { cases, margin }
}

/** Compose the human-readable failure message itemizing each non-empty gate list. */
function evalGateFailureMessage(result: EvalRegressionResult): string {
  const parts: string[] = []
  if (result.emptyRun) {
    parts.push(
      "empty run: a prompt changed but no eval case produced a score (nothing ran, or the run JSON had no scored evals)",
    )
  }
  if (result.missingCoverage.length) {
    parts.push(
      `missing coverage: required case pattern(s) matched no produced case: ${result.missingCoverage.join(", ")}`,
    )
  }
  if (result.regressions.length) {
    parts.push(
      `regressions vs main (beyond margin): ${result.regressions.join(", ")}`,
    )
  }
  if (result.missingBaseline.length) {
    parts.push(
      `missing baseline entry (ran a case but committed no baselines.json entry): ${result.missingBaseline.join(", ")}`,
    )
  }
  if (result.underBaseline.length) {
    parts.push(
      `under committed baseline (beyond margin): ${result.underBaseline.join(", ")}`,
    )
  }
  if (result.belowFloor.length) {
    parts.push(`below new-case score floor: ${result.belowFloor.join(", ")}`)
  }
  return `evals regression/coverage gate failed:\n- ${parts.join("\n- ")}`
}

export type RunEvalExecuteDeps = {
  /**
   * The base branch's committed baseline, ALREADY RESOLVED upstream in
   * `makeEvals`. A plain value, not a reader: the escalate-vs-bootstrap decision
   * for an unreadable base ref is made BEFORE this runs (so a bad ref never costs
   * a paid run, and this module stays free of `EscalateError`). `{}` here means
   * the genuine bootstrap case (no baseline committed on base yet) — an
   * unreadable/malformed base baseline never reaches this function.
   * `origin/<base>` is immutable to the execute agent, so this snapshot is the
   * unbypassable regression reference.
   */
  baselineBefore: EvalScores
  /** Convex-dev guard: run the closure or throw an infra escalation upstream. */
  withConvex: <T>(run: () => Promise<T>) => Promise<T>
  /** Run the execute agent; parse its stdout `EVAL_PASS`/`EVAL_FAIL` sentinel (null when absent). */
  runExecute: () => Promise<EvalExecuteVerdict | null>
  /** Remove any `eval-report.md` a prior run left, BEFORE this run's agent runs (freshness). */
  clearReport: () => void
  /** Read the persisted `eval-report.md`; `null` when missing. */
  readReport: () => string | null
  /** Remove any `eval-run.json` a prior run left, BEFORE this run's agent runs (freshness). */
  clearRunJson: () => void
  /** Read the persisted `eval-run.json` contents; `null` when missing. */
  readRunJson: () => string | null
  /** Read the working-tree `apps/web/evals/baselines.json` → EvalScores (`{}` when absent). */
  readBaselineAfter: () => EvalScores
  /**
   * The plan-reviewed required patterns, read from the plan-completion MARKER
   * (`.build/eval-plan-state.json` → `EvalPlanState.requiredCases`), NOT the
   * mutable working-tree JSON — so execute can't shrink the required set.
   */
  readRequiredCases: () => string[]
  /** Remove any feature-local coverage artifact a prior run left, BEFORE this run (freshness). */
  clearFeatureArtifact: () => void
  /** Feature-local coverage gate (`assert-eval-coverage.ts`); no-op pass when absent. */
  runFeatureCoverageGate: () => { ok: boolean; output: string }
  /**
   * Whether the feature committed an explicit, deterministic coverage checker
   * (`assert-eval-coverage.ts`). This is the ONLY thing that can substitute for a
   * non-empty reviewed required-case snapshot: an empty required set with no
   * checker means the gate has no coverage contract to enforce, so a needed run
   * must fail rather than pass on any unrelated scored case.
   */
  hasFeatureCoverageGate: () => boolean
  margin: number
  newCaseFloor: number
  log: (msg: string) => void
  /** Optional: append the machine verdict table to `eval-report.md` for the audit trail. */
  writeReportGate?: (details: EvalGateReport) => void
}

/**
 * Execute-always: the eval run under the Convex-dev guard → `CheckResult`.
 * Mirrors `runE2eExecute`, with the corrected gate ordering: sentinel → report
 * present → run JSON present + parseable → regression/coverage gate →
 * feature-local coverage gate.
 */
export async function runEvalExecute(
  deps: RunEvalExecuteDeps,
): Promise<CheckResult> {
  // Clear prior artifacts up front so freshness is structural (same rationale as
  // e2e's clears; execute re-runs on every build↔validate revisit).
  deps.clearReport()
  deps.clearRunJson()
  deps.clearFeatureArtifact()

  const stdoutVerdict = await deps.withConvex(deps.runExecute)
  // A stdout EVAL_FAIL is authoritative and short-circuits before the report.
  if (stdoutVerdict !== null && stdoutVerdict.kind !== "pass") {
    return { name: "evals", ok: false, output: stdoutVerdict.reason }
  }
  const report = deps.readReport()
  const verdict =
    stdoutVerdict ?? (report !== null ? parseEvalReportVerdict(report) : null)
  if (verdict === null) {
    return {
      name: "evals",
      ok: false,
      output:
        "evals execute produced no EVAL_PASS/EVAL_FAIL sentinel in stdout or eval-report.md (incomplete or crashed run)",
    }
  }
  if (verdict.kind !== "pass") {
    // Only reachable via a report-fallback EVAL_FAIL — a stdout fail already returned.
    return { name: "evals", ok: false, output: verdict.reason }
  }
  // PASS requires the durable report artifact.
  if (report === null || report.trim().length === 0) {
    return {
      name: "evals",
      ok: false,
      output:
        "evals execute reported EVAL_PASS but no eval-report.md was written (the durable testing artifact is required)",
    }
  }
  // PASS requires the run JSON to exist. A missing file is its own explicit
  // failure; a present-but-empty produced set is caught as `emptyRun` below.
  const runJson = deps.readRunJson()
  if (runJson === null) {
    return {
      name: "evals",
      ok: false,
      output:
        "evals execute reported EVAL_PASS but no eval-run.json was written (the Evalite --outputPath JSON the gate re-checks is required)",
    }
  }
  const produced = parseEvalRunScores(runJson)
  const baselineAfter = deps.readBaselineAfter()
  const required = deps.readRequiredCases()
  const result = evaluateEvalRegression({
    produced,
    baselineBefore: deps.baselineBefore,
    baselineAfter,
    required,
    margin: deps.margin,
    newCaseFloor: deps.newCaseFloor,
  })
  // Append the machine verdict table to the report for the audit trail (finding 1).
  deps.writeReportGate?.(
    buildEvalGateReport({
      produced,
      baselineBefore: deps.baselineBefore,
      baselineAfter,
      result,
      margin: deps.margin,
    }),
  )
  if (!result.ok) {
    return { name: "evals", ok: false, output: evalGateFailureMessage(result) }
  }
  // Coverage-contract floor: a NEEDED evals run must carry SOME deterministic
  // proof the prompt change is covered — either a reviewed required-case snapshot
  // (`required`, from the immutable marker) or an explicit feature coverage
  // checker (`assert-eval-coverage.ts`). An empty/missing required set with no
  // checker (e.g. the fallback plan path, which writes no eval-required-cases.json)
  // leaves the gate with no coverage contract, so `missingCoverage` is vacuously
  // empty and the run could pass on any unrelated scored case. That would let a
  // prompt change with no associated eval case pass — which the spec forbids — so
  // fail here instead.
  if (required.length === 0 && !deps.hasFeatureCoverageGate()) {
    return {
      name: "evals",
      ok: false,
      output:
        "evals coverage contract missing: the reviewed required-case snapshot is empty and the feature commits no assert-eval-coverage.ts checker, so the gate cannot prove the prompt change is covered. Add an eval case and record it in eval-required-cases.json (re-run planning), or commit an explicit assert-eval-coverage.ts proving no prompt coverage is required.",
    }
  }
  // Feature-local coverage gate LAST (no-op pass when the feature commits none).
  const coverage = deps.runFeatureCoverageGate()
  if (!coverage.ok) {
    return { name: "evals", ok: false, output: coverage.output }
  }
  return { name: "evals", ok: true, output: "" }
}
