import { describe, expect, test } from "bun:test"
import { resolveConfig } from "./config"
import { kickoffSelectPrompt } from "./prompts"

const config = resolveConfig({
  linear: {
    teamId: "team_1",
    projectId: "proj_1",
    triageStateId: "s_triage",
    readyStateId: "s_ready",
    inProgressStateId: "s_progress",
    doneStateId: "s_done",
    rejectedStateIds: ["s_rejected"],
    sourceObservationsLabelId: "l_obs",
    sourceSentryLabelId: "l_sentry",
    needsDefinitionLabelId: "l_needs_def",
  },
  maxConcurrentBuilds: 2,
})

describe("kickoffSelectPrompt", () => {
  const prompt = kickoffSelectPrompt({ config, resultPath: "/tmp/r.json" })

  test("includes the ready state, needs-definition exclusion, and concurrency cap", () => {
    expect(prompt).toContain("s_ready")
    expect(prompt).toContain("l_needs_def")
    expect(prompt).toMatch(/needs-definition/i)
    expect(prompt).toMatch(/EXCLUDE/)
    expect(prompt).toContain("Max concurrent builds: 2")
  })

  test("instructs the agent to claim (move to In-Progress) before building", () => {
    expect(prompt).toContain("s_progress")
    expect(prompt).toMatch(/claim it before building/i)
  })

  test("tells the agent where to write the result JSON", () => {
    expect(prompt).toContain("/tmp/r.json")
  })

  test("forbids code edits / PRs in the select step", () => {
    expect(prompt).toMatch(/Do not edit any code/i)
  })

  test("includes the project when projectId is set", () => {
    expect(prompt).toContain("proj_1")
    expect(prompt).toMatch(/Project:/)
  })
})

describe("kickoffSelectPrompt without a project", () => {
  const teamOnly = resolveConfig({
    linear: {
      teamId: "team_1",
      projectId: "",
      triageStateId: "s_triage",
      readyStateId: "s_ready",
      inProgressStateId: "s_progress",
      doneStateId: "s_done",
      rejectedStateIds: ["s_rejected"],
      sourceObservationsLabelId: "l_obs",
      sourceSentryLabelId: "l_sentry",
      needsDefinitionLabelId: "l_needs_def",
    },
    maxConcurrentBuilds: 2,
  })
  const prompt = kickoffSelectPrompt({
    config: teamOnly,
    resultPath: "/tmp/r.json",
  })

  test("omits the Project: line and scopes to the team only", () => {
    expect(prompt).not.toMatch(/Project:/)
    expect(prompt).not.toContain("/project")
    expect(prompt).toContain("for this team")
  })
})
