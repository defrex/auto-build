import { describe, expect, test } from "bun:test"
import type { StateBucket } from "./linear-state-order"
import {
  buildPrompt,
  e2eExecutePrompt,
  e2ePlanPrompt,
  e2ePlanReviewPrompt,
  ensureTicketPrompt,
  evalExecutePrompt,
  evalPlanPrompt,
  evalPlanReviewPrompt,
  fallbackE2ePlanArtifact,
  fallbackEvalPlanArtifact,
  inReviewMovePrompt,
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

const sampleOrdering: StateBucket[] = [
  {
    rank: 0,
    label: "triage/ready (earlier)",
    stateIds: ["s_triage", "s_ready"],
  },
  { rank: 1, label: "In-Progress", stateIds: ["s_progress"] },
  { rank: 2, label: "In Review", stateIds: ["s_review"] },
  { rank: 3, label: "Done/canceled (terminal)", stateIds: ["s_done"] },
]

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
  test("instructs writing the optional-steps declaration with e2e criteria", () => {
    for (const revising of [false, true]) {
      const p = planPrompt({
        feature: "build-flow",
        buildDir,
        specPath,
        revising,
      })
      expect(p).toContain(`${buildDir}/optional-steps.json`)
      expect(p).toContain('"e2e"')
      expect(p).toContain("unit tests can't fully cover")
    }
  })
  test("optional-steps declaration renders the evals criterion (model-facing)", () => {
    const p = planPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      revising: false,
    })
    expect(p).toContain('"evals"')
    expect(p).toContain("model")
  })
  test("does NOT carry the schema-narrow observation instruction (build + review only)", () => {
    for (const revising of [false, true]) {
      const p = planPrompt({
        feature: "build-flow",
        buildDir,
        specPath,
        revising,
      })
      expect(p).not.toContain("- **kind:** schema-narrow")
    }
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
  test("sanity-checks the optional-step declaration", () => {
    const p = planReviewPrompt({ feature: "build-flow", buildDir, specPath })
    expect(p).toContain(`${buildDir}/optional-steps.json`)
    expect(p).toContain("Sanity-check the optional-step declaration")
  })
  test("cues the evals not-needed sanity check (prompt/rubric)", () => {
    const p = planReviewPrompt({ feature: "build-flow", buildDir, specPath })
    expect(p).toContain("evals marked not-needed")
    expect(p).toContain("judge/scorer rubric")
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
  test("instructs updating the weekly changelog for user-facing changes", () => {
    const p = buildPrompt({ feature: "build-flow", buildDir, specPath })
    expect(p).toContain("changelog")
    expect(p).toContain("apps/docs/content/docs/changelog")
    expect(p).toMatch(/user-facing/i)
    expect(p).toContain(".claude/skills/docs/SKILL.md")
  })
  test("commits after the changelog step so the changelog lands in the PR", () => {
    const p = buildPrompt({ feature: "build-flow", buildDir, specPath })
    const changelogIdx = p.indexOf("Update the weekly changelog")
    const commitIdx = p.indexOf("Commit ALL of your work")
    expect(changelogIdx).toBeGreaterThanOrEqual(0)
    expect(commitIdx).toBeGreaterThan(changelogIdx)
  })
  test("invites the schema-narrow observation for deferred Convex narrows", () => {
    const p = buildPrompt({ feature: "build-flow", buildDir, specPath })
    expect(p).toContain("- **kind:** schema-narrow")
    expect(p).toContain("widen")
    expect(p).toContain("narrow")
    expect(p).toContain("safety precondition")
    // the entry points the implementer at the schema deprecation comment
    expect(p).toContain("convex/schema.ts")
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
  test("verifies weekly changelog coverage at the expected level", () => {
    const p = reviewPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      round: 1,
      baseBranch: "main",
    })
    expect(p).toContain("changelog")
    expect(p).toMatch(/user-facing/i)
    expect(p).toMatch(/published|registered/i)
    expect(p).toMatch(/level/i)
  })
  test("carries the schema-narrow observation backstop for widen+migrate diffs", () => {
    const p = reviewPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      round: 1,
      baseBranch: "main",
    })
    expect(p).toContain("- **kind:** schema-narrow")
    expect(p).toContain("widen")
    expect(p).toContain("narrow")
    expect(p).toContain("safety precondition")
    expect(p).toContain("convex/schema.ts")
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
  test("with sentryShortIds, instructs an empty commit carrying `fixes <SHORT-ID>`", () => {
    const p = prPrompt("build-flow", "PRO-123", ["PRODUCT-WEB-1A2"])
    expect(p).toContain("fixes PRODUCT-WEB-1A2")
    expect(p).toContain("--allow-empty")
    // Linkage and Sentry resolution coexist.
    expect(p).toContain("Closes PRO-123")
  })
  test("without sentryShortIds, no `fixes` instruction", () => {
    const p = prPrompt("build-flow", "PRO-123")
    expect(p).not.toContain("fixes ")
    expect(p).not.toContain("--allow-empty")
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
    stateOrdering: sampleOrdering,
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

  test("result shape now names title, url, and summary for the dashboard", () => {
    const p = ensureTicketPrompt(base)
    expect(p).toContain('"title"')
    expect(p).toContain('"url"')
    expect(p).toContain('"summary"')
  })

  test("instructs the agent to capture the issue URL and a 1–2 sentence summary", () => {
    const p = ensureTicketPrompt(base)
    expect(p).toMatch(/url/i)
    expect(p).toMatch(/title/i)
    expect(p).toMatch(/one|two|1.?2|first/i)
    expect(p).toMatch(/sentence/i)
    expect(p).toMatch(/summary/i)
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
    test("forward-only advances an adopted ticket to In-Progress (rank 1)", () => {
      // the create branch already creates at In-Progress; the adopt branch must
      // forward-only advance.
      expect(p).toMatch(/rank/i)
      expect(p).toMatch(/leave it exactly as is/i)
      expect(p).toMatch(/unrecognized/i)
      expect(p).toMatch(/current/i)
      expect(p).toMatch(/state id/i)
      expect(p).toMatch(/do not infer/i)
      // the In-Progress target id appears in the forward-only rule
      expect(p).toContain("s_progress")
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
    test("forward-only advances the existing ticket to In-Progress (rank 1)", () => {
      expect(p).toMatch(/rank/i)
      expect(p).toMatch(/leave it exactly as is/i)
      expect(p).toMatch(/do not infer/i)
      expect(p).toContain("s_progress")
    })
  })
})

describe("inReviewMovePrompt", () => {
  const base = {
    feature: "build-flow",
    issueId: "PRO-7",
    inReviewStateId: "s_review",
    stateOrdering: sampleOrdering,
    resultPath: "/repo/build/build-flow/.build/in-review-result.json",
  }

  test("identifies the step, forbids code changes / PRs, and reads current state", () => {
    const p = inReviewMovePrompt(base)
    expect(p).toMatch(/in-?review move/i)
    expect(p).toMatch(/no code changes/i)
    expect(p).toMatch(/no PR|open no PR/i)
    expect(p).toContain("PRO-7")
    expect(p).toMatch(/current/i)
    expect(p).toMatch(/state id/i)
  })

  test("carries the forward-only rule to In Review (rank 2)", () => {
    const p = inReviewMovePrompt(base)
    expect(p).toContain("s_review")
    expect(p).toMatch(/rank/i)
    expect(p).toMatch(/leave it exactly as is/i)
    expect(p).toMatch(/unrecognized/i)
    expect(p).toMatch(/do not infer/i)
  })

  test('writes the {"moved"} result to the result path', () => {
    const p = inReviewMovePrompt(base)
    expect(p).toContain(base.resultPath)
    expect(p).toContain('{"moved"')
  })

  test("fetches by uuid for an exact match when issueUuid is present", () => {
    const p = inReviewMovePrompt({ ...base, issueUuid: "uuid-7" })
    expect(p).toContain("uuid-7")
  })
})

describe("e2ePlanPrompt", () => {
  test("references the e2e artifacts, spec, and observations and ends with PLAN_DONE", () => {
    const p = e2ePlanPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      revising: false,
    })
    expect(p).toContain(`${buildDir}/e2e-plan.md`)
    expect(p).toContain(`${buildDir}/implementation.md`)
    expect(p).toContain(specPath)
    expect(p).toContain(`${buildDir}/observations.md`)
    expect(p).toContain("e2e-infra")
    expect(p).toMatch(/untestable|cannot be e2e-tested/i)
    expect(p).toContain("PLAN_DONE")
    expect(p).toContain("ESCALATE:")
    // the happy path must be called out as required coverage
    expect(p).toMatch(/happy path/i)
  })

  test("instructs to always write a best-effort plan before finishing", () => {
    const p = e2ePlanPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      revising: false,
    })
    // always write the artifact, even partial; ESCALATE is the rare exception
    expect(p).toMatch(/always write/i)
    expect(p).toMatch(/best-effort|partial/i)
    // the loop never blocks on a human
    expect(p).toMatch(/never blocks|no human|not.*route.*human/i)
  })

  test("revising mode points at the prior plan critique", () => {
    const p = e2ePlanPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      revising: true,
    })
    expect(p).toContain(`${buildDir}/e2e-plan-review.md`)
  })

  test("names the seed-data path so seedable flows aren't pre-marked untestable", () => {
    const p = e2ePlanPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      revising: false,
    })
    // names the concrete entrypoints
    expect(p).toContain("seedPeopleFixture")
    expect(p).toContain("ensure-dev-workspace.ts")
    expect(p).toContain("people.seedMany")
    // states the workspace is pre-seeded with people
    expect(p).toMatch(/pre-seeded/i)
    expect(p).toMatch(/people/i)
    // idempotent + production-blocked / dev-only (NOT "dev/preview-only")
    expect(p).toMatch(/idempotent/i)
    expect(p).toMatch(/dev-only|never (in )?prod|production-blocked/i)
    expect(p).not.toMatch(/dev\/preview-only/i)
    // missing-seed is no longer a valid untestable reason
    expect(p).toMatch(/not.*(a )?valid|has a seed path|do not skip/i)
    // points at the seeding skill as the catalogue (single source of truth)
    expect(p).toContain(".agents/skills/seeding")
    expect(p).toMatch(/seeding.*skill|`seeding`/i)
  })

  test("defaults to BUILDING the seeder when no seed path exists yet", () => {
    const p = e2ePlanPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      revising: false,
    })
    // new default: build the seeder, don't record+skip
    expect(p).toMatch(/build (the|a) seed/i)
    // follow the seeding skill's discoverable / no-orphan convention + smoke test
    expect(p).toMatch(/no-orphan|catalogue|discoverable/i)
    expect(p).toMatch(/smoke test/i)
    expect(p).toContain("devSeed.test.ts")
    // committed code held to the same bar as any change
    expect(p).toMatch(/code review|committed code|same bars?/i)
    // seedable-vs-genuinely-un-seedable is the deciding line
    expect(p).toMatch(/un-mockable|OAuth|webhook|disproportionate/i)
    expect(p).toMatch(/deciding line/i)
  })
})

