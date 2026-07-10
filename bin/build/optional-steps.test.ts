import { describe, expect, test } from "bun:test"
import {
  OPTIONAL_STEPS,
  OPTIONAL_STEPS_FILENAME,
  optionalStepDefs,
  optionalStepLifecycle,
  optionalStepViews,
  parseOptionalStepsDeclaration,
  resolveOptionalStep,
  resolveOptionalStepIntent,
  resolveOverride,
} from "./optional-steps"

describe("OPTIONAL_STEPS registry", () => {
  test("e2e is registered with host phase validate", () => {
    expect(OPTIONAL_STEPS.e2e.id).toBe("e2e")
    expect(OPTIONAL_STEPS.e2e.hostPhase).toBe("validate")
    expect(OPTIONAL_STEPS.e2e.appliesWhen).toContain("unit tests")
  })

  test("evals is registered with host phase validate", () => {
    expect(OPTIONAL_STEPS.evals.id).toBe("evals")
    expect(OPTIONAL_STEPS.evals.hostPhase).toBe("validate")
    expect(OPTIONAL_STEPS.evals.appliesWhen).toContain("model")
  })

  test("optionalStepDefs lists the registry values", () => {
    expect(optionalStepDefs().map((d) => d.id)).toEqual(["e2e", "evals"])
  })

  test("filename is optional-steps.json", () => {
    expect(OPTIONAL_STEPS_FILENAME).toBe("optional-steps.json")
  })
})

describe("resolveOptionalStepIntent", () => {
  test("forced off beats a needed decision", () => {
    expect(
      resolveOptionalStepIntent({ needed: true, rationale: "x" }, "off"),
    ).toEqual({ needed: false, skipReason: "forced off" })
  })

  test("decision needed=false → skipped (not needed)", () => {
    expect(
      resolveOptionalStepIntent({ needed: false, rationale: "x" }, undefined),
    ).toEqual({ needed: false, skipReason: "not needed" })
  })

  test("decision needed=true → needed", () => {
    expect(
      resolveOptionalStepIntent({ needed: true, rationale: "x" }, undefined),
    ).toEqual({ needed: true })
  })

  test("forced on beats a not-needed decision", () => {
    expect(
      resolveOptionalStepIntent({ needed: false, rationale: "x" }, "on"),
    ).toEqual({ needed: true })
  })

  test("undefined decision → needed (fail-safe)", () => {
    expect(resolveOptionalStepIntent(undefined, undefined)).toEqual({
      needed: true,
    })
  })
})

describe("resolveOptionalStep", () => {
  const def = OPTIONAL_STEPS.e2e

  test("needed + infra → needed", () => {
    expect(
      resolveOptionalStep({
        def,
        decision: { needed: true, rationale: "x" },
        override: undefined,
        infraAvailable: true,
      }),
    ).toEqual({ state: "needed" })
  })

  test("needed + no infra → blocked", () => {
    const outcome = resolveOptionalStep({
      def,
      decision: { needed: true, rationale: "x" },
      override: undefined,
      infraAvailable: false,
    })
    expect(outcome.state).toBe("blocked")
    if (outcome.state === "blocked") expect(outcome.reason).toContain("e2e")
  })

  test("not-needed → skipped regardless of infra", () => {
    for (const infraAvailable of [true, false]) {
      const outcome = resolveOptionalStep({
        def,
        decision: { needed: false, rationale: "x" },
        override: undefined,
        infraAvailable,
      })
      expect(outcome).toEqual({ state: "skipped", reason: "not needed" })
    }
  })

  test("forced on + no infra → blocked", () => {
    const outcome = resolveOptionalStep({
      def,
      decision: { needed: false, rationale: "x" },
      override: "on",
      infraAvailable: false,
    })
    expect(outcome.state).toBe("blocked")
  })
})

describe("resolveOverride", () => {
  test("returns the state override for the id", () => {
    expect(resolveOverride("e2e", { e2e: "off" })).toBe("off")
    expect(resolveOverride("e2e", { e2e: "on" })).toBe("on")
  })

  test("undefined when absent", () => {
    expect(resolveOverride("e2e", undefined)).toBeUndefined()
    expect(resolveOverride("e2e", {})).toBeUndefined()
  })

  test("resolves the evals override independently", () => {
    expect(resolveOverride("evals", { evals: "off" })).toBe("off")
    expect(resolveOverride("evals", { e2e: "off" })).toBeUndefined()
  })
})

