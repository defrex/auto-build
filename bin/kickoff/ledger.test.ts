import { describe, expect, test } from "bun:test"
import {
  isKnown,
  isSuppressed,
  type LedgerRow,
  openIssues,
  parseLedger,
  reconcile,
  serializeRows,
} from "./ledger"

function row(partial: Partial<LedgerRow> & { signalId: string }): LedgerRow {
  return {
    source: "observations",
    ref: "build/x/observations.md#a",
    outcome: "filed",
    issueId: "DIS-1",
    issueUuid: "uuid-1",
    firstSeenAt: "2026-06-09T00:00:00Z",
    lastSeenAt: "2026-06-09T00:00:00Z",
    seenCount: 1,
    ...partial,
  }
}

describe("parseLedger / serializeRows", () => {
  test("round-trips distinct signals", () => {
    const rows = [
      row({ signalId: "a" }),
      row({ signalId: "b", issueId: "DIS-2" }),
    ]
    expect(parseLedger(serializeRows(rows))).toEqual(rows)
  })

  test("empty contents → []", () => {
    expect(parseLedger("")).toEqual([])
    expect(parseLedger("\n  \n")).toEqual([])
  })

  test("last-write-wins per signalId", () => {
    const jsonl = serializeRows([
      row({ signalId: "a", outcome: "filed" }),
      row({ signalId: "a", outcome: "done" }),
    ])
    const parsed = parseLedger(jsonl)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].outcome).toBe("done")
  })
})

describe("isKnown / isSuppressed", () => {
  const ledger = [
    row({ signalId: "open" }),
    row({
      signalId: "stale",
      outcome: "tombstoned-stale",
      issueId: null,
      issueUuid: null,
    }),
    row({ signalId: "rejected", outcome: "tombstoned-rejected" }),
    row({ signalId: "done", outcome: "done" }),
  ]

  test("isKnown is true for any row including tombstones", () => {
    expect(isKnown(ledger, "open")).toBe(true)
    expect(isKnown(ledger, "stale")).toBe(true)
    expect(isKnown(ledger, "missing")).toBe(false)
  })

  test("suppression blocks tombstoned + done, not open", () => {
    expect(isSuppressed(ledger, "open")).toBe(false)
    expect(isSuppressed(ledger, "stale")).toBe(true)
    expect(isSuppressed(ledger, "rejected")).toBe(true)
    expect(isSuppressed(ledger, "done")).toBe(true)
    expect(isSuppressed(ledger, "missing")).toBe(false)
  })
})

describe("openIssues", () => {
  test("groups filed/joined signals by issue and skips terminal rows", () => {
    const ledger = [
      row({
        signalId: "a",
        outcome: "filed",
        issueUuid: "u1",
        issueId: "DIS-1",
      }),
      row({
        signalId: "b",
        outcome: "joined",
        issueUuid: "u1",
        issueId: "DIS-1",
      }),
      row({
        signalId: "c",
        outcome: "done",
        issueUuid: "u2",
        issueId: "DIS-2",
      }),
    ]
    const open = openIssues(ledger)
    expect(open).toHaveLength(1)
    expect(open[0].issueUuid).toBe("u1")
    expect(open[0].signalIds.sort()).toEqual(["a", "b"])
  })
})

describe("reconcile", () => {
  test("tombstones every signal of a rejected issue (many-signals case)", () => {
    const ledger = [
      row({ signalId: "a", outcome: "filed", issueUuid: "u1" }),
      row({ signalId: "b", outcome: "joined", issueUuid: "u1" }),
    ]
    const out = reconcile(ledger, { u1: "rejected" }, "2026-06-10T00:00:00Z")
    expect(out).toHaveLength(2)
    expect(out.every((r) => r.outcome === "tombstoned-rejected")).toBe(true)
    expect(out.every((r) => r.lastSeenAt === "2026-06-10T00:00:00Z")).toBe(true)
  })

  test("marks every signal of a done issue done", () => {
    const ledger = [row({ signalId: "a", outcome: "filed", issueUuid: "u1" })]
    const out = reconcile(ledger, { u1: "done" }, "now")
    expect(out[0].outcome).toBe("done")
  })

  test("leaves unclassified and already-terminal rows alone", () => {
    const ledger = [
      row({ signalId: "a", outcome: "filed", issueUuid: "u1" }),
      row({ signalId: "b", outcome: "done", issueUuid: "u2" }),
    ]
    const out = reconcile(ledger, { u2: "rejected" }, "now")
    expect(out).toHaveLength(0)
  })
})
