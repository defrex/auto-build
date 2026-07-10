/**
 * The e2e sub-pipeline: a deliberate plan → plan-feedback → execute flow that
 * runs inside the validate gate (see `bin/build/orchestrator.ts` `makeE2e`).
 *
 * - **plan-once** (`ensureE2ePlan`): a bounded plan↔plan-feedback loop, no dev
 *   server needed, that NEVER blocks on a human. Reuse is gated on a durable
 *   COMPLETION MARKER (not on `e2e-plan.md` existence alone), so a run that wrote
 *   a plan but crashed before feedback re-enters the loop on resume.
 * - **execute-always** (`runE2eExecute`): the browser run under the dev-server
 *   guard, producing a `CheckResult` for the validate gate.
 *
 * These are dependency-injected pure-ish functions so the loop logic is
 * unit-testable without spawning subprocesses or touching the network/fs.
 */

import type { CheckResult } from "./validate"
import type {
  BuilderVerdict,
  E2eExecuteVerdict,
  PlanReviewVerdict,
} from "./verdicts"
import { parseE2eReportVerdict } from "./verdicts"

/** Max plan revisions before proceeding with the best plan (never blocks). */
export const E2E_PLAN_REVISION_CAP = 2

/**
 * Sentinel a backend-only run records (on its OWN line) in `e2e-report.md` to
 * declare it has no user-facing UI surface, exempting it from the
 * verification-screenshot hard gate. Line-parsed (not a substring search) so
 * incidental prose mentioning the token does not trigger the exemption.
 */
export const NO_UI_SCREENSHOT_MARKER = "E2E_NO_UI_SURFACE"

/**
 * Surrounding markdown wrappers stripped from a line before marker matching. The
 * execute prompt itself models the marker inside a `` `code span` ``, so the
 * agent routinely emits `` `E2E_NO_UI_SURFACE: <reason>` `` verbatim; without
 * this the leading backtick made the declaration fail the gate.
 *
 * Leading class is wider than trailing: it also strips line-prefix markdown that
 * only appears at the start of a line — list bullets (`-`, `*`), blockquote (`>`)
 * and heading (`#`) markers — so an agent that writes the exemption as a bullet
 * (`- E2E_NO_UI_SURFACE: …`) or under a `>` quote still declares it. Trailing
 * class is just code-span/emphasis closers + whitespace; `-`/`>`/`#` are not
 * meaningful trailing wrappers. Anchored to the ends (`^…|…$`), so inner content
 * is untouched and a mid-sentence mention still fails the checks below.
 */
const MARKDOWN_LINE_WRAPPERS = /^[\s`*_>#-]+|[\s`*_]+$/g

/**
 * True iff the report DECLARES no UI surface: some line, with surrounding
 * markdown wrappers stripped, equals the bare marker or starts with
 * `` `${NO_UI_SCREENSHOT_MARKER}:` `` (the `E2E_NO_UI_SURFACE: <reason>` form).
 * Mirrors the `verdicts.ts` sentinel discipline (line-parsed) rather than
 * `String.includes`, so a mid-sentence mention ("this is not an
 * E2E_NO_UI_SURFACE situation") is NOT a declaration — stripping only the line's
 * outer wrappers leaves inner prose intact, so the equals/startsWith checks
 * still reject it.
 */
export function reportDeclaresNoUi(report: string): boolean {
  for (const raw of report.split("\n")) {
    const line = raw.replace(MARKDOWN_LINE_WRAPPERS, "")
    if (line === NO_UI_SCREENSHOT_MARKER) return true
    if (line.startsWith(`${NO_UI_SCREENSHOT_MARKER}:`)) return true
  }
  return false
}

/**
 * Verify every captured screenshot file is referenced inline in the report, so
 * the report reads as illustrated coverage (spec). A file is "referenced" when
 * the report contains the build-dir-relative path `screenshots/<file>` (the form
 * the execute prompt instructs the agent to embed) — anchored on the
 * `screenshots/` segment so an arbitrarily-deep build-dir-relative prefix also
 * matches, but a bare filename in prose does not. Returns the unreferenced files
 * in `missing`; an empty `files` list (backend-only path) is a no-op pass.
 */
export function reportReferencesScreenshots(
  report: string,
  files: string[],
): { ok: boolean; missing: string[] } {
  const missing = files.filter((f) => !report.includes(`screenshots/${f}`))
  return { ok: missing.length === 0, missing }
}

