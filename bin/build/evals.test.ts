import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  buildEvalGateReport,
  type EnsureEvalPlanDeps,
  type EvalPlanState,
  type EvalScores,
  ensureEvalPlan,
  evaluateEvalRegression,
  parseEvalRunScores,
  type RunEvalExecuteDeps,
  runEvalExecute,
} from "./evals"
import type { BuilderVerdict, PlanReviewVerdict } from "./verdicts"

/** Stateful fake for `ensureEvalPlan` deps — mirrors e2e's makeFakeDeps + requiredCases snapshot. */
function makeFakeDeps(opts: {
  planExistsInitial?: boolean
  completionExistsInitial?: boolean
  planVerdicts?: BuilderVerdict[]
  noWriteAttempts?: number[]
  reviewVerdicts?: (PlanReviewVerdict | null)[]
  maxRevisions?: number
  requiredSnapshot?: string[]
}) {
  let planWritten = opts.planExistsInitial ?? false
  let completed = opts.completionExistsInitial ?? false
  const calls = {
    runPlan: [] as boolean[],
    runPlanReview: 0,
    writeFallbackPlan: [] as string[],
    markComplete: [] as EvalPlanState[],
    readRequiredCasesForSnapshot: 0,
    log: [] as string[],
  }
  let planAttempt = 0
  let reviewAttempt = 0

  const deps: EnsureEvalPlanDeps = {
    completionExists: () => completed,
    planExists: () => planWritten,
    runPlan: async (revising) => {
      const idx = planAttempt++
      calls.runPlan.push(revising)
      const verdict = opts.planVerdicts?.[idx] ?? { kind: "done" }
      if (!opts.noWriteAttempts?.includes(idx)) planWritten = true
      return verdict
    },
    runPlanReview: async () => {
      const idx = reviewAttempt++
      calls.runPlanReview++
      return opts.reviewVerdicts && idx < opts.reviewVerdicts.length
        ? opts.reviewVerdicts[idx]
        : { kind: "approved" }
    },
    writeFallbackPlan: (reason) => {
      calls.writeFallbackPlan.push(reason)
      planWritten = true
    },
    readRequiredCasesForSnapshot: () => {
      calls.readRequiredCasesForSnapshot++
      return opts.requiredSnapshot ?? []
    },
    markComplete: (s) => {
      calls.markComplete.push(s)
      completed = true
    },
    log: (m) => calls.log.push(m),
    maxRevisions: opts.maxRevisions,
  }
  return { deps, calls, state: () => ({ planWritten, completed }) }
}

