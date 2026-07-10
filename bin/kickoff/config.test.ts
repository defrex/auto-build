import { describe, expect, test } from "bun:test"
import {
  DEFAULT_CAPS,
  DEFAULT_MAX_CONCURRENT_BUILDS,
  DEFAULT_SENTRY,
  resolveConfig,
  validateConfig,
} from "./config"

const fullLinear = {
  teamId: "team_1",
  projectId: "proj_1",
  triageStateId: "s_triage",
  readyStateId: "s_ready",
  inProgressStateId: "s_progress",
  inReviewStateId: "s_review",
  doneStateId: "s_done",
  rejectedStateIds: ["s_rejected"],
  sourceObservationsLabelId: "l_obs",
  sourceSentryLabelId: "l_sentry",
  needsDefinitionLabelId: "l_needs_def",
}

describe("resolveConfig", () => {
  test("applies tunable defaults when the file omits them", () => {
    const config = resolveConfig({ linear: fullLinear })
    expect(config.sentry).toEqual(DEFAULT_SENTRY)
    expect(config.caps).toEqual(DEFAULT_CAPS)
    expect(config.maxConcurrentBuilds).toBe(DEFAULT_MAX_CONCURRENT_BUILDS)
  })

  test("honors a minAffectedUsers: 0 override (not dropped as falsy)", () => {
    const config = resolveConfig({
      linear: fullLinear,
      sentry: { minAffectedUsers: 0 },
    })
    expect(config.sentry.minAffectedUsers).toBe(0)
  })

  test("file values override tunable defaults", () => {
    const config = resolveConfig({
      linear: fullLinear,
      sentry: { minEvents: 100 },
      caps: { maxNewIssuesPerRun: 1 },
      maxConcurrentBuilds: 3,
    })
    expect(config.sentry.minEvents).toBe(100)
    // unspecified sentry fields keep their default
    expect(config.sentry.lookbackDays).toBe(DEFAULT_SENTRY.lookbackDays)
    expect(config.caps.maxNewIssuesPerRun).toBe(1)
    expect(config.maxConcurrentBuilds).toBe(3)
  })

  test("defaults caps.adversarialReviewRounds to 3 when absent", () => {
    const config = resolveConfig({
      linear: fullLinear,
      caps: { maxNewIssuesPerRun: 1 },
    })
    expect(config.caps.adversarialReviewRounds).toBe(3)
    expect(DEFAULT_CAPS.adversarialReviewRounds).toBe(3)
  })

  test("respects a caps.adversarialReviewRounds override", () => {
    const config = resolveConfig({
      linear: fullLinear,
      caps: { adversarialReviewRounds: 5 },
    })
    expect(config.caps.adversarialReviewRounds).toBe(5)
  })

  test("env vars override Linear IDs from the file", () => {
    const config = resolveConfig(
      { linear: { ...fullLinear, teamId: "from_file" } },
      { KICKOFF_LINEAR_TEAM_ID: "from_env" },
    )
    expect(config.linear.teamId).toBe("from_env")
  })

  test("KICKOFF_LINEAR_NEEDS_DEFINITION_LABEL_ID overrides the file value", () => {
    const config = resolveConfig(
      { linear: { ...fullLinear, needsDefinitionLabelId: "from_file" } },
      { KICKOFF_LINEAR_NEEDS_DEFINITION_LABEL_ID: "from_env" },
    )
    expect(config.linear.needsDefinitionLabelId).toBe("from_env")
  })

  test("empty env var does not clobber a file value", () => {
    const config = resolveConfig(
      { linear: fullLinear },
      { KICKOFF_LINEAR_TEAM_ID: "" },
    )
    expect(config.linear.teamId).toBe("team_1")
  })

  test("defaults inReviewStateId to '' when the file omits it (old configs resolve cleanly)", () => {
    const { inReviewStateId, ...rest } = fullLinear
    const config = resolveConfig({ linear: rest })
    expect(config.linear.inReviewStateId).toBe("")
  })

  test("KICKOFF_LINEAR_IN_REVIEW_STATE_ID overrides the file value", () => {
    const config = resolveConfig(
      { linear: { ...fullLinear, inReviewStateId: "from_file" } },
      { KICKOFF_LINEAR_IN_REVIEW_STATE_ID: "from_env" },
    )
    expect(config.linear.inReviewStateId).toBe("from_env")
  })

  test("empty KICKOFF_LINEAR_IN_REVIEW_STATE_ID does not clobber the file value", () => {
    const config = resolveConfig(
      { linear: { ...fullLinear, inReviewStateId: "s_review" } },
      { KICKOFF_LINEAR_IN_REVIEW_STATE_ID: "" },
    )
    expect(config.linear.inReviewStateId).toBe("s_review")
  })

  test("defaults rejectedStateIds to [] when missing", () => {
    const { rejectedStateIds, ...rest } = fullLinear
    const config = resolveConfig({ linear: rest })
    expect(config.linear.rejectedStateIds).toEqual([])
  })

  test("defaults the worktree provider to git", () => {
    const config = resolveConfig({ linear: fullLinear })
    expect(config.worktree).toEqual({ provider: "git", supersetProjectId: "" })
  })

  test("file values set the worktree provider", () => {
    const config = resolveConfig({
      linear: fullLinear,
      worktree: { provider: "superset", supersetProjectId: "proj-uuid" },
    })
    expect(config.worktree.provider).toBe("superset")
    expect(config.worktree.supersetProjectId).toBe("proj-uuid")
  })

  test("accepts the herdr worktree provider", () => {
    const config = resolveConfig({
      linear: fullLinear,
      worktree: { provider: "herdr" },
    })
    expect(config.worktree.provider).toBe("herdr")
  })

  test("KICKOFF_WORKTREE_PROVIDER=herdr env override resolves to herdr", () => {
    const config = resolveConfig(
      { linear: fullLinear },
      { KICKOFF_WORKTREE_PROVIDER: "herdr" },
    )
    expect(config.worktree.provider).toBe("herdr")
  })

  test("env vars override the worktree provider from the file", () => {
    const config = resolveConfig(
      { linear: fullLinear, worktree: { provider: "superset" } },
      {
        KICKOFF_WORKTREE_PROVIDER: "git",
        KICKOFF_SUPERSET_PROJECT_ID: "env-proj",
      },
    )
    expect(config.worktree.provider).toBe("git")
    expect(config.worktree.supersetProjectId).toBe("env-proj")
  })
})

