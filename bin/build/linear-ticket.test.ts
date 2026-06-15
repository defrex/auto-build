import { describe, expect, test } from "bun:test"
import { resolveConfig } from "../kickoff/config"
import {
  type EnsureTicketDeps,
  ensureLinearTicket,
  parseEnsureResult,
  shouldEnsureTicket,
} from "./linear-ticket"
import { initState } from "./state"

const pinnedConfig = resolveConfig({
  linear: {
    teamId: "team_1",
    projectId: "proj_1",
    triageStateId: "s_t",
    readyStateId: "s_r",
    inProgressStateId: "s_progress",
    doneStateId: "s_d",
    rejectedStateIds: [],
    sourceObservationsLabelId: "l_o",
    sourceSentryLabelId: "l_s",
    needsDefinitionLabelId: "l_nd",
  },
})

const baseState = initState(
  "build-flow",
  "battle-silene",
  "2026-06-09T00:00:00Z",
)
const baseArgs = {
  buildDir: "/repo/build/build-flow",
  specPath: "/repo/build/build-flow/spec.md",
  feature: "build-flow",
  config: pinnedConfig,
  state: baseState,
}

function recorder(runEnsureAgent: EnsureTicketDeps["runEnsureAgent"]): {
  deps: EnsureTicketDeps
  prompts: string[]
  logs: string[]
} {
  const prompts: string[] = []
  const logs: string[] = []
  const deps: EnsureTicketDeps = {
    runEnsureAgent: async (a) => {
      prompts.push(a.prompt)
      return runEnsureAgent(a)
    },
    log: (m) => logs.push(m),
  }
  return { deps, prompts, logs }
}

describe("shouldEnsureTicket", () => {
  test("skips when teamId is empty (config not pinned)", () => {
    const d = shouldEnsureTicket({
      teamId: "",
      inProgressStateId: "s",
      projectId: "",
    })
    expect(d.skip).toBe(true)
    if (d.skip) expect(d.reason).toMatch(/config|pin/i)
  })

  test("skips when inProgressStateId is empty", () => {
    const d = shouldEnsureTicket({
      teamId: "t",
      inProgressStateId: "",
      projectId: "",
    })
    expect(d.skip).toBe(true)
  })

  test("proceeds when both are set", () => {
    const d = shouldEnsureTicket({
      teamId: "t",
      inProgressStateId: "s",
      projectId: "",
    })
    expect(d).toEqual({ skip: false, proceed: true })
  })
})

describe("parseEnsureResult", () => {
  test("parses a well-formed result", () => {
    expect(parseEnsureResult('{"issueId":"PRO-1","issueUuid":"u"}')).toEqual({
      issueId: "PRO-1",
      issueUuid: "u",
    })
  })

  test("returns null for malformed or missing-field JSON", () => {
    expect(parseEnsureResult("not json")).toBeNull()
    expect(parseEnsureResult('{"issueId":"PRO-1"}')).toBeNull()
    expect(parseEnsureResult('{"issueUuid":"u"}')).toBeNull()
    expect(parseEnsureResult('{"issueId":"","issueUuid":"u"}')).toBeNull()
  })
})

describe("ensureLinearTicket", () => {
  test("skip path: unpinned config → unchanged state, warning logged, agent not run", async () => {
    const unpinned = resolveConfig({ linear: {} })
    let ran = false
    const { deps, logs } = recorder(async () => {
      ran = true
      return { code: 0, resultRaw: null }
    })
    const out = await ensureLinearTicket(
      { ...baseArgs, config: unpinned },
      deps,
    )
    expect(out).toEqual(baseState)
    expect(ran).toBe(false)
    expect(logs.some((l) => /linear|ticket|config|pin/i.test(l))).toBe(true)
  })

  test("create path: no id, agent returns a new id → state gets the id", async () => {
    const { deps, prompts } = recorder(async () => ({
      code: 0,
      resultRaw: '{"issueId":"PRO-9","issueUuid":"uuid-9"}',
    }))
    const out = await ensureLinearTicket(baseArgs, deps)
    expect(out.linearIssueId).toBe("PRO-9")
    expect(out.linearIssueUuid).toBe("uuid-9")
    // no-id mode prompt: contains branch + marker, not an existing-issue id
    expect(prompts[0]).toContain("battle-silene")
    expect(prompts[0]).toContain("build/build-flow")
    expect(prompts[0]).not.toContain("EXISTING-ISSUE MODE")
  })

  test("existing-id sync: state has id, agent returns same id → id preserved, existing-id-mode prompt", async () => {
    const stateWithId = {
      ...baseState,
      linearIssueId: "PRO-7",
      linearIssueUuid: "uuid-7",
    }
    const { deps, prompts } = recorder(async () => ({
      code: 0,
      resultRaw: '{"issueId":"PRO-7","issueUuid":"uuid-7"}',
    }))
    const out = await ensureLinearTicket(
      { ...baseArgs, state: stateWithId },
      deps,
    )
    expect(out.linearIssueId).toBe("PRO-7")
    expect(prompts[0]).toContain("EXISTING-ISSUE MODE")
    expect(prompts[0]).toContain("PRO-7")
  })

  test("existing-id sync fails: agent non-zero → unchanged state, warning, no throw", async () => {
    const stateWithId = {
      ...baseState,
      linearIssueId: "PRO-7",
      linearIssueUuid: "uuid-7",
    }
    const { deps, logs } = recorder(async () => ({
      code: 1,
      resultRaw: null,
    }))
    const out = await ensureLinearTicket(
      { ...baseArgs, state: stateWithId },
      deps,
    )
    expect(out.linearIssueId).toBe("PRO-7")
    expect(logs.some((l) => /warn|fail|linear|ticket/i.test(l))).toBe(true)
  })

  test("generic failure: no id, agent throws → unchanged state, warning, no throw", async () => {
    const { deps, logs } = recorder(async () => {
      throw new Error("MCP auth boom")
    })
    const out = await ensureLinearTicket(baseArgs, deps)
    expect(out).toEqual(baseState)
    expect(out.linearIssueId).toBeUndefined()
    expect(logs.some((l) => /warn|fail|linear|ticket/i.test(l))).toBe(true)
  })

  test("malformed result: agent exits 0 but writes junk → unchanged state, warning", async () => {
    const { deps, logs } = recorder(async () => ({
      code: 0,
      resultRaw: "garbage",
    }))
    const out = await ensureLinearTicket(baseArgs, deps)
    expect(out.linearIssueId).toBeUndefined()
    expect(logs.some((l) => /warn|fail|linear|ticket/i.test(l))).toBe(true)
  })
})
