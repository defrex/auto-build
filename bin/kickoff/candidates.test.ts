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

  test("orders by recency (newest first) ahead of sourcePath/title", () => {
    const signals = [
      { ...sig("old", "build/a/observations.md", "apple"), recencyMs: 1_000 },
      { ...sig("new", "build/z/observations.md", "zebra"), recencyMs: 3_000 },
      { ...sig("mid", "build/m/observations.md", "mid"), recencyMs: 2_000 },
    ]
    const result = selectCandidates(signals, [], 10)
    expect(result.packet.map((s) => s.signalId)).toEqual(["new", "mid", "old"])
  })

  test("signals without recency sort after dated ones, alphabetically", () => {
    const signals = [
      sig("undated-z", "build/z/observations.md", "z"),
      { ...sig("dated", "build/m/observations.md", "m"), recencyMs: 1_000 },
      sig("undated-a", "build/a/observations.md", "a"),
    ]
    const result = selectCandidates(signals, [], 10)
    expect(result.packet.map((s) => s.signalId)).toEqual([
      "dated",
      "undated-a",
      "undated-z",
    ])
  })

  test("cap keeps the newest candidates, skipping the older backlog", () => {
    const signals = [
      { ...sig("oldest", "build/a/observations.md", "a"), recencyMs: 1_000 },
      { ...sig("newest", "build/b/observations.md", "b"), recencyMs: 3_000 },
      { ...sig("middle", "build/c/observations.md", "c"), recencyMs: 2_000 },
    ]
    const result = selectCandidates(signals, [], 2)
    expect(result.packet.map((s) => s.signalId)).toEqual(["newest", "middle"])
    expect(result.skipped).toBe(1)
  })
})
