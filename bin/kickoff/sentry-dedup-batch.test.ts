/**
 * Tests for the batched Sentry-dedup Linear resolver.
 *
 * `buildTicketFilter` is pure — we pin the exact `{ or: [...] }` shape (the
 * verified "wrap the team+number branch in an explicit `and`" gotcha is the
 * subtle one, so it gets a shape assertion a future edit can't silently regress).
 *
 * The orchestration (`runSentryDedupBatch`) is exercised through an injected fake
 * `LinearGraphql` keyed on the recorded call log (the `select.test.ts`
 * `makeFakeGraphql` pattern) so we assert verdict mapping, single-request
 * batching, per-candidate degrade, and transport-error propagation without a
 * network.
 */

import { describe, expect, test } from "bun:test"
import type { LinearGraphql } from "./linear-client"
import type { SentryBreadcrumb, SentryNote } from "./sentry-dedup"
import {
  buildTicketFilter,
  parseBatchInput,
  runSentryDedupBatch,
  type SentryDedupBatchInput,
} from "./sentry-dedup-batch"

const UUID_A = "11111111-1111-4111-8111-111111111111"
const UUID_B = "22222222-2222-4222-8222-222222222222"

const LINEAR = { doneStateId: "s_done", rejectedStateIds: ["s_rejected"] }

function breadcrumb(
  linearTicketId: string,
  linearTicketUuid?: string,
): SentryBreadcrumb {
  const url = `https://linear.app/dispatch/issue/${linearTicketId}`
  return linearTicketUuid
    ? { linearTicketId, linearTicketUuid, url }
    : { linearTicketId, url }
}

/** Build a Sentry note whose body carries a canonical breadcrumb marker. */
function noteFor(
  b: { linearTicketId: string; linearTicketUuid?: string },
  createdAt = "2026-01-01T00:00:00Z",
): SentryNote {
  const marker: Record<string, string> = {
    linearTicketId: b.linearTicketId,
    url: `https://linear.app/dispatch/issue/${b.linearTicketId}`,
  }
  if (b.linearTicketUuid) marker.linearTicketUuid = b.linearTicketUuid
  return {
    body: `Dispatch triaged this into Linear\n<!-- dispatch-sentry-triage: ${JSON.stringify(marker)} -->`,
    createdAt,
  }
}

type FakeNode = {
  id: string
  identifier: string
  state: { id: string } | null
}

/** Fake graphql that serves `pages` of `issues` nodes in order and records calls. */
function makeFakeGraphql(pages: FakeNode[][]): {
  graphql: LinearGraphql
  calls: { query: string; vars: Record<string, unknown> }[]
} {
  const calls: { query: string; vars: Record<string, unknown> }[] = []
  let pageIdx = 0
  const graphql = (async (
    query: string,
    vars: Record<string, unknown> = {},
  ) => {
    calls.push({ query, vars })
    const nodes = pages[pageIdx] ?? []
    const hasNextPage = pageIdx < pages.length - 1
    pageIdx += 1
    return {
      issues: {
        nodes,
        pageInfo: {
          hasNextPage,
          endCursor: hasNextPage ? `c${pageIdx}` : null,
        },
      },
    }
  }) as unknown as LinearGraphql
  return { graphql, calls }
}

function candidate(
  shortId: string,
  notes: SentryNote[],
  inActionableQuery = true,
): SentryDedupBatchInput["candidates"][number] {
  return { shortId, notes, inActionableQuery }
}