/** Persisted record that the bounded plan↔feedback loop completed. */
export type E2ePlanState = {
  decision:
    | "approved" // reviewer APPROVED the plan
    | "revision-cap" // hit the bounded revision cap; proceeding with best plan
    | "reviewer-escalated" // reviewer emitted ESCALATE; proceeding with best plan
    | "reviewer-no-verdict" // reviewer produced no parseable verdict; proceeding
    | "fallback" // planner produced no artifact; installed fallback plan
}

export type EnsureE2ePlanDeps = {
  /** True once the durable completion marker (e.g. `.build/e2e-plan-state.json`) exists. */
  completionExists: () => boolean
  /** True once an `e2e-plan.md` artifact exists on disk. */
  planExists: () => boolean
  /** Author/revise the plan. `revising` is true when a prior critique informs this pass. */
  runPlan: (revising: boolean) => Promise<BuilderVerdict>
  /** Critique the current plan; `null` when no parseable verdict was produced. */
  runPlanReview: () => Promise<PlanReviewVerdict | null>
  /** Write a minimal fallback `e2e-plan.md` when the planner produced none. */
  writeFallbackPlan: (reason: string) => void
  /** Persist the completion marker with the final decision. */
  markComplete: (state: E2ePlanState) => void
  log: (msg: string) => void
  maxRevisions?: number
}

/**
 * Plan-once: bounded plan↔feedback loop. Never blocks on a human.
 *
 * Reuse is gated on the durable COMPLETION MARKER, not on `e2e-plan.md` alone, so
 * a run that wrote a plan but crashed before plan-feedback will, on resume, run
 * the feedback loop from that artifact rather than skipping straight to execute.
 *
 * HARD POST-CONDITIONS on every non-skip return path:
 *   - `planExists()` is true (an artifact exists for execute to follow), AND
 *   - `completionExists()` is true (the loop is recorded as done).
 * Together these let the caller execute unconditionally afterward and let a
 * resume correctly reuse the result.
 */
export async function ensureE2ePlan(deps: EnsureE2ePlanDeps): Promise<void> {
  // Reuse only when the loop is recorded complete AND a plan artifact is present
  // (the && guards a corrupted state where the marker exists but the plan was
  // removed — re-derive rather than execute against a missing plan).
  if (deps.completionExists() && deps.planExists()) {
    deps.log("e2e: reusing completed plan")
    return
  }
  const max = deps.maxRevisions ?? E2E_PLAN_REVISION_CAP

  // Resume case: a prior run wrote `e2e-plan.md` but never completed feedback.
  // Do NOT regenerate it — review the existing artifact. Otherwise author it.
  let needPlan = !deps.planExists()

  for (let attempt = 0; attempt <= max; attempt++) {
    if (needPlan) {
      // revising iff a prior review artifact informs this authoring pass.
      const verdict = await deps.runPlan(attempt > 0)
      if (!deps.planExists()) {
        // Planner escalated or crashed WITHOUT writing a plan: no artifact to
        // review. Install a fallback (which makes execute derive flows from the
        // spec) and record completion. Once any prior iteration wrote a plan,
        // planExists() stays true even if a later revising pass fails, so we
        // keep the best plan we have and fall through to review.
        const reason =
          verdict.kind === "escalate"
            ? verdict.reason
            : "planner produced no e2e-plan.md"
        deps.writeFallbackPlan(reason)
        deps.markComplete({ decision: "fallback" })
        deps.log(`e2e: no plan written (${reason}); installed fallback plan`)
        return
      }
    }
    needPlan = true // any subsequent iteration must regenerate via revising

    const review = await deps.runPlanReview()
    if (!review) {
      deps.markComplete({ decision: "reviewer-no-verdict" })
      deps.log(
        "e2e: plan review produced no verdict; proceeding with best plan",
      )
      return
    }
    if (review.kind === "approved") {
      deps.markComplete({ decision: "approved" })
      return
    }
    if (review.kind === "escalate") {
      deps.markComplete({ decision: "reviewer-escalated" })
      deps.log("e2e: plan review escalated; proceeding with best plan")
      return
    }
    // needs_revision → loop (bounded by `max`)
  }
  deps.markComplete({ decision: "revision-cap" })
  deps.log("e2e: plan revision cap reached; proceeding with best plan")
}