describe("e2ePlanReviewPrompt", () => {
  test("critiques the e2e plan against the spec and lists all three verdicts", () => {
    const p = e2ePlanReviewPrompt({ feature: "build-flow", buildDir, specPath })
    expect(p).toContain(`${buildDir}/e2e-plan.md`)
    expect(p).toContain(`${buildDir}/e2e-plan-review.md`)
    expect(p).toContain(specPath)
    expect(p).toContain("APPROVED")
    expect(p).toContain("NEEDS_REVISION")
    expect(p).toContain("ESCALATE:")
    expect(p).toMatch(/never blocks|no human/i)
  })
})

describe("e2eExecutePrompt", () => {
  const devUrl = "https://build-flow.dispatch.localhost"
  function execPrompt() {
    return e2eExecutePrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      devUrl,
      baseBranch: "main",
    })
  }

  test("follows the plan, authenticates, and distinguishes broken from untestable", () => {
    const p = execPrompt()
    expect(p).toContain(`${buildDir}/e2e-plan.md`)
    expect(p).toContain(`${buildDir}/e2e-report.md`)
    expect(p).toContain("/api/auth/dev-login")
    expect(p).toContain(devUrl)
    expect(p).toContain("E2E_PASS")
    expect(p).toContain("E2E_FAIL")
    expect(p).toContain("e2e-infra")
    expect(p).toMatch(/broken/i)
    expect(p).toMatch(/untestable/i)
    // the two must not be conflated
    expect(p).toMatch(/do not conflate|not.*conflate|distinguish/i)
  })

  test("instructs verification capture into the screenshots dir + report references", () => {
    const p = execPrompt()
    expect(p).toContain(`${buildDir}/screenshots`)
    expect(p).toMatch(/screenshot/i)
    expect(p).toContain("screenshots/<name>.png")
    // gate-enforced "every saved PNG must be referenced" instruction
    expect(p).toMatch(/every PNG you save.*MUST appear/i)
  })

  test("carries the hard-gate language and the backend-only marker with a prose rationale", () => {
    const p = execPrompt()
    expect(p).toMatch(/hard gate/i)
    expect(p).toContain("E2E_NO_UI_SURFACE")
    // rationale recorded in the report prose, not just the marker
    expect(p).toMatch(/prose/i)
  })

  test("names the seed-data path so seedable flows are seeded + exercised", () => {
    const p = execPrompt()
    // names the concrete entrypoints
    expect(p).toContain("seedPeopleFixture")
    expect(p).toContain("ensure-dev-workspace.ts")
    expect(p).toContain("people.seedMany")
    // states the dev-login workspace is pre-seeded with people
    expect(p).toMatch(/pre-seeded/i)
    expect(p).toMatch(/people/i)
    // idempotent + production-blocked / dev-only (NOT "dev/preview-only")
    expect(p).toMatch(/idempotent/i)
    expect(p).toMatch(/dev-only|never (in )?prod|production-blocked/i)
    expect(p).not.toMatch(/dev\/preview-only/i)
    // missing-seed is no longer a valid untestable reason
    expect(p).toMatch(/not.*(a )?valid|has a seed path|do not skip/i)
    // points at the seeding skill as the catalogue (single source of truth)
    expect(p).toContain(".agents/skills/seeding")
    expect(p).toMatch(/seeding.*skill|`seeding`/i)
  })

  test("defaults to BUILDING the seeder when no seed path exists yet", () => {
    const p = execPrompt()
    // new default: build the seeder, don't record+skip
    expect(p).toMatch(/build (the|a) seed/i)
    // follow the seeding skill's discoverable / no-orphan convention + smoke test
    expect(p).toMatch(/no-orphan|catalogue|discoverable/i)
    expect(p).toMatch(/smoke test/i)
    expect(p).toContain("devSeed.test.ts")
    // committed code held to the same bar as any change
    expect(p).toMatch(/code review|committed code|same bars?/i)
    // seedable-vs-genuinely-un-seedable is the deciding line
    expect(p).toMatch(/un-mockable|OAuth|webhook|disproportionate/i)
    expect(p).toMatch(/deciding line/i)
  })

  test("carries the marketing-screenshot block keyed off this build's changelog diff", () => {
    const p = execPrompt()
    expect(p).toContain("apps/docs/public/changelog")
    expect(p).toContain("/changelog/")
    expect(p).toContain("## Smaller changes")
    // detection diff against the base
    expect(p).toContain("origin/main..HEAD")
    expect(p).toMatch(/idempoten/i)
    expect(p).toMatch(/non-clobber|clobber/i)
    // consequence: gate fails if a featured section's marketing shot is missing
    expect(p).toMatch(/gate FAILS|routes back/i)
  })
})