describe("buildTicketFilter", () => {
  test("all-uuid breadcrumbs → single id.in branch", () => {
    const filter = buildTicketFilter([
      breadcrumb("PRO-1", UUID_A),
      breadcrumb("PRO-2", UUID_B),
    ])
    expect(filter).toEqual({ or: [{ id: { in: [UUID_A, UUID_B] } }] })
  })

  test("all-identifier breadcrumbs → and-wrapped team.key+number.in, grouped by team", () => {
    const filter = buildTicketFilter([
      breadcrumb("PRO-1"),
      breadcrumb("PRO-2"),
      breadcrumb("ENG-5"),
    ])
    expect(filter).toEqual({
      or: [
        { and: [{ team: { key: { eq: "PRO" } } }, { number: { in: [1, 2] } }] },
        { and: [{ team: { key: { eq: "ENG" } } }, { number: { in: [5] } }] },
      ],
    })
  })

  test("mixed uuid + identifier → both branches present", () => {
    const filter = buildTicketFilter([
      breadcrumb("PRO-1", UUID_A),
      breadcrumb("ENG-5"),
    ])
    expect(filter).toEqual({
      or: [
        { id: { in: [UUID_A] } },
        { and: [{ team: { key: { eq: "ENG" } } }, { number: { in: [5] } }] },
      ],
    })
  })

  test("empty breadcrumbs → null (no request needed)", () => {
    expect(buildTicketFilter([])).toBeNull()
  })

  test("malformed uuid falls back to the identifier branch", () => {
    // A present-but-not-UUID-shaped uuid must NOT enter the id.in branch (Linear
    // would trip INVALID_INPUT); it falls back to team.key+number.in.
    const filter = buildTicketFilter([breadcrumb("PRO-7", "not-a-uuid")])
    expect(filter).toEqual({
      or: [
        { and: [{ team: { key: { eq: "PRO" } } }, { number: { in: [7] } }] },
      ],
    })
  })
})

