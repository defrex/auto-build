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

/** The fields that make a Sentry occurrence's identity unambiguous + scoped. */
export type SentryIdParts = {
  organizationSlug: string
  projectSlug: string
  /** Sentry's upstream issue fingerprint (already deduped by Sentry). */
  shortId: string
}

/**
 * The canonical, project-scoped Sentry signal id. Defined as CODE (not agent
 * prose) so the dedup format can't drift between runs — the same rule the
 * observation path follows with `signalIdFor` (the design's "LLMs never decide
 * identity"). The triage-sentry skill must build the id by this exact format.
 */
export function sentrySignalId({
  organizationSlug,
  projectSlug,
  shortId,
}: SentryIdParts): string {
  return `sentry:${organizationSlug}/${projectSlug}/${shortId}`
}

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