describe("ensureEvalPlan", () => {
  test("skips entirely when completion + plan both exist", async () => {
    const f = makeFakeDeps({
      planExistsInitial: true,
      completionExistsInitial: true,
    })
    await ensureEvalPlan(f.deps)
    expect(f.calls.runPlan).toHaveLength(0)
    expect(f.calls.runPlanReview).toBe(0)
    expect(f.calls.markComplete).toHaveLength(0)
  })

  test("APPROVED after iteration 0 → one plan + one review; snapshots requiredCases into marker", async () => {
    const f = makeFakeDeps({
      reviewVerdicts: [{ kind: "approved" }],
      requiredSnapshot: ["gmail/reply", "chat/x"],
    })
    await ensureEvalPlan(f.deps)
    expect(f.calls.runPlan).toEqual([false])
    expect(f.calls.runPlanReview).toBe(1)
    expect(f.calls.markComplete).toEqual([
      { decision: "approved", requiredCases: ["gmail/reply", "chat/x"] },
    ])
    expect(f.state().completed).toBe(true)
  })

  test("NEEDS_REVISION twice with cap 2 → 3 plans then revision-cap", async () => {
    const f = makeFakeDeps({
      maxRevisions: 2,
      reviewVerdicts: [
        { kind: "needs_revision" },
        { kind: "needs_revision" },
        { kind: "needs_revision" },
      ],
    })
    await ensureEvalPlan(f.deps)
    expect(f.calls.runPlan).toEqual([false, true, true])
    expect(f.calls.markComplete).toEqual([
      { decision: "revision-cap", requiredCases: [] },
    ])
  })

  test("resume: plan exists, no completion → review the artifact, do not regenerate", async () => {
    const f = makeFakeDeps({
      planExistsInitial: true,
      completionExistsInitial: false,
      reviewVerdicts: [{ kind: "approved" }],
    })
    await ensureEvalPlan(f.deps)
    expect(f.calls.runPlan).toHaveLength(0)
    expect(f.calls.runPlanReview).toBe(1)
    expect(f.calls.markComplete[0].decision).toBe("approved")
  })

  test("planner escalates without writing a plan → fallback installed, no review", async () => {
    const f = makeFakeDeps({
      planVerdicts: [{ kind: "escalate", reason: "no prompt delta found" }],
      noWriteAttempts: [0],
    })
    await ensureEvalPlan(f.deps)
    expect(f.calls.writeFallbackPlan).toEqual(["no prompt delta found"])
    expect(f.calls.runPlanReview).toBe(0)
    expect(f.calls.markComplete[0].decision).toBe("fallback")
  })

  test("planner done but writes no plan → fallback with default reason", async () => {
    const f = makeFakeDeps({
      planVerdicts: [{ kind: "done" }],
      noWriteAttempts: [0],
    })
    await ensureEvalPlan(f.deps)
    expect(f.calls.writeFallbackPlan).toEqual([
      "planner produced no eval-plan.md",
    ])
    expect(f.calls.markComplete[0].decision).toBe("fallback")
  })

  test("reviewer escalates → proceed with best plan, no fallback", async () => {
    const f = makeFakeDeps({
      reviewVerdicts: [{ kind: "escalate", reason: "ambiguous" }],
    })
    await ensureEvalPlan(f.deps)
    expect(f.calls.writeFallbackPlan).toHaveLength(0)
    expect(f.calls.markComplete[0].decision).toBe("reviewer-escalated")
  })

  test("reviewer returns no verdict → proceed with best plan", async () => {
    const f = makeFakeDeps({ reviewVerdicts: [null] })
    await ensureEvalPlan(f.deps)
    expect(f.calls.markComplete[0].decision).toBe("reviewer-no-verdict")
  })
})

