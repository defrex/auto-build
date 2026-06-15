import { describe, expect, test } from "bun:test"
import {
  buildPrompt,
  ensureTicketPrompt,
  monitorAddressReviewPrompt,
  monitorCiFixPrompt,
  planPrompt,
  planReviewPrompt,
  prPrompt,
  reviewPrompt,
  reviewResponsePrompt,
} from "./prompts"

const buildDir = "/repo/build/build-flow"
const specPath = `${buildDir}/spec.md`

describe("planPrompt", () => {
  test("references spec + plan paths and the PLAN_DONE sentinel", () => {
    const p = planPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      revising: false,
    })
    expect(p).toContain(specPath)
    expect(p).toContain(`${buildDir}/plan.md`)
    expect(p).toContain("PLAN_DONE")
    expect(p).toContain("ESCALATE:")
    expect(p).toContain("Explore the codebase")
  })
  test("revising mode points at the prior critique", () => {
    const p = planPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      revising: true,
    })
    expect(p).toContain(`${buildDir}/plan-review.md`)
    expect(p).toContain("revision")
  })
})

describe("planReviewPrompt", () => {
  test("treats spec as canonical and lists all three verdicts", () => {
    const p = planReviewPrompt({ feature: "build-flow", buildDir, specPath })
    expect(p).toContain("CANONICAL")
    expect(p).toContain(specPath)
    expect(p).toContain(`${buildDir}/plan.md`)
    expect(p).toContain(`${buildDir}/plan-review.md`)
    expect(p).toContain("APPROVED")
    expect(p).toContain("NEEDS_REVISION")
    expect(p).toContain("ESCALATE:")
  })
})

describe("buildPrompt", () => {
  test("base build references plan, spec, implementation notes", () => {
    const p = buildPrompt({ feature: "build-flow", buildDir, specPath })
    expect(p).toContain(`${buildDir}/plan.md`)
    expect(p).toContain(specPath)
    expect(p).toContain(`${buildDir}/implementation.md`)
    expect(p).toContain("BUILD_DONE")
  })
  test("validate-failure loop points at the captured failures", () => {
    const failures = `${buildDir}/validate-failures.md`
    const p = buildPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      validateFailuresPath: failures,
    })
    expect(p).toContain(failures)
    expect(p).toContain("FAILED")
  })
  test("invites out-of-scope observations without blocking the build", () => {
    const p = buildPrompt({ feature: "build-flow", buildDir, specPath })
    expect(p).toContain(`${buildDir}/observations.md`)
    expect(p).toContain("OUT OF SCOPE")
    expect(p).toContain("do NOT let them block")
  })
})

describe("reviewPrompt", () => {
  test("round 1 reviews the diff against the spec", () => {
    const p = reviewPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      round: 1,
      baseBranch: "main",
    })
    expect(p).toContain("git diff main...HEAD")
    expect(p).toContain(specPath)
    expect(p).toContain(`${buildDir}/review/round-1.md`)
    expect(p).toContain("[blocking]")
    expect(p).toContain("CLEAN")
    expect(p).toContain("BLOCKING")
  })
  test("later rounds reference the previous round file", () => {
    const p = reviewPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      round: 3,
      baseBranch: "main",
    })
    expect(p).toContain(`${buildDir}/review/round-3.md`)
    expect(p).toContain(`${buildDir}/review/round-2.md`)
  })
  test("records out-of-scope observations separately from review findings", () => {
    const p = reviewPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      round: 1,
      baseBranch: "main",
    })
    expect(p).toContain(`${buildDir}/observations.md`)
    expect(p).toContain("OUT OF SCOPE")
    // must not be conflated with the blocking/nit/question findings
    expect(p).toContain("separate from your review findings")
  })
})

describe("reviewResponsePrompt", () => {
  test("responds in the same round file with fix/pushback and BUILD_DONE", () => {
    const p = reviewResponsePrompt({
      feature: "build-flow",
      buildDir,
      round: 2,
    })
    expect(p).toContain(`${buildDir}/review/round-2.md`)
    expect(p).toContain("FIX")
    expect(p).toContain("PUSHBACK")
    expect(p).toContain("BUILD_DONE")
  })
})