describe("fallbackE2ePlanArtifact", () => {
  const reason = "planner escalated: spec ambiguous about flow ordering"
  test("interpolates the reason and frames it as a planning/pipeline limitation", () => {
    const a = fallbackE2ePlanArtifact(reason)
    expect(a).toContain(reason)
    expect(a).toMatch(/planning|pipeline/i)
    // must NOT pre-declare the feature's flows untestable
    expect(a).not.toMatch(/all flows.*untestable|every flow.*untestable/i)
  })

  test("instructs execute to derive scope from the spec and make a best-effort pass", () => {
    const a = fallbackE2ePlanArtifact(reason)
    expect(a).toMatch(/happy path/i)
    expect(a).toMatch(/derive.*from the spec|from the spec/i)
    expect(a).toMatch(/spec\.md|spec/i)
  })

  test("keeps the broken-vs-untestable rule and the report distinction", () => {
    const a = fallbackE2ePlanArtifact(reason)
    expect(a).toContain("e2e-infra")
    expect(a).toContain("E2E_PASS")
    expect(a).toContain("E2E_FAIL")
    // planner-failed (pipeline) and flow-untestable kept separate in the report
    expect(a).toMatch(/separate|distinguish|two things/i)
  })
})

describe("evalPlanPrompt", () => {
  test("references plan + coverage-contract paths, the eval skill, PLAN_DONE", () => {
    const p = evalPlanPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      baseBranch: "main",
      revising: false,
    })
    expect(p).toContain(`${buildDir}/eval-plan.md`)
    expect(p).toContain(`${buildDir}/eval-required-cases.json`)
    expect(p).toContain(".claude/skills/eval/SKILL.md")
    expect(p).toContain("origin/main..HEAD")
    expect(p).toContain("relevant subset")
    expect(p).toContain("PLAN_DONE")
    expect(p).toContain("ESCALATE:")
    expect(p).toContain("- **kind:** eval-infra")
  })
  test("revising mode points at the prior critique", () => {
    const p = evalPlanPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      baseBranch: "main",
      revising: true,
    })
    expect(p).toContain(`${buildDir}/eval-plan-review.md`)
    expect(p).toContain("revision")
  })
})