describe("evaluateEvalRegression", () => {
  const base = {
    required: [],
    margin: 0.15,
    newCaseFloor: 0.6,
  }

  test("clean pass: produced matches baselines, coverage met", () => {
    const r = evaluateEvalRegression({
      ...base,
      produced: { a: 0.9 },
      baselineBefore: { a: 0.9 },
      baselineAfter: { a: 0.9 },
    })
    expect(r.ok).toBe(true)
  })

  test("regression vs baselineBefore beyond margin fails", () => {
    const r = evaluateEvalRegression({
      ...base,
      produced: { a: 0.6 },
      baselineBefore: { a: 0.9 },
      baselineAfter: { a: 0.6 },
    })
    expect(r.ok).toBe(false)
    expect(r.regressions).toEqual(["a"])
  })

  test("drop within margin (noise) passes", () => {
    const r = evaluateEvalRegression({
      ...base,
      produced: { a: 0.8 },
      baselineBefore: { a: 0.9 },
      baselineAfter: { a: 0.8 },
    })
    expect(r.ok).toBe(true)
    expect(r.regressions).toEqual([])
  })

  test("improvement passes", () => {
    const r = evaluateEvalRegression({
      ...base,
      produced: { a: 0.95 },
      baselineBefore: { a: 0.8 },
      baselineAfter: { a: 0.95 },
    })
    expect(r.ok).toBe(true)
  })

  test("produced case absent from baselineAfter → missingBaseline", () => {
    const r = evaluateEvalRegression({
      ...base,
      produced: { a: 0.9 },
      baselineBefore: {},
      baselineAfter: {},
    })
    expect(r.ok).toBe(false)
    expect(r.missingBaseline).toEqual(["a"])
  })

  test("produced < baselineAfter - margin → underBaseline", () => {
    const r = evaluateEvalRegression({
      ...base,
      produced: { a: 0.6 },
      baselineBefore: {},
      baselineAfter: { a: 0.9 },
    })
    expect(r.ok).toBe(false)
    expect(r.underBaseline).toEqual(["a"])
  })

  test("NEW case below newCaseFloor → belowFloor", () => {
    const r = evaluateEvalRegression({
      ...base,
      produced: { a: 0.5 },
      baselineBefore: {},
      baselineAfter: { a: 0.5 },
    })
    expect(r.ok).toBe(false)
    expect(r.belowFloor).toEqual(["a"])
  })

  test("new case at/above floor with matching committed baseline passes", () => {
    const r = evaluateEvalRegression({
      ...base,
      produced: { a: 0.65 },
      baselineBefore: {},
      baselineAfter: { a: 0.65 },
    })
    expect(r.ok).toBe(true)
  })

  test("empty produced → emptyRun fail", () => {
    const r = evaluateEvalRegression({
      ...base,
      produced: {},
      baselineBefore: { a: 0.9 },
      baselineAfter: { a: 0.9 },
    })
    expect(r.ok).toBe(false)
    expect(r.emptyRun).toBe(true)
  })

  test("required pattern matching no produced case → missingCoverage", () => {
    const r = evaluateEvalRegression({
      ...base,
      required: ["gmail/reply"],
      produced: { "chat/x": 0.9 },
      baselineBefore: {},
      baselineAfter: { "chat/x": 0.9 },
    })
    expect(r.ok).toBe(false)
    expect(r.missingCoverage).toEqual(["gmail/reply"])
  })

  test("required pattern matches via substring → coverage met", () => {
    const r = evaluateEvalRegression({
      ...base,
      required: ["reply"],
      produced: { "gmail/reply-to-thread": 0.9 },
      baselineBefore: { "gmail/reply-to-thread": 0.9 },
      baselineAfter: { "gmail/reply-to-thread": 0.9 },
    })
    expect(r.ok).toBe(true)
    expect(r.missingCoverage).toEqual([])
  })

  test("ANTI-BYPASS: agent lowered baselineAfter for a regressed case → STILL fails (vs baselineBefore)", () => {
    // The agent tried to mask a regression by rewriting the working-tree baseline
    // down to the produced score. baselineBefore (main's committed baseline) is
    // independent of the working tree, so the regression is still caught.
    const r = evaluateEvalRegression({
      ...base,
      produced: { a: 0.6 },
      baselineBefore: { a: 0.9 }, // main says 0.9
      baselineAfter: { a: 0.6 }, // agent lowered it to match the drop
    })
    expect(r.ok).toBe(false)
    expect(r.regressions).toEqual(["a"])
  })
})

describe("buildEvalGateReport", () => {
  test("renders before/produced/after + per-case verdict", () => {
    const produced: EvalScores = { a: 0.6, b: 0.9 }
    const baselineBefore: EvalScores = { a: 0.9 }
    const baselineAfter: EvalScores = { a: 0.6, b: 0.9 }
    const result = evaluateEvalRegression({
      produced,
      baselineBefore,
      baselineAfter,
      required: [],
      margin: 0.15,
      newCaseFloor: 0.6,
    })
    const report = buildEvalGateReport({
      produced,
      baselineBefore,
      baselineAfter,
      result,
      margin: 0.15,
    })
    const byName = Object.fromEntries(report.cases.map((c) => [c.name, c]))
    expect(byName.a).toEqual({
      name: "a",
      before: 0.9,
      produced: 0.6,
      after: 0.6,
      verdict: "REGRESSION vs main",
    })
    expect(byName.b.verdict).toBe("ok")
  })
})

describe("parseEvalRunScores (real fixture)", () => {
  test("extracts the expected case→score map from a real evalite --outputPath sample", () => {
    const fixture = readFileSync(
      join(import.meta.dir, "fixtures", "evalite-output-sample.json"),
      "utf-8",
    )
    const scores = parseEvalRunScores(fixture)
    // numeric averageScore preferred; recompute path (mean 0.7/0.9=0.8);
    // zero-scorer eval skipped.
    expect(scores).toEqual({
      "gmail/reply-to-thread": 0.92,
      "chat/summarize-inbox": 0.8,
    })
    expect(scores["calendar/no-scorer-run"]).toBeUndefined()
  })
})