describe("prPrompt", () => {
  test("invokes /pr open and ends with BUILD_DONE; no Closes without an id", () => {
    const p = prPrompt("build-flow")
    expect(p).toContain("/pr open")
    expect(p).toContain("BUILD_DONE")
    expect(p).not.toContain("Closes")
  })
  test("with a Linear issue id, instructs the PR body to close it", () => {
    const p = prPrompt("build-flow", "PRO-123")
    expect(p).toContain("/pr open")
    expect(p).toContain("BUILD_DONE")
    expect(p).toContain("Closes PRO-123")
  })
})

describe("ensureTicketPrompt", () => {
  const base = {
    feature: "build-flow",
    branch: "battle-silene",
    specPath: "/repo/build/build-flow/spec.md",
    teamId: "team_1",
    inProgressStateId: "s_progress",
    projectId: "proj_1",
    resultPath: "/repo/build/build-flow/.build/ensure-ticket-result.json",
  }

  test("always includes the team, In-Progress state, spec path, result path, and side-effect rules", () => {
    const p = ensureTicketPrompt(base)
    expect(p).toContain("team_1")
    expect(p).toContain("s_progress")
    expect(p).toContain(base.specPath)
    expect(p).toContain(base.resultPath)
    expect(p).toContain('{"issueId"')
    expect(p).toMatch(/no code changes/i)
    expect(p).toMatch(/no PR|open no PR/i)
  })

  test("compares against the verbatim spec and updates the description to match the file (file wins)", () => {
    const p = ensureTicketPrompt(base)
    expect(p).toMatch(/verbatim/i)
    expect(p).toMatch(/exactly match the file|file wins/i)
    // whitespace-trim only; no footer/marker stripping
    expect(p).toMatch(/trim/i)
    expect(p).not.toMatch(/footer/i)
  })

  test("includes the project when projectId is set; omits it when empty", () => {
    expect(ensureTicketPrompt(base)).toContain("proj_1")
    expect(ensureTicketPrompt(base)).toMatch(/Project:/)
    const noProj = ensureTicketPrompt({ ...base, projectId: "" })
    expect(noProj).not.toMatch(/Project:/)
  })

  describe("no-id mode", () => {
    const p = ensureTicketPrompt(base)
    test("carries the feature marker, branch, and find-by-branch/marker instructions", () => {
      expect(p).toContain("build/build-flow")
      expect(p).toContain("battle-silene")
      expect(p).toMatch(/branch/i)
      expect(p).toMatch(/marker/i)
    })
    test("forbids fuzzy title matching and creates with the verbatim spec as description", () => {
      expect(p).toMatch(/do not fuzzy-match on title/i)
      expect(p).toMatch(/create/i)
    })
    test("does not reference an existing issue id", () => {
      expect(p).not.toMatch(/existing issue/i)
    })
  })

  describe("existing-id mode", () => {
    const p = ensureTicketPrompt({
      ...base,
      existingIssueId: "PRO-7",
      existingIssueUuid: "u",
    })
    test("references the existing id/uuid and skips search/create", () => {
      expect(p).toContain("PRO-7")
      expect(p).toMatch(/skip.*(search|create)/i)
      expect(p).toMatch(/do not search/i)
    })
    test("still records the same id and updates the description if it differs", () => {
      expect(p).toMatch(/PRO-7/)
      expect(p).toMatch(/update/i)
    })
  })
})

describe("monitor prompts", () => {
  test("CI fix names the failing checks and tells the builder to fetch logs", () => {
    const p = monitorCiFixPrompt("build-flow", ["test", "typecheck"])
    expect(p).toContain("test, typecheck")
    expect(p).toContain("--log-failed")
    expect(p).toContain("BUILD_DONE")
  })
  test("address-review invokes the skill with the PR number", () => {
    const p = monitorAddressReviewPrompt("build-flow", 456)
    expect(p).toContain("/address-review 456")
    expect(p).toContain("BUILD_DONE")
  })
})
