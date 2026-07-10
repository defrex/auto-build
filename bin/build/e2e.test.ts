import { describe, expect, test } from "bun:test"
import {
  type E2ePlanState,
  type EnsureE2ePlanDeps,
  ensureE2ePlan,
  NO_UI_SCREENSHOT_MARKER,
  type RunE2eExecuteDeps,
  reportDeclaresNoUi,
  reportReferencesScreenshots,
  runE2eExecute,
} from "./e2e"
import type { BuilderVerdict, PlanReviewVerdict } from "./verdicts"

/**
 * Default deps for a `runE2eExecute` call: a passing run with one referenced
 * screenshot and a satisfied marketing gate. Tests override only what they
 * exercise, so call-sites stay focused on the gate under test.
 */
function executeDeps(
  overrides: Partial<RunE2eExecuteDeps> = {},
): RunE2eExecuteDeps {
  return {
    runExecute: async () => ({ kind: "pass" }),
    clearReport: () => {},
    clearScreenshots: () => {},
    clearFeatureArtifact: () => {},
    readReport: () =>
      "# e2e report\n\nexercised login: ![login](screenshots/login.png)",
    listScreenshots: () => ["login.png"],
    checkMarketingScreenshots: () => ({ ok: true, problems: [] }),
    runFeatureCoverageGate: () => ({ ok: true, output: "" }),
    withDevServer: (run) => run("https://x.localhost"),
    ...overrides,
  }
}

/**
 * Stateful fake for `ensureE2ePlan` deps. `planWritten`/`completed` are flipped
 * by the dep callbacks so the hard post-conditions (a plan exists AND completion
 * is recorded) can be asserted directly on the fake's state.
 */
function makeFakeDeps(opts: {
  planExistsInitial?: boolean
  completionExistsInitial?: boolean
  /** Verdict per runPlan call (by attempt index); also flips planWritten true unless noWrite. */
  planVerdicts?: BuilderVerdict[]
  /** runPlan attempts that should NOT write a plan (simulate crash/escalate). */
  noWriteAttempts?: number[]
  /** Review verdicts in order; `null` simulates no parseable verdict. */
  reviewVerdicts?: (PlanReviewVerdict | null)[]
  maxRevisions?: number
}) {
  let planWritten = opts.planExistsInitial ?? false
  let completed = opts.completionExistsInitial ?? false
  const calls = {
    runPlan: [] as boolean[],
    runPlanReview: 0,
    writeFallbackPlan: [] as string[],
    markComplete: [] as E2ePlanState[],
    log: [] as string[],
  }
  let planAttempt = 0
  let reviewAttempt = 0

  const deps: EnsureE2ePlanDeps = {
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
      // Distinguish "no entry configured" (default approved) from an explicit
      // null entry (reviewer produced no parseable verdict).
      return opts.reviewVerdicts && idx < opts.reviewVerdicts.length
        ? opts.reviewVerdicts[idx]
        : { kind: "approved" }
    },
    writeFallbackPlan: (reason) => {
      calls.writeFallbackPlan.push(reason)
      planWritten = true
    },
    markComplete: (s) => {
      calls.markComplete.push(s)
      completed = true
    },
    log: (m) => calls.log.push(m),
    maxRevisions: opts.maxRevisions,
  }
  return {
    deps,
    calls,
    state: () => ({ planWritten, completed }),
  }
}

