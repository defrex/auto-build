/**
 * Dedup filter + per-run cap over freshly-scanned signals (pure).
 *
 * Given the scanned signals and the current ledger, partition them into:
 *  - dropped (permanently suppressed — tombstoned/done),
 *  - seen-again (known + still open → emit a `SeenUpdate`, never a new candidate),
 *  - fresh (never seen → candidates for the agent to cluster + file).
 *
 * The fresh set is ordered newest-first by `recencyMs` (falling back to
 * sourcePath, then title, for ties and undated signals) and capped; overflow is
 * reported via `skipped` and simply absent from the ledger, so the next run
 * reconsiders it (design's "Bounded run size — overflow is not lost"). Recency
 * ordering means a daily harvest consumes yesterday's observations first and
 * spends the remaining cap draining the older backlog.
 *
 * Identity is per-occurrence (observation-signals.ts), so two fresh occurrences
 * of the "same" underlying problem in different dirs are BOTH candidates here;
 * the agent merges them downstream and the ledger records both (one filed, one
 * joined) against the single issue.
 */

import { isKnown, isSuppressed, type LedgerRow } from "./ledger"

/** Minimum shape a signal needs to be selected + ordered. */
export type SelectableSignal = {
  signalId: string
  sourcePath: string
  title: string
  /** Epoch ms the observation last changed (git commit time). Absent → sorts last. */
  recencyMs?: number
}

/** A known-open signal seen again this run — bump its seenCount/lastSeenAt. */
export type SeenUpdate = {
  signalId: string
}

export type SelectResult<T extends SelectableSignal> = {
  packet: T[]
  updates: SeenUpdate[]
  /** Fresh candidates beyond the cap — picked up on a later run. */
  skipped: number
}

export function selectCandidates<T extends SelectableSignal>(
  signals: T[],
  ledger: LedgerRow[],
  cap: number,
): SelectResult<T> {
  const updates: SeenUpdate[] = []
  const fresh: T[] = []

  for (const sig of signals) {
    if (isSuppressed(ledger, sig.signalId)) continue
    if (isKnown(ledger, sig.signalId)) {
      updates.push({ signalId: sig.signalId })
      continue
    }
    fresh.push(sig)
  }

  fresh.sort(
    (a, b) =>
      (b.recencyMs ?? 0) - (a.recencyMs ?? 0) ||
      a.sourcePath.localeCompare(b.sourcePath) ||
      a.title.localeCompare(b.title),
  )

  return {
    packet: fresh.slice(0, Math.max(0, cap)),
    updates,
    skipped: Math.max(0, fresh.length - Math.max(0, cap)),
  }
}