/** Default deps for a `runEvalExecute` call: a clean passing run. */
function executeDeps(
  overrides: Partial<RunEvalExecuteDeps> = {},
): RunEvalExecuteDeps {
  return {
    baselineBefore: { "gmail/reply": 0.9 },
    withConvex: (run) => run(),
    runExecute: async () => ({ kind: "pass" }),
    clearReport: () => {},
    readReport: () => "# eval report\n\nran gmail/reply\n\nEVAL_PASS",
    clearRunJson: () => {},
    readRunJson: () =>
      JSON.stringify({
        evals: [
          {
            name: "gmail/reply",
            averageScore: 0.9,
            results: [{ scores: [{ score: 0.9 }] }],
          },
        ],
      }),
    readBaselineAfter: () => ({ "gmail/reply": 0.9 }),
    readRequiredCases: () => ["gmail/reply"],
    clearFeatureArtifact: () => {},
    runFeatureCoverageGate: () => ({ ok: true, output: "" }),
    hasFeatureCoverageGate: () => false,
    margin: 0.15,
    newCaseFloor: 0.6,
    log: () => {},
    ...overrides,
  }
}

describe("runEvalExecute", () => {
  test("clean pass → ok CheckResult; withConvex wraps runExecute", async () => {
    let wrapped = false
    const result = await runEvalExecute(
      executeDeps({
        withConvex: (run) => {
          wrapped = true
          return run()
        },
      }),
    )
    expect(wrapped).toBe(true)
    expect(result).toEqual({ name: "evals", ok: true, output: "" })
  })

  test("stdout EVAL_FAIL short-circuits (report not consulted)", async () => {
    let reportReads = 0
    const result = await runEvalExecute(
      executeDeps({
        runExecute: async () => ({ kind: "fail", reason: "case regressed" }),
        readReport: () => {
          reportReads++
          return "# report"
        },
      }),
    )
    expect(result).toEqual({
      name: "evals",
      ok: false,
      output: "case regressed",
    })
    expect(reportReads).toBe(0)
  })

  test("PASS but missing report → fail (artifact required)", async () => {
    const result = await runEvalExecute(executeDeps({ readReport: () => null }))
    expect(result.ok).toBe(false)
    expect(result.output).toContain("eval-report.md")
  })

  test("PASS but missing run JSON → fail", async () => {
    const result = await runEvalExecute(
      executeDeps({ readRunJson: () => null }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("eval-run.json")
  })

  test("PASS + empty produced → emptyRun fail", async () => {
    const result = await runEvalExecute(
      executeDeps({ readRunJson: () => JSON.stringify({ evals: [] }) }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("empty run")
  })

  test("PASS + regression vs baselineBefore → fail naming the case", async () => {
    const result = await runEvalExecute(
      executeDeps({
        baselineBefore: { "gmail/reply": 0.9 },
        readRunJson: () =>
          JSON.stringify({
            evals: [
              {
                name: "gmail/reply",
                averageScore: 0.6,
                results: [{ scores: [{ score: 0.6 }] }],
              },
            ],
          }),
        readBaselineAfter: () => ({ "gmail/reply": 0.6 }),
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("regressions")
    expect(result.output).toContain("gmail/reply")
  })

  test("PASS + missing coverage → fail", async () => {
    const result = await runEvalExecute(
      executeDeps({ readRequiredCases: () => ["chat/never-ran"] }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("missing coverage")
  })

  test("PASS + missing baseline entry → fail", async () => {
    const result = await runEvalExecute(
      executeDeps({ readBaselineAfter: () => ({}) }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("missing baseline")
  })

  test("PASS + below-floor NEW case → fail", async () => {
    const result = await runEvalExecute(
      executeDeps({
        baselineBefore: {},
        readRunJson: () =>
          JSON.stringify({
            evals: [
              {
                name: "gmail/reply",
                averageScore: 0.4,
                results: [{ scores: [{ score: 0.4 }] }],
              },
            ],
          }),
        readBaselineAfter: () => ({ "gmail/reply": 0.4 }),
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("floor")
  })

  test("no sentinel anywhere → fail", async () => {
    const result = await runEvalExecute(
      executeDeps({
        runExecute: async () => null,
        readReport: () => "# report with no verdict line",
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("no EVAL_PASS/EVAL_FAIL sentinel")
  })

  test("report fallback: stdout null but report ends EVAL_PASS → ok", async () => {
    const result = await runEvalExecute(
      executeDeps({ runExecute: async () => null }),
    )
    expect(result).toEqual({ name: "evals", ok: true, output: "" })
  })

  test("ANTI-BYPASS: agent lowered working-tree baseline → still fails (baselineBefore is from origin/base)", async () => {
    const result = await runEvalExecute(
      executeDeps({
        baselineBefore: { "gmail/reply": 0.9 }, // resolved from origin/<base>
        readRunJson: () =>
          JSON.stringify({
            evals: [
              {
                name: "gmail/reply",
                averageScore: 0.6,
                results: [{ scores: [{ score: 0.6 }] }],
              },
            ],
          }),
        readBaselineAfter: () => ({ "gmail/reply": 0.6 }), // agent lowered it
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("gmail/reply")
  })

  test("bootstrap: baselineBefore {} → no regressions possible; gated by coverage/floor/baseline only", async () => {
    const result = await runEvalExecute(
      executeDeps({
        baselineBefore: {},
        readRunJson: () =>
          JSON.stringify({
            evals: [
              {
                name: "gmail/reply",
                averageScore: 0.9,
                results: [{ scores: [{ score: 0.9 }] }],
              },
            ],
          }),
        readBaselineAfter: () => ({ "gmail/reply": 0.9 }),
      }),
    )
    expect(result).toEqual({ name: "evals", ok: true, output: "" })
  })

  test("shrunk working-tree required set does NOT relax coverage (required from marker)", async () => {
    // readRequiredCases models the MARKER source (the injected dep). A shrunk
    // working-tree JSON is irrelevant — the gate reads this injected value.
    const result = await runEvalExecute(
      executeDeps({
        readRequiredCases: () => ["gmail/reply", "chat/must-also-run"],
        // only gmail/reply ran
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("chat/must-also-run")
  })

  test("empty required snapshot + no feature checker → fail (no coverage contract)", async () => {
    // The fallback plan path snapshots `[]`; with no assert-eval-coverage.ts the
    // gate has nothing proving the prompt change is covered, so a scored but
    // unrelated case must NOT pass the needed step.
    const result = await runEvalExecute(
      executeDeps({
        readRequiredCases: () => [],
        hasFeatureCoverageGate: () => false,
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("coverage contract missing")
  })

  test("empty required snapshot + explicit feature checker → ok (checker is the contract)", async () => {
    const result = await runEvalExecute(
      executeDeps({
        readRequiredCases: () => [],
        hasFeatureCoverageGate: () => true,
        runFeatureCoverageGate: () => ({ ok: true, output: "" }),
      }),
    )
    expect(result).toEqual({ name: "evals", ok: true, output: "" })
  })

  test("feature coverage gate fails → fail carrying its output", async () => {
    const result = await runEvalExecute(
      executeDeps({
        runFeatureCoverageGate: () => ({
          ok: false,
          output: "assert-eval-coverage.ts: missing case",
        }),
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("missing case")
  })

  test("clears report + run JSON + feature artifact BEFORE execute (freshness ordering)", async () => {
    const events: string[] = []
    await runEvalExecute(
      executeDeps({
        clearReport: () => events.push("clearReport"),
        clearRunJson: () => events.push("clearRunJson"),
        clearFeatureArtifact: () => events.push("clearArtifact"),
        runExecute: async () => {
          events.push("execute")
          return { kind: "pass" }
        },
      }),
    )
    expect(events).toEqual([
      "clearReport",
      "clearRunJson",
      "clearArtifact",
      "execute",
    ])
  })

  test("writeReportGate receives the machine verdict table on a failing gate", async () => {
    let captured: unknown = null
    const result = await runEvalExecute(
      executeDeps({
        readBaselineAfter: () => ({}), // missingBaseline → fail
        writeReportGate: (d) => {
          captured = d
        },
      }),
    )
    expect(result.ok).toBe(false)
    expect(captured).not.toBeNull()
  })
})
