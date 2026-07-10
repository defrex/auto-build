/**
 * Pure parsing for the kickoff defer-until gate.
 *
 * A Ready ("To Do") ticket can carry a hidden `<!-- defer-until: … -->` marker in
 * its Linear description (mirroring the existing `<!-- signals: … -->` marker
 * convention). A candidate whose defer-until instant is in the future is SKIPPED
 * during selection — passed over like an uncleared blocker, never failed — and
 * becomes claimable on the first kickoff run at/after that instant.
 *
 * Everything here is pure (no IO, clock injected by the caller) so the whole gate
 * is deterministic and unit-testable with no live-Linear dependency. The carrier
 * (description marker vs a future native Linear field) is isolated to
 * {@link extractDeferMarker}, so switching carriers is a one-function change.
 */

/** Matches the first `<!-- defer-until: <value> -->` marker (case-insensitive). */
const DEFER_MARKER_RE = /<!--\s*defer-until:\s*(.*?)\s*-->/i

/** A date-only value: `YYYY-MM-DD`. Resolves to start-of-day UTC. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A zoned ISO datetime carrying an explicit `Z` or `±HH:MM` offset. A bare
 * datetime without a zone is intentionally NOT matched — JS would parse it in the
 * runner's local time, making the same marker resolve to different instants on
 * different machines. Rejecting it forces an explicit UTC/offset instant.
 */
const ZONED_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/

/**
 * Extract the first `<!-- defer-until: … -->` marker value from a description, or
 * `null` when no marker is present. The returned string is the raw marker value
 * (unparsed) — feed it to {@link parseDeferUntil}.
 */
export function extractDeferMarker(description: string): string | null {
  const match = description.match(DEFER_MARKER_RE)
  return match ? match[1] : null
}

/**
 * True iff `YYYY-MM-DD` names a real calendar date. Guards against `Date.parse`
 * rollover: `Date.parse("2026-02-30T…")` returns a *valid* Mar 2 instant rather
 * than `NaN`, so we re-derive the date from the parsed instant and require it to
 * round-trip back to the input. Rejects `2026-02-30`, `2026-06-31`, `2026-13-40`.
 */
function isRealCalendarDate(datePart: string): boolean {
  const ms = Date.parse(`${datePart}T00:00:00.000Z`)
  return (
    !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === datePart
  )
}

/**
 * Parse a raw defer-until marker value into an epoch-ms instant (strict).
 *
 * - null / empty / whitespace-only → not deferred, NOT malformed (absent =
 *   eligible, the common case for a ticket with no marker; an author who left the
 *   marker blank is treated as "no defer", not as a typo to warn about).
 * - date-only `YYYY-MM-DD` → `00:00:00.000Z` that day.
 * - zoned ISO datetime (explicit `Z`/offset) → parsed instant.
 * - anything else (bare datetime, prose, out-of-range, calendar rollover) →
 *   malformed.
 *
 * BOTH the date-only and zoned branches validate the `YYYY-MM-DD` date portion
 * with {@link isRealCalendarDate}: `Date.parse` silently rolls a bad day-of-month
 * forward (`2026-02-30T09:00:00Z` → Mar 2) instead of returning `NaN`, so without
 * this guard a zoned typo would defer to a wrong nearby instant with no warning.
 *
 * A malformed value yields `{ deferUntilMs: null, malformed: true }` so the caller
 * can treat it as not-deferred (claimable) AND log a warning — a typo must never
 * silently strand (or silently mis-defer) a ticket in the queue.
 */
export function parseDeferUntil(raw: string | null | undefined): {
  deferUntilMs: number | null
  malformed: boolean
} {
  const value = raw?.trim() ?? ""
  if (value === "") return { deferUntilMs: null, malformed: false }

  if (DATE_ONLY_RE.test(value)) {
    if (!isRealCalendarDate(value)) {
      return { deferUntilMs: null, malformed: true }
    }
    return {
      deferUntilMs: Date.parse(`${value}T00:00:00.000Z`),
      malformed: false,
    }
  }

  if (ZONED_DATETIME_RE.test(value)) {
    const ms = Date.parse(value)
    if (Number.isNaN(ms) || !isRealCalendarDate(value.slice(0, 10))) {
      return { deferUntilMs: null, malformed: true }
    }
    return { deferUntilMs: ms, malformed: false }
  }

  return { deferUntilMs: null, malformed: true }
}

/**
 * A parsed defer instant is "deferred" iff it is strictly in the future relative
 * to `now` (both epoch-ms). Past or exactly-now = eligible (at/after clears).
 * `null` (absent/malformed) = not deferred.
 */
export function isDeferred(deferUntilMs: number | null, now: number): boolean {
  return deferUntilMs !== null && deferUntilMs > now
}