describe("ensureE2ePlan", () => {
  test("skips entirely when completion + plan both exist", async () => {
    const f = makeFakeDeps({
      planExistsInitial: true,
      completionExistsInitial: true,
    })
    await ensureE2ePlan(f.deps)
    expect(f.calls.runPlan).toHaveLength(0)
    expect(f.calls.runPlanReview).toBe(0)
    expect(f.calls.writeFallbackPlan).toHaveLength(0)
    expect(f.calls.markComplete).toHaveLength(0)
  })

  test("APPROVED after iteration 0 → one plan + one review, marked approved", async () => {
    const f = makeFakeDeps({ reviewVerdicts: [{ kind: "approved" }] })
    await ensureE2ePlan(f.deps)
    expect(f.calls.runPlan).toEqual([false])
    expect(f.calls.runPlanReview).toBe(1)
    expect(f.calls.writeFallbackPlan).toHaveLength(0)
    expect(f.calls.markComplete).toEqual([{ decision: "approved" }])
    expect(f.state().planWritten).toBe(true)
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
    await ensureE2ePlan(f.deps)
    expect(f.calls.runPlan).toEqual([false, true, true])
    expect(f.calls.markComplete).toEqual([{ decision: "revision-cap" }])
    expect(f.calls.writeFallbackPlan).toHaveLength(0)
    expect(f.state().planWritten).toBe(true)
    expect(f.state().completed).toBe(true)
  })

  test("resume: plan exists, no completion → review the artifact, do not regenerate", async () => {
    const f = makeFakeDeps({
      planExistsInitial: true,
      completionExistsInitial: false,
      reviewVerdicts: [{ kind: "approved" }],
    })
    await ensureE2ePlan(f.deps)
    // iteration 0 must NOT call runPlan (the artifact already exists)
    expect(f.calls.runPlan).toHaveLength(0)
    expect(f.calls.runPlanReview).toBe(1)
    expect(f.calls.markComplete).toEqual([{ decision: "approved" }])
  })

  test("resume + revision: existing plan, NEEDS_REVISION then APPROVED", async () => {
    const f = makeFakeDeps({
      planExistsInitial: true,
      completionExistsInitial: false,
      reviewVerdicts: [{ kind: "needs_revision" }, { kind: "approved" }],
    })
    await ensureE2ePlan(f.deps)
    // iteration 0 reviews existing artifact (no runPlan); iteration 1 regenerates
    expect(f.calls.runPlan).toEqual([true])
    expect(f.calls.runPlanReview).toBe(2)
    expect(f.calls.markComplete).toEqual([{ decision: "approved" }])
  })

  test("planner escalates without writing a plan → fallback installed, no review", async () => {
    const f = makeFakeDeps({
      planVerdicts: [{ kind: "escalate", reason: "spec contradicts itself" }],
      noWriteAttempts: [0],
    })
    await ensureE2ePlan(f.deps)
    expect(f.calls.writeFallbackPlan).toEqual(["spec contradicts itself"])
    expect(f.calls.runPlanReview).toBe(0)
    expect(f.calls.markComplete).toEqual([{ decision: "fallback" }])
    expect(f.state().planWritten).toBe(true)
    expect(f.state().completed).toBe(true)
  })

  test("planner returns done but writes no plan → fallback with default reason", async () => {
    const f = makeFakeDeps({
      planVerdicts: [{ kind: "done" }],
      noWriteAttempts: [0],
    })
    await ensureE2ePlan(f.deps)
    expect(f.calls.writeFallbackPlan).toEqual([
      "planner produced no e2e-plan.md",
    ])
    expect(f.calls.runPlanReview).toBe(0)
    expect(f.calls.markComplete).toEqual([{ decision: "fallback" }])
  })

  test("reviewer escalates → proceed with best plan, no fallback", async () => {
    const f = makeFakeDeps({
      reviewVerdicts: [{ kind: "escalate", reason: "ambiguous" }],
    })
    await ensureE2ePlan(f.deps)
    expect(f.calls.writeFallbackPlan).toHaveLength(0)
    expect(f.calls.markComplete).toEqual([{ decision: "reviewer-escalated" }])
    expect(f.state().planWritten).toBe(true)
    expect(f.state().completed).toBe(true)
  })

  test("reviewer returns no verdict → proceed with best plan", async () => {
    const f = makeFakeDeps({ reviewVerdicts: [null] })
    await ensureE2ePlan(f.deps)
    expect(f.calls.writeFallbackPlan).toHaveLength(0)
    expect(f.calls.markComplete).toEqual([{ decision: "reviewer-no-verdict" }])
    expect(f.state().completed).toBe(true)
  })
})

