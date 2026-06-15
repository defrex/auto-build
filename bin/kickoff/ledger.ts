/**
 * The dedup ledger: a committed JSON Lines file at `build/kickoff/ledger.jsonl`,
 * one row per processed source signal (many-signals-to-one-issue, per the design's
 * "Clustering over 1:1"). Append-only; single-writer (the design's v1 assumption).
 *
 * This is the make-or-break dedup store. The agent never decides identity or
 * suppression — it only reports outcomes. All "is this known / suppressed / open"
 * logic is pure code here so re-runs provably mint no duplicates.
 *
 * Reads collapse to last-write-wins per `signalId`: the latest row for a signal is
 * its current state. A `tombstoned-*` or `done` row therefore permanently suppresses
 * that exact `signalId` (a later identical-but-new occurrence has a different id —
 * see `signalIdFor` in observation-signals.ts — and re-enters as fresh).
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname } from "node:path"

export type LedgerSource = "observations" | "sentry"

export type LedgerOutcome =
  | "filed"
  | "joined"
  | "tombstoned-stale"
  | "tombstoned-rejected"
  | "done"

export type LedgerRow = {
  /** Stable source-occurrence identity (sha256:…). See observation-signals.ts / Sentry id. */
  signalId: string
  source: LedgerSource
  /** Human-readable origin, e.g. `build/payg/observations.md#unbounded-collect`. */
  ref: string
  outcome: LedgerOutcome
  /** Linear human identifier (e.g. DIS-123); null for tombstoned-stale. */
  issueId: string | null
  /** Linear internal uuid, for MCP lookups; null for tombstoned-stale. */
  issueUuid: string | null
  firstSeenAt: string
  lastSeenAt: string
  /** Number of RUNS this exact signalId recurred (not number of dirs). */
  seenCount: number
}

/** Issue states a reconcile pass cares about. "open" rows are left untouched. */
export type ReconcileState = "rejected" | "done"

const SUPPRESSING_OUTCOMES: ReadonlySet<LedgerOutcome> = new Set<LedgerOutcome>(
  ["tombstoned-stale", "tombstoned-rejected", "done"],
)

const OPEN_OUTCOMES: ReadonlySet<LedgerOutcome> = new Set<LedgerOutcome>([
  "filed",
  "joined",
])

/**
 * Parse JSONL contents into the current ledger view: one row per `signalId`,
 * last-write-wins (later lines override earlier ones). Blank lines are skipped;
 * an empty file yields `[]`. Insertion order follows each signal's first appearance.
 */
export function parseLedger(contents: string): LedgerRow[] {
  const byId = new Map<string, LedgerRow>()
  for (const line of contents.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const row = JSON.parse(trimmed) as LedgerRow
    byId.set(row.signalId, row)
  }
  return [...byId.values()]
}

/** Serialize rows to appendable JSONL (one compact object per line, trailing newline). */
export function serializeRows(rows: LedgerRow[]): string {
  if (rows.length === 0) return ""
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`
}

/** Read + collapse the ledger file. A missing or empty file returns `[]`. */
export function readLedger(path: string): LedgerRow[] {
  if (!existsSync(path)) return []
  return parseLedger(readFileSync(path, "utf-8"))
}

/** Append rows to the ledger file (creating it + its dir if needed). */
export function appendRows(path: string, rows: LedgerRow[]): void {
  if (rows.length === 0) return
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, serializeRows(rows))
}

/** Whether any row (including tombstones/done) exists for this signal. */
export function isKnown(ledger: LedgerRow[], signalId: string): boolean {
  return ledger.some((r) => r.signalId === signalId)
}

/**
 * Whether this signal is permanently suppressed: its current row is a
 * `tombstoned-*` or `done` outcome. Re-filing completed/rejected work is wrong.
 */
export function isSuppressed(ledger: LedgerRow[], signalId: string): boolean {
  const row = ledger.find((r) => r.signalId === signalId)
  return row != null && SUPPRESSING_OUTCOMES.has(row.outcome)
}

export type OpenIssue = {
  issueId: string
  issueUuid: string
  signalIds: string[]
}

/**
 * Distinct still-open issues (rows with `filed`/`joined` outcomes) and the
 * signals attached to each. Feeds clustering context and the reconcile pass.
 */
export function openIssues(ledger: LedgerRow[]): OpenIssue[] {
  const byUuid = new Map<string, OpenIssue>()
  for (const row of ledger) {
    if (!OPEN_OUTCOMES.has(row.outcome)) continue
    if (!row.issueUuid || !row.issueId) continue
    const existing = byUuid.get(row.issueUuid)
    if (existing) existing.signalIds.push(row.signalId)
    else
      byUuid.set(row.issueUuid, {
        issueId: row.issueId,
        issueUuid: row.issueUuid,
        signalIds: [row.signalId],
      })
  }
  return [...byUuid.values()]
}

/**
 * Given a classification of issue uuids that have reached a terminal Linear
 * state, emit new ledger rows tombstoning/terminalizing **every** open signal
 * of those issues. Pure — the caller classifies Linear states (via config) into
 * `rejected`/`done` before calling, so this stays config-free and testable.
 *
 * A rejected issue's signals become `tombstoned-rejected` (permanent, can't be
 * resurrected by a later cluster); a done issue's signals become `done`.
 */
export function reconcile(
  ledger: LedgerRow[],
  classification: Record<string, ReconcileState>,
  now: string,
): LedgerRow[] {
  const out: LedgerRow[] = []
  for (const row of ledger) {
    if (!OPEN_OUTCOMES.has(row.outcome)) continue
    if (!row.issueUuid) continue
    const state = classification[row.issueUuid]
    if (!state) continue
    out.push({
      ...row,
      outcome: state === "rejected" ? "tombstoned-rejected" : "done",
      lastSeenAt: now,
    })
  }
  return out
}