describe("optionalStepLifecycle", () => {
  test("pending before the host phase", () => {
    expect(optionalStepLifecycle("validate", "plan")).toBe("pending")
  })

  test("running at the host phase", () => {
    expect(optionalStepLifecycle("validate", "validate")).toBe("running")
  })

  test("done after the host phase", () => {
    expect(optionalStepLifecycle("validate", "review")).toBe("done")
    expect(optionalStepLifecycle("validate", "pr")).toBe("done")
    expect(optionalStepLifecycle("validate", "done")).toBe("done")
  })
})

describe("optionalStepViews", () => {
  test("declaration needed → running at validate, done at review", () => {
    // Both steps declared needed → both render lifecycle from the phase.
    const decl = {
      e2e: { needed: true, rationale: "x" },
      evals: { needed: true, rationale: "y" },
    }
    expect(
      optionalStepViews({ phase: "validate", optionalSteps: decl }),
    ).toEqual([
      { id: "e2e", status: "running" },
      { id: "evals", status: "running" },
    ])
    expect(optionalStepViews({ phase: "review", optionalSteps: decl })).toEqual(
      [
        { id: "e2e", status: "done" },
        { id: "evals", status: "done" },
      ],
    )
    expect(optionalStepViews({ phase: "plan", optionalSteps: decl })).toEqual([
      { id: "e2e", status: "pending" },
      { id: "evals", status: "pending" },
    ])
  })

  test("not-needed → skipped (not needed); undeclared evals fail-safes to running", () => {
    // Only e2e is declared not-needed; evals is undefined → fail-safe needed.
    expect(
      optionalStepViews({
        phase: "validate",
        optionalSteps: { e2e: { needed: false, rationale: "x" } },
      }),
    ).toEqual([
      { id: "e2e", status: "skipped", reason: "not needed" },
      { id: "evals", status: "running" },
    ])
  })

  test("forced off (via overrides) → skipped (forced off), per step", () => {
    expect(
      optionalStepViews({
        phase: "validate",
        optionalSteps: {
          e2e: { needed: true, rationale: "x" },
          evals: { needed: true, rationale: "y" },
        },
        optionalStepOverrides: { e2e: "off", evals: "off" },
      }),
    ).toEqual([
      { id: "e2e", status: "skipped", reason: "forced off" },
      { id: "evals", status: "skipped", reason: "forced off" },
    ])
  })

  test("absent declaration → both needed (fail-safe)", () => {
    expect(optionalStepViews({ phase: "validate" })).toEqual([
      { id: "e2e", status: "running" },
      { id: "evals", status: "running" },
    ])
  })
})

describe("parseOptionalStepsDeclaration", () => {
  test("valid JSON → typed declaration", () => {
    expect(
      parseOptionalStepsDeclaration(
        JSON.stringify({ e2e: { needed: true, rationale: "x" } }),
      ),
    ).toEqual({ e2e: { needed: true, rationale: "x" } })
  })

  test("null → null", () => {
    expect(parseOptionalStepsDeclaration(null)).toBeNull()
  })

  test("malformed JSON → null", () => {
    expect(parseOptionalStepsDeclaration("{not json")).toBeNull()
  })

  test("schema-invalid (missing rationale) → null", () => {
    expect(
      parseOptionalStepsDeclaration(JSON.stringify({ e2e: { needed: true } })),
    ).toBeNull()
  })

  test("unknown id {bad:…} → null (z.strictObject rejects)", () => {
    expect(
      parseOptionalStepsDeclaration(
        JSON.stringify({ bad: { needed: true, rationale: "x" } }),
      ),
    ).toBeNull()
  })

  test("omitted registered id {} → {} (valid; distinct from unknown-ids)", () => {
    // {} is a valid declaration (no decisions → e2e fails safe to needed downstream);
    // {"bad":…} is NOT valid (unknown id) and parses to null.
    expect(parseOptionalStepsDeclaration("{}")).toEqual({})
    expect(
      parseOptionalStepsDeclaration(
        JSON.stringify({ bad: { needed: true, rationale: "x" } }),
      ),
    ).toBeNull()
  })
})
