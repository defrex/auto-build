/**
 * Integration coverage for `defaultDeps().runSelect` and
 * `defaultRestoreDeps().runRestoreSelect` — the production wiring that threads
 * the injected Linear GraphQL client into the deterministic select/restore
 * runners. The transport is faked via constructor DI, so no network call runs;
 * this pins that the wiring forwards through and maps the contracts back.
 */

import { describe, expect, test } from "bun:test"
import { type KickoffConfig, resolveConfig } from "./config"
import { defaultDeps, defaultRestoreDeps } from "./kickoff"
import type { LinearGraphql } from "./linear-client"

const LINEAR = {
  teamId: "t",
  projectId: "",
  triageStateId: "s_t",
  readyStateId: "s_ready",
  inProgressStateId: "s_inprog",
  doneStateId: "s_d",
  rejectedStateIds: [],
  sourceObservationsLabelId: "l_o",
  sourceSentryLabelId: "l_s",
  needsDefinitionLabelId: "l_nd",
}

/** Pin the git provider so construction doesn't depend on a clean env — a
 * `superset` value would make `makeWorktreeProvider` throw at build time. */
const config: KickoffConfig = resolveConfig({
  linear: LINEAR,
  maxConcurrentBuilds: 1,
  worktree: { provider: "git" },
})

const empty = { hasNextPage: false, endCursor: null }

/** A GraphQL fake that routes by operation name to a canned payload. */
function fakeGraphql(routes: Record<string, unknown>): {
  graphql: LinearGraphql
} {
  const graphql = (async (query: string) => {
    for (const [key, value] of Object.entries(routes)) {
      if (query.includes(key)) return value
    }
    throw new Error(`unexpected query: ${query.slice(0, 40)}`)
  }) as unknown as LinearGraphql
  return { graphql }
}

describe("defaultDeps.runSelect", () => {
  test("threads the graphql client and maps a claimed SelectResult", async () => {
    const { graphql } = fakeGraphql({
      KickoffInProgressCount: { issues: { nodes: [], pageInfo: empty } },
      KickoffReadyCandidates: {
        issues: {
          nodes: [
            {
              id: "uuid-1",
              identifier: "DIS-1",
              title: "t",
              description: "b",
              priority: 2,
              createdAt: "2026-01-01T00:00:00.000Z",
              labels: { nodes: [{ id: "l_o" }] },
              inverseRelations: { nodes: [] },
            },
          ],
          pageInfo: empty,
        },
      },
      KickoffClaimIssue: {
        issueUpdate: { success: true, issue: { id: "uuid-1" } },
      },
    })

    const result = await defaultDeps("/x", config, {
      graphql,
    }).runSelect({ repoRoot: "/x", config })

    expect(result).toEqual({
      inProgressCount: 0,
      issueId: "DIS-1",
      issueUuid: "uuid-1",
      title: "t",
      brief: "b",
      source: "observations",
    })
  })

  test("at capacity short-circuits to {none, atCapacity}", async () => {
    const { graphql } = fakeGraphql({
      KickoffInProgressCount: {
        issues: { nodes: [{ id: "a" }], pageInfo: empty },
      },
    })
    const result = await defaultDeps("/x", config, { graphql }).runSelect({
      repoRoot: "/x",
      config,
    })
    expect(result).toEqual({ none: true, atCapacity: true })
  })

  test("a Linear API failure surfaces (not an empty queue)", async () => {
    const graphql = (async () => {
      throw new Error("boom")
    }) as unknown as LinearGraphql
    await expect(
      defaultDeps("/x", config, { graphql }).runSelect({
        repoRoot: "/x",
        config,
      }),
    ).rejects.toThrow("boom")
  })
})

describe("defaultRestoreDeps.runRestoreSelect", () => {
  test("threads the graphql client and maps RestoreTicket[]", async () => {
    const { graphql } = fakeGraphql({
      KickoffRestoreAssigned: {
        viewer: {
          id: "me",
          assignedIssues: {
            nodes: [
              {
                id: "u1",
                identifier: "DIS-9",
                title: "nine",
                attachments: { nodes: [] },
              },
            ],
            pageInfo: empty,
          },
        },
      },
    })
    const result = await defaultRestoreDeps("/x", config, {
      graphql,
    }).runRestoreSelect()
    expect(result).toEqual([
      { issueId: "DIS-9", issueUuid: "u1", title: "nine", branch: null },
    ])
  })
})