describe("reportDeclaresNoUi", () => {
  test("marker on its OWN line with a reason → exempt", () => {
    expect(
      reportDeclaresNoUi(
        "# report\n\nE2E_NO_UI_SURFACE: backend-only cron change\n",
      ),
    ).toBe(true)
  })

  test("bare marker on its own line → exempt", () => {
    expect(reportDeclaresNoUi("# report\nE2E_NO_UI_SURFACE")).toBe(true)
  })

  test("token mid-sentence → NOT exempt", () => {
    expect(
      reportDeclaresNoUi("this is not an E2E_NO_UI_SURFACE situation"),
    ).toBe(false)
  })

  test("marker wrapped in a markdown code span → exempt", () => {
    // The execute prompt models the marker inside backticks, so the agent
    // reproduces a code-span line verbatim. Strip the surrounding markdown.
    expect(
      reportDeclaresNoUi("`E2E_NO_UI_SURFACE: backend-only cron change`"),
    ).toBe(true)
  })

  test("bare marker wrapped in a code span → exempt", () => {
    expect(reportDeclaresNoUi("# report\n`E2E_NO_UI_SURFACE`")).toBe(true)
  })

  test("marker wrapped in bold emphasis → exempt", () => {
    expect(reportDeclaresNoUi("**E2E_NO_UI_SURFACE: cron-only change**")).toBe(
      true,
    )
  })

  test("marker written as a list bullet → exempt", () => {
    expect(reportDeclaresNoUi("- E2E_NO_UI_SURFACE: cron-only change")).toBe(
      true,
    )
  })

  test("marker under a blockquote → exempt", () => {
    expect(reportDeclaresNoUi("> E2E_NO_UI_SURFACE: cron-only change")).toBe(
      true,
    )
  })
})

describe("reportReferencesScreenshots", () => {
  test("report mentions screenshots/login.png + files [login.png] → ok", () => {
    expect(
      reportReferencesScreenshots("![](screenshots/login.png)", ["login.png"]),
    ).toEqual({ ok: true, missing: [] })
  })

  test("report references a deeper build-dir-relative path → ok", () => {
    expect(
      reportReferencesScreenshots("see build/feat/screenshots/login.png", [
        "login.png",
      ]),
    ).toEqual({ ok: true, missing: [] })
  })

  test("one of two screenshots unreferenced → not ok, names the missing one", () => {
    expect(
      reportReferencesScreenshots("![](screenshots/login.png)", [
        "login.png",
        "dashboard.png",
      ]),
    ).toEqual({ ok: false, missing: ["dashboard.png"] })
  })

  test("bare filename without the screenshots/ segment → NOT referenced", () => {
    expect(
      reportReferencesScreenshots("the file login.png shows the form", [
        "login.png",
      ]),
    ).toEqual({ ok: false, missing: ["login.png"] })
  })

  test("empty files → ok (nothing to reference)", () => {
    expect(reportReferencesScreenshots("# report", [])).toEqual({
      ok: true,
      missing: [],
    })
  })
})