describe("runSentryDedupBatch", () => {
  test("no breadcrumb → file-new, and graphql is never called", async () => {
    const { graphql, calls } = makeFakeGraphql([])
    const result = await runSentryDedupBatch(
      {
        candidates: [
          candidate("S-1", [
            { body: "a plain human note, no marker", createdAt: "2026-01-01" },
          ]),
        ],
      },
      { graphql, linear: LINEAR },
    )
    expect(result.results[0].verdict).toBe("file-new")
    expect(result.results[0].terminality).toBeNull()
    expect(result.results[0].breadcrumb).toBeNull()
    expect(calls.length).toBe(0)
  })

  test("breadcrumb + non-terminal ticket → skip", async () => {
    const { graphql } = makeFakeGraphql([
      [{ id: UUID_A, identifier: "PRO-1", state: { id: "s_open" } }],
    ])
    const result = await runSentryDedupBatch(
      {
        candidates: [
          candidate("S-1", [
            noteFor({ linearTicketId: "PRO-1", linearTicketUuid: UUID_A }),
          ]),
        ],
      },
      { graphql, linear: LINEAR },
    )
    expect(result.results[0].verdict).toBe("skip")
    expect(result.results[0].terminality).toBe("non-terminal")
  })

  test("breadcrumb + done + actionable → file-regression (done)", async () => {
    const { graphql } = makeFakeGraphql([
      [{ id: UUID_A, identifier: "PRO-1", state: { id: "s_done" } }],
    ])
    const result = await runSentryDedupBatch(
      {
        candidates: [
          candidate(
            "S-1",
            [noteFor({ linearTicketId: "PRO-1", linearTicketUuid: UUID_A })],
            true,
          ),
        ],
      },
      { graphql, linear: LINEAR },
    )
    expect(result.results[0].verdict).toBe("file-regression")
    expect(result.results[0].terminality).toBe("done")
  })

  test("breadcrumb + rejected + actionable → file-regression (rejected)", async () => {
    const { graphql } = makeFakeGraphql([
      [{ id: UUID_A, identifier: "PRO-1", state: { id: "s_rejected" } }],
    ])
    const result = await runSentryDedupBatch(
      {
        candidates: [
          candidate(
            "S-1",
            [noteFor({ linearTicketId: "PRO-1", linearTicketUuid: UUID_A })],
            true,
          ),
        ],
      },
      { graphql, linear: LINEAR },
    )
    expect(result.results[0].verdict).toBe("file-regression")
    expect(result.results[0].terminality).toBe("rejected")
  })

  test("breadcrumb + done + NOT actionable → skip (defensive)", async () => {
    const { graphql } = makeFakeGraphql([
      [{ id: UUID_A, identifier: "PRO-1", state: { id: "s_done" } }],
    ])
    const result = await runSentryDedupBatch(
      {
        candidates: [
          candidate(
            "S-1",
            [noteFor({ linearTicketId: "PRO-1", linearTicketUuid: UUID_A })],
            false,
          ),
        ],
      },
      { graphql, linear: LINEAR },
    )
    expect(result.results[0].verdict).toBe("skip")
    expect(result.results[0].terminality).toBe("done")
  })

  test("deleted ticket (absent from results) degrades only itself, batch survives", async () => {
    // PRO-1 (UUID_A) is resolvable + done → regression; PRO-2 (UUID_B) is absent.
    const { graphql } = makeFakeGraphql([
      [{ id: UUID_A, identifier: "PRO-1", state: { id: "s_done" } }],
    ])
    const result = await runSentryDedupBatch(
      {
        candidates: [
          candidate(
            "S-1",
            [noteFor({ linearTicketId: "PRO-1", linearTicketUuid: UUID_A })],
            true,
          ),
          candidate("S-2", [noteFor({ linearTicketId: "PRO-2" })], true),
        ],
      },
      { graphql, linear: LINEAR },
    )
    const s1 = result.results.find((r) => r.shortId === "S-1")
    const s2 = result.results.find((r) => r.shortId === "S-2")
    expect(s1?.verdict).toBe("file-regression")
    expect(s1?.terminality).toBe("done")
    expect(s2?.verdict).toBe("skip")
    expect(s2?.terminality).toBeNull()
    expect(s2?.lookupError).toContain("PRO-2")
  })

  test("batches N breadcrumb candidates into exactly one graphql call with an or-filter", async () => {
    const { graphql, calls } = makeFakeGraphql([
      [
        { id: UUID_A, identifier: "PRO-1", state: { id: "s_open" } },
        { id: UUID_B, identifier: "PRO-2", state: { id: "s_open" } },
      ],
    ])
    await runSentryDedupBatch(
      {
        candidates: [
          candidate("S-1", [
            noteFor({ linearTicketId: "PRO-1", linearTicketUuid: UUID_A }),
          ]),
          candidate("S-2", [
            noteFor({ linearTicketId: "PRO-2", linearTicketUuid: UUID_B }),
          ]),
        ],
      },
      { graphql, linear: LINEAR },
    )
    expect(calls.length).toBe(1)
    expect(calls[0].vars.filter).toEqual({
      or: [{ id: { in: [UUID_A, UUID_B] } }],
    })
  })

  test("uuid preference: uuid candidate via id branch, uuid-less via identifier branch", async () => {
    const { graphql, calls } = makeFakeGraphql([
      [
        { id: UUID_A, identifier: "PRO-1", state: { id: "s_done" } },
        { id: "internal-uuid-x", identifier: "PRO-9", state: { id: "s_open" } },
      ],
    ])
    const result = await runSentryDedupBatch(
      {
        candidates: [
          candidate(
            "S-1",
            [noteFor({ linearTicketId: "PRO-1", linearTicketUuid: UUID_A })],
            true,
          ),
          candidate("S-2", [noteFor({ linearTicketId: "PRO-9" })], true),
        ],
      },
      { graphql, linear: LINEAR },
    )
    expect(calls[0].vars.filter).toEqual({
      or: [
        { id: { in: [UUID_A] } },
        { and: [{ team: { key: { eq: "PRO" } } }, { number: { in: [9] } }] },
      ],
    })
    const s1 = result.results.find((r) => r.shortId === "S-1")
    const s2 = result.results.find((r) => r.shortId === "S-2")
    expect(s1?.verdict).toBe("file-regression")
    expect(s2?.verdict).toBe("skip")
    expect(s2?.terminality).toBe("non-terminal")
  })

  test("transport error propagates (not swallowed)", async () => {
    const graphql = (async () => {
      throw new Error("Linear GraphQL error: 401 Unauthorized")
    }) as unknown as LinearGraphql
    await expect(
      runSentryDedupBatch(
        {
          candidates: [
            candidate("S-1", [
              noteFor({ linearTicketId: "PRO-1", linearTicketUuid: UUID_A }),
            ]),
          ],
        },
        { graphql, linear: LINEAR },
      ),
    ).rejects.toThrow("401")
  })

  test("paginates the issues connection across pages", async () => {
    const { graphql, calls } = makeFakeGraphql([
      [{ id: UUID_A, identifier: "PRO-1", state: { id: "s_open" } }],
      [{ id: UUID_B, identifier: "PRO-2", state: { id: "s_done" } }],
    ])
    const result = await runSentryDedupBatch(
      {
        candidates: [
          candidate("S-1", [
            noteFor({ linearTicketId: "PRO-1", linearTicketUuid: UUID_A }),
          ]),
          candidate(
            "S-2",
            [noteFor({ linearTicketId: "PRO-2", linearTicketUuid: UUID_B })],
            true,
          ),
        ],
      },
      { graphql, linear: LINEAR },
    )
    expect(calls.length).toBe(2)
    expect(calls[1].vars.after).toBe("c1")
    expect(result.results.find((r) => r.shortId === "S-2")?.verdict).toBe(
      "file-regression",
    )
  })

  test("malformed uuid resolves via the identifier branch end-to-end", async () => {
    // Breadcrumb carries a junk uuid; the node comes back under its identifier,
    // and the lookup (which also uses lookupRef) hits the identifier key.
    const { graphql, calls } = makeFakeGraphql([
      [{ id: "real-uuid", identifier: "PRO-7", state: { id: "s_done" } }],
    ])
    const result = await runSentryDedupBatch(
      {
        candidates: [
          candidate(
            "S-1",
            [
              noteFor({
                linearTicketId: "PRO-7",
                linearTicketUuid: "not-a-uuid",
              }),
            ],
            true,
          ),
        ],
      },
      { graphql, linear: LINEAR },
    )
    expect(calls[0].vars.filter).toEqual({
      or: [
        { and: [{ team: { key: { eq: "PRO" } } }, { number: { in: [7] } }] },
      ],
    })
    expect(result.results[0].verdict).toBe("file-regression")
    expect(result.results[0].terminality).toBe("done")
    expect(result.results[0].lookupError).toBeUndefined()
  })
})

