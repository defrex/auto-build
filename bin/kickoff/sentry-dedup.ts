/**
 * Live-state dedup for the Sentry triage path (pure).
 *
 * The project invariant is "the LLM never decides identity/suppression — code
 * does." This module is that code for the Sentry path: the triage skill gathers
 * per-candidate FACTS via MCP (does the Sentry issue carry a breadcrumb note?
 * what state is the linked Linear ticket in? is the issue back in the actionable
 * query?) and this module renders the VERDICT. No dedup decision is ever made by
 * eyeballing note prose — identity rides a fixed hidden marker parsed here.
 *
 * Replaces the old `ledger.jsonl`-keyed dedup for Sentry. See the
 * `triage-sentry` skill and `build/.../plan.md` (D1, D1.5).
 */

import type { LinearConfig } from "./config"

/** "done" = fixed/merged; "rejected" = canceled/won't-do; "non-terminal" = open/in-progress. */
export type TicketTerminality = "done" | "rejected" | "non-terminal"

/**
 * Map a Linear workflow-state id to terminality using the pinned config.
 * `doneStateId` → "done"; any `rejectedStateIds` member → "rejected"; otherwise
 * "non-terminal". `done` and `rejected` stay distinct (not collapsed to
 * "terminal") so the brief authoring can frame a regression correctly — a prior
 * `done` ticket is a true regression, a prior `rejected` one is a re-surfaced
 * won't-fix.
 */
export function classifyTicketState(
  stateId: string,
  linear: Pick<LinearConfig, "doneStateId" | "rejectedStateIds">,
): TicketTerminality {
  if (stateId === linear.doneStateId) return "done"
  if (linear.rejectedStateIds.includes(stateId)) return "rejected"
  return "non-terminal"
}

export type SentryBreadcrumb = {
  /** Linear human ref, e.g. "PRO-372". */
  linearTicketId: string
  /** Linear internal uuid (preferred for the state lookup when present). */
  linearTicketUuid?: string
  /** Linear ticket URL. */
  url: string
}

export type SentryNote = {
  body: string
  /** ISO timestamp, from the Sentry note/activity entry. */
  createdAt: string
}

export type SentryTriageInput = {
  /** Latest Linear breadcrumb note on the Sentry issue (null if none). */
  breadcrumb: SentryBreadcrumb | null
  /** Resolved state of the breadcrumb's ticket (null if no breadcrumb). */
  ticketTerminality: TicketTerminality | null
  /** Came back from is:unresolved|regressed|escalating AND passed threshold. */
  inActionableQuery: boolean
}

export type SentryTriageVerdict = "file-new" | "skip" | "file-regression"

/** The hidden marker; matches only the marker, never the human-readable prose line. */
const BREADCRUMB_MARKER = /<!--\s*dispatch-sentry-triage:\s*(\{.*?\})\s*-->/g

/** Linear ref shape, e.g. PRO-372 / PRODUCT-12. */
const LINEAR_REF = /^[A-Z][A-Z0-9]*-\d+$/

/**
 * Parse ALL dispatch-sentry-triage breadcrumb markers out of a single note body
 * (or any text blob), in document order. Tolerant: a marker whose JSON is
 * malformed or whose required fields are missing/ill-formed is skipped, not
 * thrown — a hand-written note that merely *mentions* Linear must never be
 * mistaken for a breadcrumb.
 */
export function extractSentryBreadcrumbs(noteText: string): SentryBreadcrumb[] {
  const out: SentryBreadcrumb[] = []
  for (const match of noteText.matchAll(BREADCRUMB_MARKER)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(match[1])
    } catch {
      continue
    }
    if (typeof parsed !== "object" || parsed === null) continue
    const obj = parsed as Record<string, unknown>
    const { linearTicketId, linearTicketUuid, url } = obj
    if (
      typeof linearTicketId !== "string" ||
      !LINEAR_REF.test(linearTicketId)
    ) {
      continue
    }
    if (typeof url !== "string" || url.length === 0) continue
    const breadcrumb: SentryBreadcrumb = { linearTicketId, url }
    if (typeof linearTicketUuid === "string" && linearTicketUuid.length > 0) {
      breadcrumb.linearTicketUuid = linearTicketUuid
    }
    out.push(breadcrumb)
  }
  return out
}

/**
 * Given the Sentry issue's notes (any order), return the breadcrumb from the
 * MOST RECENT note that carries a valid marker, or null if none do. "Latest" is
 * decided by `createdAt`, never by array position — multiple breadcrumbs can
 * accrue across regression cycles and only the newest reflects the current
 * linked ticket.
 *
 * A note whose `createdAt` is missing/unparsable is treated as `-Infinity`: it
 * can win only if it is the sole breadcrumb-bearing note, and always loses to
 * any note with a valid timestamp. Ties resolve to the last in iteration order.
 */
export function selectLatestSentryBreadcrumb(
  notes: SentryNote[],
): SentryBreadcrumb | null {
  let best: SentryBreadcrumb | null = null
  let bestTime = Number.NEGATIVE_INFINITY
  for (const note of notes) {
    const parsedTime = Date.parse(note.createdAt)
    const time = Number.isNaN(parsedTime)
      ? Number.NEGATIVE_INFINITY
      : parsedTime
    for (const breadcrumb of extractSentryBreadcrumbs(note.body)) {
      // `>=` so ties (and equal -Infinity values) resolve to the last seen.
      if (best === null || time >= bestTime) {
        best = breadcrumb
        bestTime = time
      }
    }
  }
  return best
}

/**
 * Decide what to do with a Sentry candidate, given the live facts. Existence of
 * a breadcrumb is never the test — the linked ticket's STATE is.
 *
 * | breadcrumb | terminality      | actionable | verdict          |
 * |------------|------------------|------------|------------------|
 * | none       | —                | true       | file-new         |
 * | present    | non-terminal     | (any)      | skip (in flight) |
 * | present    | done OR rejected | true       | file-regression  |
 * | present    | done OR rejected | false      | skip (defensive) |
 * | present    | null (unknown)   | (any)      | skip (can't confirm) |
 *
 * The `null` terminality row is defensive: a breadcrumb exists but the linked
 * ticket's state couldn't be resolved (deleted ticket, transient Linear read
 * failure). We `skip` rather than re-file, because the system's prime directive
 * is "never mint a duplicate" — re-filing a regression for an unconfirmed ticket
 * risks duplicating in-flight work. The skill surfaces the underlying read
 * failure separately (it never silently swallows it).
 */
export function decideSentryTriage(
  input: SentryTriageInput,
): SentryTriageVerdict {
  const { breadcrumb, ticketTerminality, inActionableQuery } = input
  if (breadcrumb === null) return "file-new"
  if (ticketTerminality === "non-terminal") return "skip"
  // Unknown ticket state: can't confirm it's safe to re-file → skip.
  if (ticketTerminality === null) return "skip"
  // terminal (done or rejected): re-file only if the issue is back in the query.
  return inActionableQuery ? "file-regression" : "skip"
}