describe("evalPlanReviewPrompt", () => {
  test("critiques the plan + coverage contract; lists all three verdicts", () => {
    const p = evalPlanReviewPrompt({
      feature: "build-flow",
      buildDir,
      specPath,
    })
    expect(p).toContain(`${buildDir}/eval-plan.md`)
    expect(p).toContain(`${buildDir}/eval-required-cases.json`)
    expect(p).toContain("APPROVED")
    expect(p).toContain("NEEDS_REVISION")
    expect(p).toContain("ESCALATE:")
    expect(p).toContain("faithful to the diff")
  })
})

describe("evalExecutePrompt", () => {
  function p() {
    return evalExecutePrompt({
      feature: "build-flow",
      buildDir,
      specPath,
      baseBranch: "main",
    })
  }
  test("references artifacts, the skill, run command, and the EVAL sentinels", () => {
    const out = p()
    expect(out).toContain(`${buildDir}/eval-plan.md`)
    expect(out).toContain(`${buildDir}/eval-required-cases.json`)
    expect(out).toContain(`${buildDir}/eval-run.json`)
    expect(out).toContain("apps/web/evals/baselines.json")
    expect(out).toContain(".claude/skills/eval/SKILL.md")
    expect(out).toContain("bunx evalite run")
    expect(out).toContain("--threshold=0")
    expect(out).toContain("EVAL_PASS")
    expect(out).toContain("EVAL_FAIL")
    expect(out).toContain("git show origin/main")
  })
  test("names the self-commit split (cases + baseline yes; build-dir artifacts no)", () => {
    const out = p()
    expect(out).toContain("apps/web/evals/cases/**/*.eval.ts")
    expect(out).toContain("Do NOT self-commit the build-dir artifacts")
  })
})