describe("runE2eExecute", () => {
  test("invokes withDevServer with runExecute; pass + report + referenced shot + marketing-ok → ok CheckResult", async () => {
    let passedRun: ((url: string) => Promise<unknown>) | null = null
    const result = await runE2eExecute(
      executeDeps({
        withDevServer: (run) => {
          passedRun = run
          return run("https://x.localhost")
        },
      }),
    )
    expect(passedRun).not.toBeNull()
    expect(result).toEqual({ name: "e2e", ok: true, output: "" })
  })

  test("fail → not-ok CheckResult carrying the reason", async () => {
    const result = await runE2eExecute(
      executeDeps({
        runExecute: async () => ({ kind: "fail", reason: "login 500s" }),
      }),
    )
    expect(result).toEqual({ name: "e2e", ok: false, output: "login 500s" })
  })

  test("pass but missing report → not-ok CheckResult (artifact required)", async () => {
    const result = await runE2eExecute(executeDeps({ readReport: () => null }))
    expect(result.name).toBe("e2e")
    expect(result.ok).toBe(false)
    expect(result.output).toContain("e2e-report.md")
  })

  test("pass but empty/whitespace report → not-ok CheckResult", async () => {
    const result = await runE2eExecute(
      executeDeps({ readReport: () => "   \n  " }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("e2e-report.md")
  })

  test("pass + report + 0 screenshots + no marker → not-ok (screenshot required)", async () => {
    const result = await runE2eExecute(
      executeDeps({
        readReport: () => "# e2e report\n\nlogin works",
        listScreenshots: () => [],
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("screenshot")
  })

  test("pass + report + 0 screenshots + backend-only marker → ok (exemption honored)", async () => {
    const result = await runE2eExecute(
      executeDeps({
        readReport: () =>
          `# e2e report\n\n${NO_UI_SCREENSHOT_MARKER}: backend cron change`,
        listScreenshots: () => [],
      }),
    )
    expect(result).toEqual({ name: "e2e", ok: true, output: "" })
  })

  test("pass + screenshot NOT referenced in report → not-ok, names the shot; marketing NOT consulted", async () => {
    let marketingCalls = 0
    const result = await runE2eExecute(
      executeDeps({
        readReport: () => "# e2e report\n\nlogin works (no image embed)",
        listScreenshots: () => ["foo.png"],
        checkMarketingScreenshots: () => {
          marketingCalls++
          return { ok: true, problems: [] }
        },
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("screenshots/foo.png")
    expect(marketingCalls).toBe(0)
  })

  test("marketing gate fails → not-ok CheckResult carrying the problem text", async () => {
    const result = await runE2eExecute(
      executeDeps({
        checkMarketingScreenshots: () => ({
          ok: false,
          problems: ["2026-06-22.mdx: featured section 'X' has no image"],
        }),
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("featured section 'X' has no image")
  })

  test("marketing checked only after the verification gates pass (0 shots + no marker → not consulted)", async () => {
    let marketingCalls = 0
    await runE2eExecute(
      executeDeps({
        readReport: () => "# e2e report",
        listScreenshots: () => [],
        checkMarketingScreenshots: () => {
          marketingCalls++
          return { ok: true, problems: [] }
        },
      }),
    )
    expect(marketingCalls).toBe(0)
  })

  test("does not inspect screenshots/marketing on a fail verdict", async () => {
    let listCalls = 0
    let marketingCalls = 0
    const result = await runE2eExecute(
      executeDeps({
        runExecute: async () => ({ kind: "fail", reason: "boom" }),
        readReport: () => null,
        listScreenshots: () => {
          listCalls++
          return []
        },
        checkMarketingScreenshots: () => {
          marketingCalls++
          return { ok: true, problems: [] }
        },
      }),
    )
    expect(result.output).toBe("boom")
    expect(listCalls).toBe(0)
    expect(marketingCalls).toBe(0)
  })

  test("clears report + screenshots + feature artifact BEFORE invoking execute (freshness ordering)", async () => {
    const events: string[] = []
    await runE2eExecute(
      executeDeps({
        runExecute: async () => {
          events.push("execute")
          return { kind: "pass" }
        },
        clearReport: () => events.push("clear"),
        clearScreenshots: () => events.push("clearShots"),
        clearFeatureArtifact: () => events.push("clearArtifact"),
        readReport: () => "# fresh report\n\n![](screenshots/login.png)",
      }),
    )
    expect(events).toEqual(["clear", "clearShots", "clearArtifact", "execute"])
  })

  test("clears screenshots on every run (multi-run invocation)", async () => {
    let clearShotsCalls = 0
    const deps = executeDeps({
      clearScreenshots: () => {
        clearShotsCalls++
      },
    })
    await runE2eExecute(deps)
    await runE2eExecute(deps)
    expect(clearShotsCalls).toBe(2)
  })

  test("stdout has no sentinel but report's last line is E2E_PASS → ok (report fallback)", async () => {
    const result = await runE2eExecute(
      executeDeps({
        runExecute: async () => null,
        readReport: () =>
          "# e2e report\n\nexercised login: ![login](screenshots/login.png)\n\nE2E_PASS",
      }),
    )
    expect(result).toEqual({ name: "e2e", ok: true, output: "" })
  })

  test("stdout has no sentinel but report's last line is E2E_FAIL → not-ok, carries the reason", async () => {
    const result = await runE2eExecute(
      executeDeps({
        runExecute: async () => null,
        readReport: () => "# e2e report\n\nE2E_FAIL: login 500s",
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("login 500s")
  })

  test("stdout has no sentinel and report has E2E_PASS but trailing prose → parks (malformed report)", async () => {
    const result = await runE2eExecute(
      executeDeps({
        runExecute: async () => null,
        readReport: () =>
          "# report\n\nE2E_PASS\n\nI did not actually finish writing the final verdict.",
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("no E2E_PASS/E2E_FAIL sentinel")
    expect(result.output).toContain("e2e-report.md")
  })

  test("neither stdout nor report has a sentinel → parks with the no-sentinel message", async () => {
    const result = await runE2eExecute(
      executeDeps({
        runExecute: async () => null,
        readReport: () => "# report with no verdict line",
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("no E2E_PASS/E2E_FAIL sentinel")
    expect(result.output).toContain("e2e-report.md")
  })

  test("stdout has no sentinel and report is missing → parks (no fallback source)", async () => {
    const result = await runE2eExecute(
      executeDeps({
        runExecute: async () => null,
        readReport: () => null,
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("no E2E_PASS/E2E_FAIL sentinel")
  })

  test("precedence: stdout E2E_FAIL wins over report E2E_PASS (report not consulted)", async () => {
    let reportReads = 0
    const result = await runE2eExecute(
      executeDeps({
        runExecute: async () => ({ kind: "fail", reason: "stdout fail" }),
        readReport: () => {
          reportReads++
          return "# report\n\nE2E_PASS"
        },
      }),
    )
    expect(result).toEqual({ name: "e2e", ok: false, output: "stdout fail" })
    expect(reportReads).toBe(0)
  })

  test("precedence: stdout E2E_PASS honored even though report carries E2E_FAIL text", async () => {
    const result = await runE2eExecute(
      executeDeps({
        runExecute: async () => ({ kind: "pass" }),
        readReport: () =>
          "# report\n\nE2E_FAIL: doubt\n\nlogin: ![login](screenshots/login.png)\n\nE2E_PASS",
      }),
    )
    expect(result).toEqual({ name: "e2e", ok: true, output: "" })
  })

  test("feature coverage gate fails → not-ok CheckResult carrying the gate output", async () => {
    const result = await runE2eExecute(
      executeDeps({
        runFeatureCoverageGate: () => ({
          ok: false,
          output: "assert-e2e-coverage.ts: marcusAfter.naturalWidth was 0",
        }),
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("marcusAfter.naturalWidth was 0")
  })

  test("feature coverage gate passing (default) keeps the PASS", async () => {
    const result = await runE2eExecute(executeDeps())
    expect(result).toEqual({ name: "e2e", ok: true, output: "" })
  })

  test("feature coverage gate runs LAST — not consulted when an earlier gate already failed", async () => {
    let coverageCalls = 0
    const result = await runE2eExecute(
      executeDeps({
        // An earlier gate (screenshots) fails first.
        readReport: () => "# e2e report\n\nlogin works",
        listScreenshots: () => [],
        runFeatureCoverageGate: () => {
          coverageCalls++
          return { ok: true, output: "" }
        },
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("screenshot")
    expect(coverageCalls).toBe(0)
  })

  test("stale feature artifact from a prior run does not survive into a PASS that never rewrites it", async () => {
    // Models the stale-coverage hazard the round-1 review flagged: a prior run
    // committed a passing `e2e-artifact.json`; this run emits E2E_PASS + report
    // + screenshot but never rewrites the JSON. clearFeatureArtifact wipes the
    // committed file up front, so the feature coverage gate (whose checker fails
    // on a missing artifact) can only pass against THIS run's capture.
    let artifactPresent = true // simulates the committed, stale artifact
    const result = await runE2eExecute(
      executeDeps({
        runExecute: async () => ({ kind: "pass" }), // PASS but no fresh JSON write
        clearFeatureArtifact: () => {
          artifactPresent = false
        },
        // The real checker exits non-zero when e2e-artifact.json is missing;
        // model that as the gate failing while the artifact is absent.
        runFeatureCoverageGate: () =>
          artifactPresent
            ? { ok: true, output: "" }
            : { ok: false, output: "missing e2e-artifact.json" },
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("e2e-artifact.json")
  })

  test("clears feature artifact on every run (multi-run invocation)", async () => {
    let clearArtifactCalls = 0
    const deps = executeDeps({
      clearFeatureArtifact: () => {
        clearArtifactCalls++
      },
    })
    await runE2eExecute(deps)
    await runE2eExecute(deps)
    expect(clearArtifactCalls).toBe(2)
  })

  test("stale report from a prior FAIL run does not survive into a crashed PASS run", async () => {
    // Models the retry/stale-report hazard: run 1 left a non-empty report and
    // FAILed; run 2 emits E2E_PASS but crashes before rewriting the report.
    // clearReport wipes the prior artifact, so the absent fresh report is seen
    // as missing → e2e fails rather than shipping the stale run's report.
    let report: string | null = "# report from the earlier FAIL run"
    const result = await runE2eExecute(
      executeDeps({
        runExecute: async () => ({ kind: "pass" }), // PASS but no fresh write
        clearReport: () => {
          report = null
        },
        readReport: () => report,
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.output).toContain("e2e-report.md")
  })
})