describe("validateConfig", () => {
  test("passes when all required IDs are set", () => {
    expect(() =>
      validateConfig(resolveConfig({ linear: fullLinear })),
    ).not.toThrow()
  })

  test("throws naming every missing ID when unset", () => {
    const config = resolveConfig({
      linear: { ...fullLinear, teamId: "", readyStateId: "  " },
    })
    expect(() => validateConfig(config)).toThrow(/teamId/)
    expect(() => validateConfig(config)).toThrow(/readyStateId/)
  })

  test("throws when needsDefinitionLabelId is unset", () => {
    const config = resolveConfig({
      linear: { ...fullLinear, needsDefinitionLabelId: "" },
    })
    expect(() => validateConfig(config)).toThrow(/needsDefinitionLabelId/)
  })

  test("passes when projectId is empty but every other required ID is set", () => {
    const config = resolveConfig({
      linear: { ...fullLinear, projectId: "" },
    })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test("rejectedStateIds is not required (empty is allowed)", () => {
    const config = resolveConfig({
      linear: { ...fullLinear, rejectedStateIds: [] },
    })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test("inReviewStateId is optional — validation passes when it is empty", () => {
    const config = resolveConfig({
      linear: { ...fullLinear, inReviewStateId: "" },
    })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test("superset provider requires supersetProjectId", () => {
    const config = resolveConfig({
      linear: fullLinear,
      worktree: { provider: "superset" },
    })
    expect(() => validateConfig(config)).toThrow(/supersetProjectId/)
  })

  test("herdr provider does not require supersetProjectId", () => {
    const config = resolveConfig({
      linear: fullLinear,
      worktree: { provider: "herdr" },
    })
    expect(() => validateConfig(config)).not.toThrow()
  })

  test("unknown worktree provider is rejected", () => {
    const config = resolveConfig({
      linear: fullLinear,
      worktree: { provider: "tmux" },
    })
    expect(() => validateConfig(config)).toThrow(/worktree provider/)
  })

  test("unknown worktree provider from env is rejected", () => {
    const config = resolveConfig(
      { linear: fullLinear },
      { KICKOFF_WORKTREE_PROVIDER: "tmux" },
    )
    expect(() => validateConfig(config)).toThrow(/worktree provider/)
  })

  test("null supersetProjectId still gets the pinning message", () => {
    const config = resolveConfig({
      linear: fullLinear,
      worktree: { provider: "superset", supersetProjectId: null },
    })
    expect(() => validateConfig(config)).toThrow(/supersetProjectId/)
  })
})
