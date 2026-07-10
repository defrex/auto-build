import { describe, expect, test } from "bun:test"
import { resolveConfig } from "../kickoff/config"
import {
  advanceTicketToInReview,
  type InReviewDeps,
  parseInReviewResult,
  shouldAdvanceToInReview,
} from "./linear-status"
import { initState } from "./state"

const pinnedLinear = resolveConfig({
  linear: {
    teamId: "team_1",
    projectId: "",
    triageStateId: "s_t",
    readyStateId: "s_r",
    inProgressStateId: "s_progress",
    inReviewStateId: "s_review",
    doneStateId: "s_d",
    rejectedStateIds: [],
    sourceObservationsLabelId: "l_o",
    sourceSentryLabelId: "l_s",
    needsDefinitionLabelId: "l_nd",
  },
}).linear

const baseState = initState(
  "build-flow",
  "battle-silene",
  "2026-06-09T00:00:00Z",
)
const stateWithId = {
  ...baseState,
  linearIssueId: "PRO-7",
  linearIssueUuid: "uuid-7",
}

const baseArgs = {
  buildDir: "/repo/build/build-flow",
  feature: "build-flow",
  linear: pinnedLinear,
  state: stateWithId,
}

function recorder(runStatusAgent: InReviewDeps["runStatusAgent"]): {
  deps: InReviewDeps
  prompts: string[]
  logs: string[]
} {
  const prompts: string[] = []
  const logs: string[] = []
  const deps: InReviewDeps = {
    runStatusAgent: async (a) => {
      prompts.push(a.prompt)
      return runStatusAgent(a)
    },
    log: (m) => logs.push(m),
  }
  return { deps, prompts, logs }
}

describe("shouldAdvanceToInReview", () => {
  test("skips when inReviewStateId is empty (unpinned)", () => {
    const d = shouldAdvanceToInReview({
      inReviewStateId: "",
      linearIssueId: "PRO-7",
    })
    expect(d.skip).toBe(true)
    if (d.skip) expect(d.reason).toMatch(/in-?review|pin/i)
  })

  test("skips when no linearIssueId is recorded", () => {
    const d = shouldAdvanceToInReview({
      inReviewStateId: "s_review",
      linearIssueId: undefined,
    })
    expect(d.skip).toBe(true)
    if (d.skip) expect(d.reason).toMatch(/linearIssueId/i)
  })

  test("proceeds when both are present", () => {
    const d = shouldAdvanceToInReview({
      inReviewStateId: "s_review",
      linearIssueId: "PRO-7",
    })
    expect(d).toEqual({ skip: false, proceed: true })
  })
})

describe("parseInReviewResult", () => {
  test('parses {"moved":true} and {"moved":false}', () => {
    expect(parseInReviewResult('{"moved":true}')).toEqual({ moved: true })
    expect(parseInReviewResult('{"moved":false}')).toEqual({ moved: false })
  })

  test("returns null on malformed / missing / non-boolean", () => {
    expect(parseInReviewResult("not json")).toBeNull()
    expect(parseInReviewResult("{}")).toBeNull()
    expect(parseInReviewResult('{"moved":"yes"}')).toBeNull()
  })
})

describe("advanceTicketToInReview", () => {
  test("unpinned in-review id → agent not run, warning logged, no throw", async () => {
    let ran = false
    const { deps, logs } = recorder(async () => {
      ran = true
      return { code: 0, resultRaw: null }
    })
    await advanceTicketToInReview(
      { ...baseArgs, linear: { ...pinnedLinear, inReviewStateId: "" } },
      deps,
    )
    expect(ran).toBe(false)
    expect(logs.some((l) => /in-?review/i.test(l))).toBe(true)
  })

  test("no recorded id → agent not run, warning logged", async () => {
    let ran = false
    const { deps, logs } = recorder(async () => {
      ran = true
      return { code: 0, resultRaw: null }
    })
    await advanceTicketToInReview({ ...baseArgs, state: baseState }, deps)
    expect(ran).toBe(false)
    expect(logs.some((l) => /in-?review|linearIssueId/i.test(l))).toBe(true)
  })

  test("happy moved:true → agent run once, prompt carries target + rule, 'advanced' logged", async () => {
    const { deps, prompts, logs } = recorder(async () => ({
      code: 0,
      resultRaw: '{"moved":true}',
    }))
    await advanceTicketToInReview(baseArgs, deps)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("s_review")
    expect(prompts[0]).toMatch(/forward-only state advance/i)
    expect(prompts[0]).toContain("PRO-7")
    expect(logs.some((l) => /advanced/i.test(l))).toBe(true)
  })

  test("moved:false → 'no-op'/'already' logged", async () => {
    const { deps, logs } = recorder(async () => ({
      code: 0,
      resultRaw: '{"moved":false}',
    }))
    await advanceTicketToInReview(baseArgs, deps)
    expect(logs.some((l) => /no-op|already/i.test(l))).toBe(true)
  })

  test("agent non-zero exit → warning logged, no throw", async () => {
    const { deps, logs } = recorder(async () => ({ code: 1, resultRaw: null }))
    await advanceTicketToInReview(baseArgs, deps)
    expect(logs.some((l) => /warn|exit|in-?review/i.test(l))).toBe(true)
  })

  test("agent throws → warning logged, returns normally (no throw out)", async () => {
    const { deps, logs } = recorder(async () => {
      throw new Error("MCP boom")
    })
    await advanceTicketToInReview(baseArgs, deps)
    expect(logs.some((l) => /fail|in-?review/i.test(l))).toBe(true)
  })

  test("malformed result → 'unreadable' logged, no throw", async () => {
    const { deps, logs } = recorder(async () => ({
      code: 0,
      resultRaw: "garbage",
    }))
    await advanceTicketToInReview(baseArgs, deps)
    expect(logs.some((l) => /unreadable|completed/i.test(l))).toBe(true)
  })
})
