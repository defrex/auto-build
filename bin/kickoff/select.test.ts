/**
 * Impure-runner tests for the deterministic claim-select. The GraphQL transport
 * is faked (keyed by operation name), so we pin the orchestration: the
 * at-capacity short-circuit (no candidate fetch, no claim), nothing-ready, the
 * happy claim (mutation variables + mapped `SelectResult`), a failed mutation,
 * the blocked-then-eligible skip, the project-scoped filter, and Ready
 * pagination merging pages before deciding.
 */

import { describe, expect, test } from "bun:test"
import { type KickoffConfig, resolveConfig } from "./config"
import type { LinearGraphql } from "./linear-client"
import { runDeterministicSelect } from "./select"

const LINEAR = {
  teamId: "team-1",
  projectId: "",
  triageStateId: "s_t",
  readyStateId: "s_ready",
  inProgressStateId: "s_inprog",
  doneStateId: "s_done",
  rejectedStateIds: [],
  sourceObservationsLabelId: "l_obs",
  sourceSentryLabelId: "l_sentry",
  needsDefinitionLabelId: "l_nd",
}

function makeConfig(over: Record<string, unknown> = {}): KickoffConfig {
  return resolveConfig({
    linear: { ...LINEAR, ...((over.linear as object) ?? {}) },
    maxConcurrentBuilds: (over.maxConcurrentBuilds as number) ?? 2,
    worktree: { provider: "git" },
  })
}

type Page<T> = {
  nodes: T[]
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
}
function page<T>(nodes: T[], hasNext = false): Page<T> {
  return {
    nodes,
    pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? "c" : null },
  }
}

type Handlers = {
  count?: (vars: Record<string, unknown>) => unknown
  ready?: (vars: Record<string, unknown>) => unknown
  claim?: (vars: Record<string, unknown>) => unknown
}

function makeFakeGraphql(handlers: Handlers): {
  graphql: LinearGraphql
  calls: { op: string; vars: Record<string, unknown> }[]
} {
  const calls: { op: string; vars: Record<string, unknown> }[] = []
  const graphql = (async (
    query: string,
    vars: Record<string, unknown> = {},
  ) => {
    if (query.includes("KickoffClaimIssue")) {
      calls.push({ op: "claim", vars })
      if (!handlers.claim) throw new Error("claim unexpectedly called")
      return handlers.claim(vars)
    }
    if (query.includes("KickoffReadyCandidates")) {
      calls.push({ op: "ready", vars })
      if (!handlers.ready) throw new Error("ready unexpectedly called")
      return handlers.ready(vars)
    }
    if (query.includes("KickoffInProgressCount")) {
      calls.push({ op: "count", vars })
      if (!handlers.count) throw new Error("count unexpectedly called")
      return handlers.count(vars)
    }
    throw new Error(`unexpected query: ${query.slice(0, 40)}`)
  }) as unknown as LinearGraphql
  return { graphql, calls }
}

const log = () => {}

let seq = 0
function readyNode(over: Record<string, unknown> = {}) {
  seq += 1
  return {
    id: `u-${seq}`,
    identifier: `PRO-${seq}`,
    title: `t${seq}`,
    description: `d${seq}`,
    priority: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    labels: { nodes: [] },
    inverseRelations: { nodes: [] },
    ...over,
  }
}

