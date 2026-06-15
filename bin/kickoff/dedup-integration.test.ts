/**
 * Integration test for the make-or-break guarantee: running the deterministic
 * pipeline twice mints NO duplicate issues on the second pass (design's
 * "Idempotency / dedup is the make-or-break requirement"), verified without any
 * real Linear writes.
 *
 * Flow per pass: scan the committed observation fixtures → build a mock agent
 * result that clusters the candidates into one issue → apply to a temp ledger.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendRows, openIssues, readLedger } from "./ledger"
import { type AgentResult, applyOutcomes } from "./outcomes"
import {
  buildObservationPacket,
  type ObservationPacket,
} from "./scan-observations"

const FIXTURE_REPO = join(import.meta.dir, "__fixtures__", "repo")
const NOW = "2026-06-09T00:00:00Z"

/** Cluster every fresh candidate into ONE issue: first filed, rest joined. */
function mockResultFromPacket(packet: ObservationPacket): AgentResult {
  return {
    outcomes: packet.candidates.map((c, i) => ({
      signalId: c.signalId,
      outcome: i === 0 ? ("filed" as const) : ("joined" as const),
      source: "observations" as const,
      ref: c.ref,
      issueId: "DIS-1",
      issueUuid: "uuid-cluster",
    })),
    seenUpdates: packet.seenUpdates,
  }
}

function runPass(ledgerPath: string): {
  packet: ObservationPacket
  result: AgentResult
} {
  const ledger = readLedger(ledgerPath)
  const packet = buildObservationPacket(FIXTURE_REPO, 5, ledger)
  const result = mockResultFromPacket(packet)
  appendRows(ledgerPath, applyOutcomes(ledger, result, NOW))
  return { packet, result }
}

describe("dedup pipeline idempotency", () => {
  test("second run appends zero new filed/joined rows (no duplicate issues)", () => {
    const ledgerPath = join(
      mkdtempSync(join(tmpdir(), "kickoff-dedup-")),
      "ledger.jsonl",
    )

    const first = runPass(ledgerPath)
    // All three fixture observations are fresh on the first run.
    expect(first.packet.candidates.length).toBe(3)
    const filed = first.result.outcomes.filter((o) => o.outcome === "filed")
    expect(filed).toHaveLength(1)

    const second = runPass(ledgerPath)
    // Nothing fresh the second time → no new issues minted.
    expect(second.packet.candidates).toHaveLength(0)
    expect(second.result.outcomes).toHaveLength(0)
    // The known-open signals became seen-again updates instead.
    expect(second.packet.seenUpdates.length).toBe(3)

    // Exactly one issue exists across the whole ledger.
    const ledger = readLedger(ledgerPath)
    expect(openIssues(ledger)).toHaveLength(1)
  })

  test("committed mock-agent-result.json validates against an empty ledger", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(import.meta.dir, "__fixtures__", "mock-agent-result.json"),
        "utf-8",
      ),
    ) as AgentResult
    const rows = applyOutcomes([], fixture, NOW)
    expect(rows.length).toBe(fixture.outcomes.length)
    // It clusters two signals into one issue (filed + joined) + one stale tombstone.
    expect(rows.filter((r) => r.issueId === "DIS-1001")).toHaveLength(2)
    expect(rows.filter((r) => r.outcome === "tombstoned-stale")).toHaveLength(1)
  })
})
