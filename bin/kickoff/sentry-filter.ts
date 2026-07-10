/**
 * Threshold predicate deciding whether a Sentry issue is worth filing at
 * all, BEFORE the expensive investigation step (pure).
 *
 * The agent normalizes raw Sentry MCP output into `SentryIssueShape` and supplies
 * a `ctx` carrying the current time and the latest production deploy timestamp
 * (sourced however the session can — see the triage-sentry skill). All judgment
 * about counts/recency/deploy-staleness lives here as code so it's testable and
 * consistent across runs.
 */

import type { SentryConfig } from "./config"

export type SentryIssueShape = {
  shortId: string
  events: number
  users: number
  /** ISO timestamp of the most recent occurrence. */
  lastSeen: string
  /** Sentry status; `resolved`/`ignored` are not actionable. */
  status: string
  environment: string
}

export type SentryFilterCtx = {
  /** ISO "now". */
  now: string
  /** ISO timestamp of the latest production deploy, or null if unavailable. */
  latestDeployAt: string | null
}

export type FilterVerdict = { pass: boolean; reason: string }

const DAY_MS = 24 * 60 * 60 * 1000

function daysAgo(now: string, then: string): number {
  return (Date.parse(now) - Date.parse(then)) / DAY_MS
}

/**
 * @returns `{ pass, reason }`. `reason` always explains the verdict (including
 * for passes), and flags the degraded mode when the deploy check was skipped.
 */
export function passesSentryThreshold(
  issue: SentryIssueShape,
  config: SentryConfig,
  ctx: SentryFilterCtx,
): FilterVerdict {
  const status = issue.status.toLowerCase()
  if (status === "resolved" || status === "ignored") {
    return { pass: false, reason: `status is ${status}` }
  }
  if (!config.environments.includes(issue.environment)) {
    return {
      pass: false,
      reason: `environment ${issue.environment} not in scope`,
    }
  }
  if (issue.events < config.minEvents) {
    return {
      pass: false,
      reason: `events ${issue.events} < min ${config.minEvents}`,
    }
  }
  // The floor is 0 by design (see DEFAULT_SENTRY.minAffectedUsers). User
  // attribution isn't reliably present on Sentry events — `users: 0` means
  // unattributed, not unaffected — so a positive floor would silently drop real
  // errors. `users` is a lower bound, never a penalty; the same rationale makes
  // it boost-only in prioritizeSentryCandidates. Don't reintroduce a positive
  // floor casually.
  if (issue.users < config.minAffectedUsers) {
    return {
      pass: false,
      reason: `affected users ${issue.users} < min ${config.minAffectedUsers}`,
    }
  }
  if (daysAgo(ctx.now, issue.lastSeen) > config.lookbackDays) {
    return {
      pass: false,
      reason: `last seen > ${config.lookbackDays}d ago (outside lookback)`,
    }
  }

  if (config.requireSeenSinceLatestDeploy) {
    if (ctx.latestDeployAt != null) {
      if (Date.parse(issue.lastSeen) < Date.parse(ctx.latestDeployAt)) {
        return { pass: false, reason: "not seen since latest deploy" }
      }
      return { pass: true, reason: "passes; seen since latest deploy" }
    }
    // Degraded mode: no deploy data — fall back to a tighter recency window and
    // make the skipped check visible in the run log (requirement not dropped).
    if (
      daysAgo(ctx.now, issue.lastSeen) > config.staleAfterDeployFallbackDays
    ) {
      return {
        pass: false,
        reason: `deploy data unavailable; last seen > fallback ${config.staleAfterDeployFallbackDays}d window`,
      }
    }
    return {
      pass: true,
      reason: `passes; deploy check SKIPPED (no deploy data), within ${config.staleAfterDeployFallbackDays}d fallback`,
    }
  }

  return { pass: true, reason: "passes thresholds" }
}

export type SentryPriorityInput = {
  shortId: string
  events: number
  users: number
  /**
   * True iff the issue appeared in the is:regressed OR is:escalating actionable
   * result set (Tier A). The triage-sentry skill captures this membership when
   * pulling the actionable set. `status` alone is insufficient — an issue can be
   * status:"unresolved" yet be escalating.
   */
  isRegressedOrEscalating: boolean
}

/**
 * Deterministic worst-first order for threshold survivors, applied BEFORE the
 * investigation cap (see the triage-sentry skill, step 4). With the low
 * `minEvents` floor, survivors routinely exceed `caps.maxInvestigationsPerRun`,
 * so the cap must be taken from an ordered pool rather than an unordered one.
 *
 * Ordering (spec PRO-677 §Prioritization):
 *   1. Tier A (`isRegressedOrEscalating`) before Tier B. The tier is FLAT —
 *      no ranking between `regressed` and `escalating` (both set the flag).
 *   2. Within a tier: `events` descending.
 *   3. Tiebreak: `users` descending — boost-only. Attribution is a lower bound
 *      (`users: 0` = unattributed, not unaffected), so it is never a primary
 *      key or a penalty (mirrors the minAffectedUsers rationale).
 *   4. Final tiebreak: `shortId` ascending — a total order so the result is
 *      deterministic regardless of input order (not reliant on sort stability).
 *
 * Pure: returns a new array; does not mutate the input. Generic so callers can
 * pass richer candidate objects and get them back reordered with all fields.
 * Deliberately NO weighted score — with a cap of 5 and overflow deferral, tuned
 * weights are false precision.
 */
export function prioritizeSentryCandidates<T extends SentryPriorityInput>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((a, b) => {
    if (a.isRegressedOrEscalating !== b.isRegressedOrEscalating) {
      return a.isRegressedOrEscalating ? -1 : 1
    }
    if (a.events !== b.events) return b.events - a.events
    if (a.users !== b.users) return b.users - a.users
    return a.shortId < b.shortId ? -1 : a.shortId > b.shortId ? 1 : 0
  })
}