describe("runDeterministicSelect", () => {
  test("at capacity → {none, atCapacity} without fetching candidates or claiming", async () => {
    const { graphql, calls } = makeFakeGraphql({
      count: () => ({ issues: page([{ id: "a" }, { id: "b" }]) }),
    })
    const result = await runDeterministicSelect(
      { config: makeConfig({ maxConcurrentBuilds: 2 }) },
      { graphql, log },
    )
    expect(result).toEqual({ none: true, atCapacity: true })
    expect(calls.map((c) => c.op)).toEqual(["count"])
  })

  test("nothing ready → {none} and no claim", async () => {
    const { graphql, calls } = makeFakeGraphql({
      count: () => ({ issues: page([]) }),
      ready: () => ({ issues: page([]) }),
    })
    const result = await runDeterministicSelect(
      { config: makeConfig() },
      { graphql, log },
    )
    expect(result).toEqual({ none: true })
    expect(calls.some((c) => c.op === "claim")).toBe(false)
  })

  test("happy path claims the chosen issue and maps SelectResult", async () => {
    const node = readyNode({
      id: "uuid-1",
      identifier: "PRO-42",
      title: "Fix thing",
      description: "the full brief",
      priority: 1,
      labels: { nodes: [{ id: "l_sentry" }] },
    })
    const { graphql, calls } = makeFakeGraphql({
      count: () => ({ issues: page([]) }),
      ready: () => ({ issues: page([node]) }),
      claim: () => ({
        issueUpdate: { success: true, issue: { id: "uuid-1" } },
      }),
    })
    const result = await runDeterministicSelect(
      { config: makeConfig() },
      { graphql, log },
    )
    expect(result).toEqual({
      inProgressCount: 0,
      issueId: "PRO-42",
      issueUuid: "uuid-1",
      title: "Fix thing",
      brief: "the full brief",
      source: "sentry",
    })
    const claim = calls.find((c) => c.op === "claim")
    expect(claim?.vars).toEqual({ id: "uuid-1", stateId: "s_inprog" })

    // The Ready filter must exclude needs-definition via `every: neq` — Linear's
    // IssueLabelCollectionFilter has no `none` (a `none` filter 400s the API).
    const readyVars = calls.find((c) => c.op === "ready")?.vars as {
      filter: { labels?: unknown; state?: unknown }
    }
    expect(readyVars.filter.labels).toEqual({ every: { id: { neq: "l_nd" } } })
    expect(readyVars.filter.state).toEqual({ id: { eq: "s_ready" } })
  })

  test("a failed claim mutation throws", async () => {
    const { graphql } = makeFakeGraphql({
      count: () => ({ issues: page([]) }),
      ready: () => ({ issues: page([readyNode()]) }),
      claim: () => ({ issueUpdate: { success: false } }),
    })
    await expect(
      runDeterministicSelect({ config: makeConfig() }, { graphql, log }),
    ).rejects.toThrow(/claim/i)
  })

  test("a count-fetch failure propagates (not swallowed into {none})", async () => {
    const graphql = (async () => {
      throw new Error("count boom")
    }) as unknown as LinearGraphql
    await expect(
      runDeterministicSelect({ config: makeConfig() }, { graphql, log }),
    ).rejects.toThrow("count boom")
  })

  test("a ready-fetch failure propagates (not swallowed into {none})", async () => {
    const { graphql } = makeFakeGraphql({
      count: () => ({ issues: page([]) }),
      ready: () => {
        throw new Error("ready boom")
      },
    })
    await expect(
      runDeterministicSelect({ config: makeConfig() }, { graphql, log }),
    ).rejects.toThrow("ready boom")
  })

  test("skips a blocked higher-priority candidate for an eligible lower one", async () => {
    const blocked = readyNode({
      id: "blocked",
      priority: 1,
      inverseRelations: {
        nodes: [
          { type: "blocks", issue: { id: "x", state: { type: "started" } } },
        ],
      },
    })
    const eligible = readyNode({ id: "eligible", priority: 4 })
    const { graphql, calls } = makeFakeGraphql({
      count: () => ({ issues: page([]) }),
      ready: () => ({ issues: page([blocked, eligible]) }),
      claim: () => ({
        issueUpdate: { success: true, issue: { id: "eligible" } },
      }),
    })
    const result = await runDeterministicSelect(
      { config: makeConfig() },
      { graphql, log },
    )
    expect(result).toMatchObject({ issueUuid: "eligible" })
    expect(calls.find((c) => c.op === "claim")?.vars).toMatchObject({
      id: "eligible",
    })
  })

  test("ignores a 'blocks' (outgoing) relation — only inverse 'blocks' gate", async () => {
    // inverseRelations carries only blocked-by; a node with no inverse relations
    // is eligible even though it blocks others elsewhere.
    const node = readyNode({ id: "free", inverseRelations: { nodes: [] } })
    const { graphql } = makeFakeGraphql({
      count: () => ({ issues: page([]) }),
      ready: () => ({ issues: page([node]) }),
      claim: () => ({ issueUpdate: { success: true, issue: { id: "free" } } }),
    })
    const result = await runDeterministicSelect(
      { config: makeConfig() },
      { graphql, log },
    )
    expect(result).toMatchObject({ issueUuid: "free" })
  })

  test("project clause present when projectId set, absent otherwise", async () => {
    const withProject = makeFakeGraphql({
      count: () => ({ issues: page([{ id: "a" }, { id: "b" }, { id: "c" }]) }),
    })
    await runDeterministicSelect(
      {
        config: makeConfig({
          linear: { projectId: "proj-9" },
          maxConcurrentBuilds: 1,
        }),
      },
      { graphql: withProject.graphql, log },
    )
    const countVars = withProject.calls[0]?.vars as {
      filter: Record<string, unknown>
    }
    expect(countVars.filter.project).toEqual({ id: { eq: "proj-9" } })

    const noProject = makeFakeGraphql({
      count: () => ({ issues: page([{ id: "a" }]) }),
    })
    await runDeterministicSelect(
      { config: makeConfig({ maxConcurrentBuilds: 1 }) },
      { graphql: noProject.graphql, log },
    )
    const noVars = noProject.calls[0]?.vars as {
      filter: Record<string, unknown>
    }
    expect(noVars.filter.project).toBeUndefined()
  })

  test("merges Ready pages before deciding", async () => {
    const p1 = readyNode({ id: "p1", priority: 4 })
    const p2 = readyNode({ id: "p2", priority: 1 }) // higher priority on page 2
    let readyCall = 0
    const { graphql } = makeFakeGraphql({
      count: () => ({ issues: page([]) }),
      ready: () => {
        readyCall += 1
        return readyCall === 1
          ? { issues: page([p1], true) }
          : { issues: page([p2]) }
      },
      claim: () => ({ issueUpdate: { success: true, issue: { id: "p2" } } }),
    })
    const result = await runDeterministicSelect(
      { config: makeConfig() },
      { graphql, log },
    )
    // p2 (urgent, page 2) must win over p1 (low, page 1) — pages were merged.
    expect(result).toMatchObject({ issueUuid: "p2" })
  })

  test("skips a future-deferred candidate for a non-deferred one and logs the skip", async () => {
    const NOW = Date.parse("2026-07-09T00:00:00.000Z")
    const deferred = readyNode({
      id: "deferred",
      identifier: "PRO-DEF",
      priority: 1, // higher priority — proves defer overrides ordering
      description: "Deploy B\n<!-- defer-until: 2026-07-20 -->",
    })
    const eligible = readyNode({ id: "eligible", priority: 4 })
    const logs: string[] = []
    const { graphql } = makeFakeGraphql({
      count: () => ({ issues: page([]) }),
      ready: () => ({ issues: page([deferred, eligible]) }),
      claim: () => ({
        issueUpdate: { success: true, issue: { id: "eligible" } },
      }),
    })
    const result = await runDeterministicSelect(
      { config: makeConfig() },
      { graphql, log: (m) => logs.push(m), now: () => NOW },
    )
    expect(result).toMatchObject({ issueUuid: "eligible" })
    // The deferred ticket was still fetched (visible candidate), just skipped.
    expect(
      logs.some(
        (m) =>
          m.includes("PRO-DEF") &&
          m.includes("deferred until") &&
          m.includes("2026-07-20"),
      ),
    ).toBe(true)
  })

  test("a past-deferred candidate is claimed normally", async () => {
    const NOW = Date.parse("2026-07-09T00:00:00.000Z")
    const past = readyNode({
      id: "past",
      description: "<!-- defer-until: 2026-01-01 -->",
    })
    const { graphql } = makeFakeGraphql({
      count: () => ({ issues: page([]) }),
      ready: () => ({ issues: page([past]) }),
      claim: () => ({ issueUpdate: { success: true, issue: { id: "past" } } }),
    })
    const result = await runDeterministicSelect(
      { config: makeConfig() },
      { graphql, log, now: () => NOW },
    )
    expect(result).toMatchObject({ issueUuid: "past" })
  })

  test("a malformed defer marker is claimed (not deferred) and logs a warning", async () => {
    const NOW = Date.parse("2026-07-09T00:00:00.000Z")
    const bad = readyNode({
      id: "bad",
      identifier: "PRO-BAD",
      description: "<!-- defer-until: someday -->",
    })
    const logs: string[] = []
    const { graphql } = makeFakeGraphql({
      count: () => ({ issues: page([]) }),
      ready: () => ({ issues: page([bad]) }),
      claim: () => ({ issueUpdate: { success: true, issue: { id: "bad" } } }),
    })
    const result = await runDeterministicSelect(
      { config: makeConfig() },
      { graphql, log: (m) => logs.push(m), now: () => NOW },
    )
    expect(result).toMatchObject({ issueUuid: "bad" })
    expect(
      logs.some(
        (m) =>
          m.includes("PRO-BAD") &&
          m.includes("someday") &&
          m.toLowerCase().includes("defer"),
      ),
    ).toBe(true)
  })

  test("counts In-Progress across pages", async () => {
    let countCall = 0
    const { graphql } = makeFakeGraphql({
      count: () => {
        countCall += 1
        return countCall === 1
          ? { issues: page([{ id: "a" }], true) }
          : { issues: page([{ id: "b" }]) }
      },
    })
    const result = await runDeterministicSelect(
      { config: makeConfig({ maxConcurrentBuilds: 2 }) },
      { graphql, log },
    )
    // 1 + 1 = 2 = cap → at capacity (proves the second page was counted).
    expect(result).toEqual({ none: true, atCapacity: true })
  })
})
