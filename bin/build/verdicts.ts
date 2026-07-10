/**
 * Verdict parsing for build phases.
 *
 * Each phase ends by emitting a sentinel line the orchestrator parses to decide
 * the transition. Builder phases emit `PLAN_DONE` / `BUILD_DONE` / `ESCALATE: <reason>`;
 * the plan-review phase emits `APPROVED` / `NEEDS_REVISION` / `ESCALATE`; the
 * code-review phase emits `CLEAN` / `BLOCKING` / `ESCALATE`. The last matching
 * line wins, so trailing summary prose before the sentinel is fine.
 */

export type BuilderVerdict =
  | { kind: "done" }
  | { kind: "escalate"; reason: string }

export type PlanReviewVerdict =
  | { kind: "approved" }
  | { kind: "needs_revision" }
  | { kind: "escalate"; reason: string }

export type CodeReviewVerdict =
  | { kind: "clean" }
  | { kind: "blocking" }
  | { kind: "escalate"; reason: string }

export type E2eExecuteVerdict =
  | { kind: "pass" }
  | { kind: "fail"; reason: string }

export type EvalExecuteVerdict =
  | { kind: "pass" }
  | { kind: "fail"; reason: string }

/**
 * Normalise a line before sentinel matching: strip an optional `Verdict:`
 * label (with optional markdown bold) and surrounding markdown emphasis or
 * code backticks. Reviewers (e.g. codex) phrase their summary as
 * "Verdict: `BLOCKING`" rather than a bare sentinel line, so without this a
 * legitimate verdict in the final message / stdout is missed and the run
 * false-parks. The round file's bare sentinel still parses unchanged.
 */
