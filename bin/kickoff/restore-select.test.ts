/**
 * Tests for the deterministic restore-select. Pure `resolveAttachedBranch` pins
 * the attachment→branch precedence (PR head ref beats a no-PR branch link;
 * unresolvable → null; results are normalized to a plain checkoutable name). The
 * impure runner is exercised with a faked GraphQL transport: viewer's
 * In-Progress assigned issues → `RestoreTicket[]`, empty set → `[]`, and the
 * project-scoped filter.
 */

import { describe, expect, test } from "bun:test"
import { type KickoffConfig, resolveConfig } from "./config"
import type { LinearGraphql } from "./linear-client"
import {
  type AttachmentLite,
  resolveAttachedBranch,
  runDeterministicRestoreSelect,
} from "./restore-select"

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
    worktree: { provider: "git" },
  })
}

function att(over: Partial<AttachmentLite> = {}): AttachmentLite {
  return { url: null, sourceType: "github", metadata: null, ...over }
}

describe("resolveAttachedBranch", () => {
  test("no attachments → null", () => {
    expect(resolveAttachedBranch([])).toBeNull()
  })

  test("PR head ref from metadata.branch", () => {
    expect(
      resolveAttachedBranch([
        att({
          url: "https://github.com/o/r/pull/12",
          metadata: { branch: "PRO-1-fix-thing" },
        }),
      ]),
    ).toBe("PRO-1-fix-thing")
  })

  test("branch link parsed from /tree/<branch> url", () => {
    expect(
      resolveAttachedBranch([
        att({ url: "https://github.com/o/r/tree/feature/foo" }),
      ]),
    ).toBe("feature/foo")
  })

  test("prefers PR head ref over a no-PR branch link when both present", () => {
    expect(
      resolveAttachedBranch([
        att({ url: "https://github.com/o/r/tree/branch-link" }),
        att({
          url: "https://github.com/o/r/pull/7",
          metadata: { branch: "pr-head" },
        }),
      ]),
    ).toBe("pr-head")
  })

  test("a PR with no resolvable head ref → null (degrade to TS fallback)", () => {
    expect(
      resolveAttachedBranch([att({ url: "https://github.com/o/r/pull/9" })]),
    ).toBeNull()
  })

  test("uses metadata.branch (head), never metadata.targetBranch (base)", () => {
    // Real Linear PR attachments carry both; only the head branch is correct.
    expect(
      resolveAttachedBranch([
        att({
          url: "https://github.com/o/r/pull/3",
          metadata: { branch: "pro-1-head", targetBranch: "main" },
        }),
      ]),
    ).toBe("pro-1-head")
  })

  test("normalizes owner: and origin/ prefixes off a head ref", () => {
    expect(
      resolveAttachedBranch([
        att({
          url: "https://github.com/o/r/pull/1",
          metadata: { branch: "someone:origin/my-branch" },
        }),
      ]),
    ).toBe("my-branch")
  })

  test("ignores non-github attachments", () => {
    expect(
      resolveAttachedBranch([
        att({ sourceType: "figma", url: "https://figma.com/x/tree/nope" }),
      ]),
    ).toBeNull()
  })
})

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

function makeFakeGraphql(handler: (vars: Record<string, unknown>) => unknown): {
  graphql: LinearGraphql
  calls: Record<string, unknown>[]
} {
  const calls: Record<string, unknown>[] = []
  const graphql = (async (_q: string, vars: Record<string, unknown> = {}) => {
    calls.push(vars)
    return handler(vars)
  }) as unknown as LinearGraphql
  return { graphql, calls }
}

const log = () => {}

describe("runDeterministicRestoreSelect", () => {
  test("maps viewer's In-Progress assigned issues to RestoreTicket[]", async () => {
    const { graphql } = makeFakeGraphql(() => ({
      viewer: {
        id: "me",
        assignedIssues: page([
          {
            id: "u1",
            identifier: "PRO-1",
            title: "first",
            attachments: {
              nodes: [
                {
                  url: "https://github.com/o/r/pull/1",
                  sourceType: "github",
                  metadata: { branch: "PRO-1-first" },
                },
              ],
            },
          },
          {
            id: "u2",
            identifier: "PRO-2",
            title: "second",
            attachments: { nodes: [] },
          },
        ]),
      },
    }))
    const result = await runDeterministicRestoreSelect(
      { config: makeConfig() },
      { graphql, log },
    )
    expect(result).toEqual([
      {
        issueId: "PRO-1",
        issueUuid: "u1",
        title: "first",
        branch: "PRO-1-first",
      },
      { issueId: "PRO-2", issueUuid: "u2", title: "second", branch: null },
    ])
  })

  test("empty assigned set → []", async () => {
    const { graphql } = makeFakeGraphql(() => ({
      viewer: { id: "me", assignedIssues: page([]) },
    }))
    expect(
      await runDeterministicRestoreSelect(
        { config: makeConfig() },
        { graphql, log },
      ),
    ).toEqual([])
  })

  test("filter carries In-Progress state; project clause toggles on projectId", async () => {
    const withProject = makeFakeGraphql(() => ({
      viewer: { id: "me", assignedIssues: page([]) },
    }))
    await runDeterministicRestoreSelect(
      { config: makeConfig({ linear: { projectId: "proj-9" } }) },
      { graphql: withProject.graphql, log },
    )
    const f = withProject.calls[0]?.filter as Record<string, unknown>
    expect(f.state).toEqual({ id: { eq: "s_inprog" } })
    expect(f.project).toEqual({ id: { eq: "proj-9" } })

    const noProject = makeFakeGraphql(() => ({
      viewer: { id: "me", assignedIssues: page([]) },
    }))
    await runDeterministicRestoreSelect(
      { config: makeConfig() },
      { graphql: noProject.graphql, log },
    )
    const f2 = noProject.calls[0]?.filter as Record<string, unknown>
    expect(f2.project).toBeUndefined()
  })
})
