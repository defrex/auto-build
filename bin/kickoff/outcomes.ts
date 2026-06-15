/**
 * Turn an agent's reported result into the ledger rows to append (pure).
 *
 * The ingester skills return a JSON result file describing what they did with
 * each candidate signal (filed a new issue, joined an existing one, dropped as
 * stale) plus the seen-again updates carried through from the scan. This module
 * maps that into concrete `LedgerRow`s — preserving `firstSeenAt` across updates
 * and incrementing `seenCount` — and validates the agent's claims so a malformed
 * result is surfaced (thrown) rather than silently producing a bad ledger.
 */

import type { LedgerOutcome, LedgerRow, LedgerSource } from "./ledger"

export type AgentOutcome = {
  signalId: string
  outcome: LedgerOutcome
  source: LedgerSource
  /** Human-readable origin echoed from the candidate packet. */
  ref: string
  issueId?: string | null
  issueUuid?: string | null
}

export type AgentResult = {
  outcomes: AgentOutcome[]
  seenUpdates?: { signalId: string }[]
}

/** Outcomes that must reference a Linear issue. */
const ISSUE_BACKED: ReadonlySet<LedgerOutcome> = new Set<LedgerOutcome>([
  "filed",
  "joined",
  "done",
  "tombstoned-rejected",
])

function validateOutcome(o: AgentOutcome): void {
  const hasIssue = Boolean(o.issueId) && Boolean(o.issueUuid)
  if (ISSUE_BACKED.has(o.outcome) && !hasIssue) {
    throw new Error(
      `outcome "${o.outcome}" for signal ${o.signalId} must carry issueId + issueUuid`,
    )
  }
  if (o.outcome === "tombstoned-stale" && (o.issueId || o.issueUuid)) {
    throw new Error(
      `tombstoned-stale signal ${o.signalId} must not carry an issue id`,
    )
  }
}

/**
 * Apply an agent result over the current ledger view, returning the rows to
 * append. `now` is injected (no `Date.now()` here) so this stays deterministic.
 */
export function applyOutcomes(
  ledger: LedgerRow[],
  result: AgentResult,
  now: string,
): LedgerRow[] {
  const byId = new Map(ledger.map((r) => [r.signalId, r]))
  const rows: LedgerRow[] = []

  for (const o of result.outcomes) {
    validateOutcome(o)
    const existing = byId.get(o.signalId)
    rows.push({
      signalId: o.signalId,
      source: o.source,
      ref: o.ref,
      outcome: o.outcome,
      issueId: o.issueId ?? null,
      issueUuid: o.issueUuid ?? null,
      firstSeenAt: existing?.firstSeenAt ?? now,
      lastSeenAt: now,
      seenCount: existing?.seenCount ?? 1,
    })
  }

  for (const update of result.seenUpdates ?? []) {
    const existing = byId.get(update.signalId)
    if (!existing) {
      throw new Error(
        `seenUpdate for unknown signal ${update.signalId} (not in ledger)`,
      )
    }
    rows.push({
      ...existing,
      lastSeenAt: now,
      seenCount: existing.seenCount + 1,
    })
  }

  return rows
}