function normalizeSentinelLine(line: string): string {
  return line
    .trim()
    .replace(/^[`*\s]*verdict[`*\s]*:[`*\s]*/i, "")
    .replace(/^[`*]+/, "")
    .replace(/[`*]+$/, "")
    .trim()
}

/**
 * Find the last line that is exactly one of `tokens`, or begins with
 * `<token>:` (the `ESCALATE: <reason>` form). Lines are normalised first (see
 * `normalizeSentinelLine`) so a `Verdict: `TOKEN`` summary line also matches.
 * Returns the matched token and the trailing text after a colon, if any.
 */
function lastSentinel(
  output: string,
  tokens: readonly string[],
): { token: string; rest: string } | null {
  const lines = output.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = normalizeSentinelLine(lines[i])
    for (const token of tokens) {
      if (line === token) return { token, rest: "" }
      if (line.startsWith(`${token}:`)) {
        return { token, rest: line.slice(token.length + 1).trim() }
      }
    }
  }
  return null
}

/**
 * Parse a builder phase's output. `doneToken` is `PLAN_DONE` for the plan phase
 * and `BUILD_DONE` for build/response phases. Returns `null` if no sentinel was
 * emitted (treated by the orchestrator as an incomplete run / failure).
 */
export function parseBuilderVerdict(
  output: string,
  doneToken: "PLAN_DONE" | "BUILD_DONE",
): BuilderVerdict | null {
  const match = lastSentinel(output, [doneToken, "ESCALATE"])
  if (!match) return null
  if (match.token === "ESCALATE") {
    return { kind: "escalate", reason: match.rest || "no reason given" }
  }
  return { kind: "done" }
}

/** Parse the plan-review reviewer's verdict. `null` if no sentinel was emitted. */
export function parsePlanReviewVerdict(
  output: string,
): PlanReviewVerdict | null {
  const match = lastSentinel(output, ["APPROVED", "NEEDS_REVISION", "ESCALATE"])
  if (!match) return null
  switch (match.token) {
    case "APPROVED":
      return { kind: "approved" }
    case "NEEDS_REVISION":
      return { kind: "needs_revision" }
    default:
      return { kind: "escalate", reason: match.rest || "no reason given" }
  }
}

/**
 * Parse the e2e execute stage's verdict from the agent's **stdout**. `E2E_PASS`
 * means every exercisable flow passed (untestable flows were skipped + recorded);
 * `E2E_FAIL: <reason>` means an exercisable flow is broken (a real defect in the
 * diff under review). `null` if no sentinel was emitted (the caller then falls
 * back to the durable `e2e-report.md`).
 *
 * This is the "last sentinel wins" parser: it scans upward and accepts an
 * `E2E_PASS`/`E2E_FAIL` line even when non-sentinel prose follows it, which is the
 * right rule for free-form stdout. The **report** fallback instead uses the
 * stricter terminal-line `parseE2eReportVerdict` (the sentinel must be the report's
 * last non-empty line), so a half-written report can't be mistaken for a pass.
 */
export function parseE2eExecuteVerdict(
  output: string,
): E2eExecuteVerdict | null {
  const match = lastSentinel(output, ["E2E_PASS", "E2E_FAIL"])
  if (!match) return null
  return match.token === "E2E_PASS"
    ? { kind: "pass" }
    : { kind: "fail", reason: match.rest || "no reason given" }
}

/**
 * Parse the e2e execute stage's verdict from the durable `e2e-report.md`
 * fallback source. Unlike `parseE2eExecuteVerdict` (free-form stdout, "last
 * sentinel wins"), this trusts ONLY the report's terminal verdict line: the
 * sentinel must be the LAST non-empty line of the report. A report that
 * contains an `E2E_PASS` line but continues with non-sentinel prose afterward
 * resolves to `null` (the report did not actually end with a verdict), so a
 * half-written report cannot be mistaken for a pass. Returns `null` when the
 * last non-empty line is not a recognized sentinel.
 */
export function parseE2eReportVerdict(
  report: string,
): E2eExecuteVerdict | null {
  const lines = report.split("\n")
  let last = ""
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      last = lines[i]
      break
    }
  }
  return parseE2eExecuteVerdict(last)
}

/**
 * Parse the evals execute stage's verdict from the agent's **stdout**. `EVAL_PASS`
 * means the relevant/new cases cleared their scorers and no regression beyond the
 * noise margin was detected; `EVAL_FAIL: <reason>` means a case regressed, missed
 * coverage, or failed its own scorers. `null` if no sentinel was emitted (the
 * caller then falls back to the durable `eval-report.md`).
 *
 * "Last sentinel wins" (scan upward), the right rule for free-form stdout. The
 * report fallback uses the stricter terminal-line `parseEvalReportVerdict`.
 */
export function parseEvalExecuteVerdict(
  output: string,
): EvalExecuteVerdict | null {
  const match = lastSentinel(output, ["EVAL_PASS", "EVAL_FAIL"])
  if (!match) return null
  return match.token === "EVAL_PASS"
    ? { kind: "pass" }
    : { kind: "fail", reason: match.rest || "no reason given" }
}

/**
 * Parse the evals execute stage's verdict from the durable `eval-report.md`
 * fallback source. Trusts ONLY the report's terminal verdict line: the sentinel
 * must be the LAST non-empty line. A report that contains an `EVAL_PASS` line but
 * continues with non-sentinel prose afterward resolves to `null`, so a
 * half-written report cannot be mistaken for a pass. Mirrors
 * `parseE2eReportVerdict`.
 */
export function parseEvalReportVerdict(
  report: string,
): EvalExecuteVerdict | null {
  const lines = report.split("\n")
  let last = ""
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) {
      last = lines[i]
      break
    }
  }
  return parseEvalExecuteVerdict(last)
}

/** Parse the code-review reviewer's verdict. `null` if no sentinel was emitted. */
export function parseCodeReviewVerdict(
  output: string,
): CodeReviewVerdict | null {
  const match = lastSentinel(output, ["CLEAN", "BLOCKING", "ESCALATE"])
  if (!match) return null
  switch (match.token) {
    case "CLEAN":
      return { kind: "clean" }
    case "BLOCKING":
      return { kind: "blocking" }
    default:
      return { kind: "escalate", reason: match.rest || "no reason given" }
  }
}