export type RunE2eExecuteDeps = {
  /**
   * Run the execute agent and parse its **stdout** sentinel. `null` means stdout
   * carried no `E2E_PASS`/`E2E_FAIL` sentinel — `runE2eExecute` then falls back
   * to the durable `e2e-report.md`'s terminal verdict line before parking.
   */
  runExecute: (devUrl: string) => Promise<E2eExecuteVerdict | null>
  withDevServer: <T>(run: (devUrl: string) => Promise<T>) => Promise<T>
  /**
   * Remove any `e2e-report.md` left by a PRIOR execute run, BEFORE this run's
   * agent is invoked. execute re-runs on every build↔validate revisit, so a
   * stale non-empty report (e.g. from an earlier FAIL run) must not survive
   * into this run — otherwise a PASS that crashes before rewriting the report
   * would be honored against the old run's artifact. Clearing first makes a
   * stale report unrepresentable: `readReport` can only observe what THIS run
   * wrote.
   */
  clearReport: () => void
  /**
   * Read the persisted `e2e-report.md`; return `null` when it is missing.
   * The report is the durable testing artifact this feature exists to produce,
   * so a PASS is only honored when a non-empty report was actually written.
   */
  readReport: () => string | null
  /**
   * Remove any screenshots a PRIOR execute run left, BEFORE this run's agent
   * runs. Same freshness rationale as `clearReport`: execute re-runs on every
   * build↔validate revisit, so a stale screenshot set (e.g. from an earlier run
   * that exercised different flows) must not survive into this run and be
   * mistaken for THIS run's evidence. Clearing first makes a stale set
   * unrepresentable: `listScreenshots` can only observe what THIS run wrote.
   */
  clearScreenshots: () => void
  /**
   * List image files committed for THIS run under
   * `build/<feature>/screenshots/`. Empty when the agent captured none (the
   * count gate then requires the backend-only exemption marker).
   */
  listScreenshots: () => string[]
  /**
   * Deterministic marketing gate: after a PASS with verification evidence,
   * confirm every featured changelog section THIS build introduced references an
   * existing `/changelog/<name>.png`. Inspects git diff + files only (no browser
   * / dev server), so it is allowed under the spec's capture-in-execute
   * constraint. `problems` describes each unwired/missing marketing screenshot;
   * empty ⇒ satisfied (or no featured section introduced ⇒ no requirement).
   */
  checkMarketingScreenshots: () => { ok: boolean; problems: string[] }
  /**
   * Remove any feature-local coverage artifact (`build/<feature>/
   * e2e-artifact.json`) a PRIOR execute run left, BEFORE this run's agent runs.
   * Same freshness rationale as `clearReport`/`clearScreenshots`: a feature
   * checker (`assert-e2e-coverage.ts`) asserts the REAL values the executor
   * captured into this JSON, but the file travels with the PR (it is committed
   * alongside the report/screenshots). Without clearing, a later run could emit
   * a fresh `E2E_PASS` + report + screenshot yet never rewrite the JSON, and the
   * coverage gate would validate STALE committed values. Clearing first makes
   * that unrepresentable: the checker's missing-artifact guard fails unless THIS
   * run's executor recreated it, so the gate can only ever pass against values
   * THIS run captured. A no-op when the feature commits no checker/artifact.
   */
  clearFeatureArtifact: () => void
  /**
   * Feature-local coverage gate: when `build/<feature>/assert-e2e-coverage.ts`
   * exists, the orchestrator runs it (via `bun`) AFTER the report/screenshot/
   * marketing artifacts are produced and returns its outcome. A feature that
   * commits no checker is a no-op pass (`{ ok: true }`), so this never affects
   * other builds. Runs LAST so the JSON artifact the checker reads is
   * guaranteed to have been produced by THIS run's verified-PASS execute (and,
   * via `clearFeatureArtifact` above, can only reflect THIS run's capture).
   */
  runFeatureCoverageGate: () => { ok: boolean; output: string }
}