describe("parseBatchInput", () => {
  test("round-trips a well-formed input", () => {
    const input = {
      candidates: [
        {
          shortId: "S-1",
          notes: [{ body: "hi", createdAt: "2026-01-01T00:00:00Z" }],
          inActionableQuery: true,
        },
      ],
    }
    expect(parseBatchInput(input)).toEqual(input)
  })

  test("throws on a non-object input", () => {
    expect(() => parseBatchInput(null)).toThrow("must be a JSON object")
    expect(() => parseBatchInput(42)).toThrow("must be a JSON object")
  })

  test("throws when candidates is not an array", () => {
    expect(() => parseBatchInput({ candidates: "nope" })).toThrow(
      "candidates must be an array",
    )
  })

  test("throws on a missing shortId", () => {
    expect(() =>
      parseBatchInput({
        candidates: [{ notes: [], inActionableQuery: true }],
      }),
    ).toThrow("shortId")
  })

  test("throws on a non-boolean inActionableQuery", () => {
    expect(() =>
      parseBatchInput({
        candidates: [{ shortId: "S-1", notes: [], inActionableQuery: "yes" }],
      }),
    ).toThrow("inActionableQuery")
  })

  test("throws on a malformed note", () => {
    expect(() =>
      parseBatchInput({
        candidates: [
          {
            shortId: "S-1",
            notes: [{ body: 5, createdAt: "x" }],
            inActionableQuery: true,
          },
        ],
      }),
    ).toThrow("body must be a string")
  })
})
