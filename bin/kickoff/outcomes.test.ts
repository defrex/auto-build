import { describe, expect, test } from "bun:test"
import type { LedgerRow } from "./ledger"
import { applyOutcomes } from "./outcomes"

const NOW = "2026-06-09T12:00:00Z"

describe("applyOutcomes", () => {
  test("maps filed / joined / tombstoned-stale outcomes to rows", () => {
    const rows = applyOutcomes(
      [],
      {
        outcomes: [
          {
            signalId: "a",
            outcome: "filed",
            source: "observations",
            ref: "build/x/observations.md#a",
            issueId: "DIS-1",
            issueUuid: "u1",
          },
          {
            signalId: "stale",
            outcome: "tombstoned-stale",
            source: "observations",
            ref: "build/x/observations.md#s",
          },
        ],
      },
      NOW,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      outcome: "filed",
      firstSeenAt: NOW,
      seenCount: 1,
    })
    expect(rows[1]).toMatchObject({
      outcome: "tombstoned-stale",
      issueId: null,
      issueUuid: null,
    })
  })

  test("two distinct source-path signals to one issue → two rows, same issue", () => {
    const rows = applyOutcomes(
      [],
      {
        outcomes: [
          {
            signalId: "a",
            outcome: "filed",
            source: "observations",
            ref: "build/a/observations.md#x",
            issueId: "DIS-7",
            issueUuid: "u7",
          },
          {
            signalId: "b",
            outcome: "joined",
            source: "observations",
            ref: "build/b/observations.md#x",
            issueId: "DIS-7",
            issueUuid: "u7",
          },
        ],
      },
      NOW,
    )
    expect(rows.map((r) => r.issueId)).toEqual(["DIS-7", "DIS-7"])
    expect(rows.map((r) => r.outcome)).toEqual(["filed", "joined"])
  })

  test("preserves firstSeenAt on an existing signal", () => {
    const ledger: LedgerRow[] = [
      {
        signalId: "a",
        source: "observations",
        ref: "r",
        outcome: "filed",
        issueId: "DIS-1",
        issueUuid: "u1",
        firstSeenAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-01T00:00:00Z",
        seenCount: 1,
      },
    ]
    const rows = applyOutcomes(
      ledger,
      {
        outcomes: [
          {
            signalId: "a",
            outcome: "done",
            source: "observations",
            ref: "r",
            issueId: "DIS-1",
            issueUuid: "u1",
          },
        ],
      },
      NOW,
    )
    expect(rows[0].firstSeenAt).toBe("2026-01-01T00:00:00Z")
    expect(rows[0].lastSeenAt).toBe(NOW)
  })

  test("seenUpdate bumps seenCount + lastSeenAt of a known signal", () => {
    const ledger: LedgerRow[] = [
      {
        signalId: "a",
        source: "observations",
        ref: "r",
        outcome: "filed",
        issueId: "DIS-1",
        issueUuid: "u1",
        firstSeenAt: "2026-01-01T00:00:00Z",
        lastSeenAt: "2026-01-01T00:00:00Z",
        seenCount: 2,
      },
    ]
    const rows = applyOutcomes(
      ledger,
      { outcomes: [], seenUpdates: [{ signalId: "a" }] },
      NOW,
    )
    expect(rows[0].seenCount).toBe(3)
    expect(rows[0].lastSeenAt).toBe(NOW)
  })

  test("rejects filed outcome missing an issue id", () => {
    expect(() =>
      applyOutcomes(
        [],
        {
          outcomes: [
            {
              signalId: "a",
              outcome: "filed",
              source: "observations",
              ref: "r",
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/must carry issueId/)
  })

  test("rejects tombstoned-stale carrying an issue id", () => {
    expect(() =>
      applyOutcomes(
        [],
        {
          outcomes: [
            {
              signalId: "a",
              outcome: "tombstoned-stale",
              source: "observations",
              ref: "r",
              issueId: "DIS-1",
              issueUuid: "u1",
            },
          ],
        },
        NOW,
      ),
    ).toThrow(/must not carry an issue id/)
  })

  test("rejects a seenUpdate for an unknown signal", () => {
    expect(() =>
      applyOutcomes(
        [],
        { outcomes: [], seenUpdates: [{ signalId: "ghost" }] },
        NOW,
      ),
    ).toThrow(/unknown signal/)
  })
})