/** Execute-always: browser run under the dev-server guard → CheckResult. */
export async function runE2eExecute(
  deps: RunE2eExecuteDeps,
): Promise<CheckResult> {
  // Clear any prior run's report, screenshots AND feature coverage artifact up
  // front so freshness is structural: the only way `readReport`/
  // `listScreenshots`/the coverage gate's JSON reflect content below is for THIS
  // run's agent to have produced it. See `clearReport`/`clearScreenshots`/
  // `clearFeatureArtifact` above.
  deps.clearReport()
  deps.clearScreenshots()
  deps.clearFeatureArtifact()
  const stdoutVerdict = await deps.withDevServer(deps.runExecute)
  // A stdout E2E_FAIL is authoritative and short-circuits BEFORE the report is
  // read: a fail verdict must not inspect the screenshot/marketing gates, and
  // there is no reason to consult the report fallback when stdout already spoke.
  if (stdoutVerdict !== null && stdoutVerdict.kind !== "pass") {
    return { name: "e2e", ok: false, output: stdoutVerdict.reason }
  }
  // Read the report once, now that stdout is `null` or `pass`. It feeds both the
  // verdict fallback (below) and the artifact gates further down.
  const report = deps.readReport()
  // stdout sentinel is primary; when absent (`null`), fall back to the report's
  // TERMINAL verdict line (`parseE2eReportVerdict`, not the looser stdout
  // "last sentinel wins"). The durable report already carries the verdict — a
  // free-form last stdout line must not throw away a passing run, but a
  // half-written report (sentinel followed by prose) must NOT count as a pass.
  const verdict =
    stdoutVerdict ?? (report !== null ? parseE2eReportVerdict(report) : null)
  if (verdict === null) {
    // Neither stdout nor the report's terminal line carried a sentinel: an
    // incomplete or crashed run with no durable verdict to honor.
    return {
      name: "e2e",
      ok: false,
      output:
        "e2e execute produced no E2E_PASS/E2E_FAIL sentinel in stdout or e2e-report.md (incomplete or crashed run)",
    }
  }
  if (verdict.kind !== "pass") {
    // Only reachable via a report-fallback E2E_FAIL — a stdout fail already
    // returned above.
    return { name: "e2e", ok: false, output: verdict.reason }
  }
  // A PASS sentinel is necessary but not sufficient: the execute contract also
  // requires the durable `e2e-report.md`. If the agent emitted E2E_PASS but
  // crashed before writing it, wrote it to the wrong path, or omitted it, the
  // PR would lack the artifact the feature is meant to produce — treat that as
  // an e2e failure that routes back to the builder via the validate gate.
  if (report === null || report.trim().length === 0) {
    return {
      name: "e2e",
      ok: false,
      output:
        "e2e execute reported E2E_PASS but no e2e-report.md was written (the durable testing artifact is required)",
    }
  }
  // Verification-screenshot count gate: a UI feature must evidence at least one
  // screenshot; a genuinely headless change is exempt only when it records the
  // backend-only marker line in the report (no silent skip). Mirrors the
  // report-non-empty gate above.
  const shots = deps.listScreenshots()
  if (shots.length === 0 && !reportDeclaresNoUi(report)) {
    return {
      name: "e2e",
      ok: false,
      output:
        "e2e execute reported E2E_PASS but captured no verification screenshot " +
        "and recorded no backend-only exemption. A UI feature must evidence at " +
        "least one screenshot under build/<feature>/screenshots/; a headless " +
        `change must record a '${NO_UI_SCREENSHOT_MARKER}: <reason>' line in ` +
        "e2e-report.md.",
    }
  }
  // Report-reference gate: every captured screenshot must be referenced inline
  // in the report, so the report reads as illustrated coverage and ties each
  // shot to the flow it evidences. A no-op pass when `shots` is empty (the
  // backend-only exemption path), so it never blocks a headless change.
  const refs = reportReferencesScreenshots(report, shots)
  if (!refs.ok) {
    return {
      name: "e2e",
      ok: false,
      output:
        "e2e execute reported E2E_PASS and captured verification screenshots, " +
        "but e2e-report.md does not reference them inline (the report must tie " +
        "each shot to the flow it evidences). Unreferenced: " +
        refs.missing.map((f) => `screenshots/${f}`).join(", "),
    }
  }
  // Marketing gate (deterministic): a featured changelog section this build
  // introduced must wire in an existing /changelog/<name>.png. Surfaced after
  // the verification gates so a UI failure reads first. Inspects git diff +
  // files only — no browser/dev server — so it is allowed under the spec's
  // capture-in-execute constraint.
  const marketing = deps.checkMarketingScreenshots()
  if (!marketing.ok) {
    return {
      name: "e2e",
      ok: false,
      output:
        "e2e execute reported E2E_PASS but a featured changelog section this " +
        "build introduced is missing its required marketing screenshot:\n" +
        marketing.problems.join("\n"),
    }
  }
  // Feature-local coverage gate (deterministic): run LAST, only after a PASS +
  // report + screenshots + marketing all hold, so the JSON artifact the checker
  // reads is guaranteed to have been produced by THIS verified run. A feature
  // that commits no `assert-e2e-coverage.ts` is a no-op pass, so this never
  // affects builds that don't opt in.
  const coverage = deps.runFeatureCoverageGate()
  if (!coverage.ok) {
    return { name: "e2e", ok: false, output: coverage.output }
  }
  return { name: "e2e", ok: true, output: "" }
}