describe("fallbackEvalPlanArtifact", () => {
  const reason = "planner escalated: no clear prompt delta"
  test("interpolates the reason and frames it as a pipeline limitation", () => {
    const a = fallbackEvalPlanArtifact(reason)
    expect(a).toContain(reason)
    expect(a).toMatch(/planning|pipeline/i)
  })
  test("instructs execute to derive prompts, write its own contract, and run the subset", () => {
    const a = fallbackEvalPlanArtifact(reason)
    expect(a).toContain("eval-required-cases.json")
    expect(a).toContain("EVAL_PASS")
    expect(a).toContain("EVAL_FAIL")
    expect(a).toMatch(/relevant subset/i)
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

describe("single-turn guardrail (PRO-639)", () => {
  const GUARDRAIL_PHRASES = [
    "Background-task notifications",
    "SYNCHRONOUSLY in the FOREGROUND",
  ]
  const expectGuardrail = (p: string) => {
    for (const phrase of GUARDRAIL_PHRASES) expect(p).toContain(phrase)
  }

  test("planPrompt carries the guardrail", () => {
    expectGuardrail(
      planPrompt({ feature: "f", buildDir, specPath, revising: false }),
    )
  })
  test("buildPrompt carries the guardrail", () => {
    expectGuardrail(buildPrompt({ feature: "f", buildDir, specPath }))
  })
  test("e2ePlanPrompt carries the guardrail", () => {
    expectGuardrail(
      e2ePlanPrompt({ feature: "f", buildDir, specPath, revising: false }),
    )
  })
  test("e2eExecutePrompt carries the guardrail", () => {
    expectGuardrail(
      e2eExecutePrompt({
        feature: "f",
        buildDir,
        specPath,
        devUrl: "https://x.dispatch.localhost",
        baseBranch: "main",
      }),
    )
  })
  test("evalPlanPrompt carries the guardrail", () => {
    expectGuardrail(
      evalPlanPrompt({
        feature: "f",
        buildDir,
        specPath,
        baseBranch: "main",
        revising: false,
      }),
    )
  })
  test("evalExecutePrompt carries the guardrail", () => {
    expectGuardrail(
      evalExecutePrompt({
        feature: "f",
        buildDir,
        specPath,
        baseBranch: "main",
      }),
    )
  })
  test("reviewResponsePrompt carries the guardrail", () => {
    expectGuardrail(reviewResponsePrompt({ feature: "f", buildDir, round: 1 }))
  })
  test("prPrompt carries the guardrail", () => {
    expectGuardrail(prPrompt("f"))
  })
  test("monitorCiFixPrompt carries the guardrail", () => {
    expectGuardrail(monitorCiFixPrompt("f", ["test"]))
  })
  test("monitorAddressReviewPrompt carries the guardrail", () => {
    expectGuardrail(monitorAddressReviewPrompt("f", 7))
  })
})
