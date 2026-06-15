import { describe, expect, test } from "bun:test"
import { selectCandidates } from "./candidates"
import type { LedgerRow } from "./ledger"

function row(partial: Partial<LedgerRow> & { signalId: string }): LedgerRow {
  return {
    source: "observations",
    ref: "r",
    outcome: "filed",
    issueId: "DIS-1",
    issueUuid: "u1",
    firstSeenAt: "t",
    lastSeenAt: "t",
    seenCount: 1,
    ...partial,
  }
}

function sig(signalId: string, sourcePath: string, title: string) {
  return { signalId, sourcePath, title }
}

describe("selectCandidates", () => {
  test("drops suppressed (tombstone and done) signals entirely", () => {
    const ledger = [
      row({ signalId: "rej", outcome: "tombstoned-rejected" }),
      row({ signalId: "stale", outcome: "tombstoned-stale" }),
      row({ signalId: "done", outcome: "done" }),
    ]
    const signals = [
      sig("rej", "build/a/observations.md", "x"),
      sig("stale", "build/a/observations.md", "y"),
      sig("done", "build/a/observations.md", "z"),
      sig("fresh", "build/a/observations.md", "w"),
    ]
    const result = selectCandidates(signals, ledger, 10)
    expect(result.packet.map((s) => s.signalId)).toEqual(["fresh"])
    expect(result.updates).toEqual([])
  })

  test("known-open signal becomes a SeenUpdate, not a candidate", () => {
    const ledger = [row({ signalId: "known", outcome: "filed" })]
    const signals = [
      sig("known", "build/a/observations.md", "x"),
      sig("new", "build/a/observations.md", "y"),
    ]
    const result = selectCandidates(signals, ledger, 10)
    expect(result.packet.map((s) => s.signalId)).toEqual(["new"])
    expect(result.updates).toEqual([{ signalId: "known" }])
  })

  test("cap truncates fresh candidates and reports skipped", () => {
    const signals = [
      sig("a", "build/a/observations.md", "1"),
      sig("b", "build/b/observations.md", "2"),
      sig("c", "build/c/observations.md", "3"),
    ]
    const result = selectCandidates(signals, [], 2)
    expect(result.packet).toHaveLength(2)
    expect(result.skipped).toBe(1)
  })

  test("orders fresh deterministically by sourcePath then title", () => {
    const signals = [
      sig("a", "build/z/observations.md", "early"),
      sig("b", "build/a/observations.md", "zebra"),
      sig("c", "build/a/observations.md", "apple"),
    ]
    const result = selectCandidates(signals, [], 10)
    expect(result.packet.map((s) => s.signalId)).toEqual(["c", "b", "a"])
  })
})
