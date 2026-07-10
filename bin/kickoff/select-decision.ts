/**
 * Pure decision core for the kickoff claim-select step.
 *
 * Given an in-progress count + already-fetched, already-normalized Ready
 * candidates (with their labels and blocked-by relations resolved by the fetch
 * layer), decide whether to claim an issue, report at-capacity, or report
 * nothing-ready. No IO — the impure `select.ts` runner performs the GraphQL
 * fetches and the claim mutation around this.
 *
 * The rules mirror the old `kickoffSelectPrompt` exactly: honor the concurrency
 * cap; exclude needs-definition; order by priority (urgency, higher first) then
 * age (older first); skip candidates with any uncleared blocker (a blocker
 * clears ONLY when its workflow-state type is "completed", and an unreadable
 * blocker fails safe = still blocks); pick the first eligible candidate.
 *
 * A second self-clearing gate mirrors blocked-by: a candidate carrying a
 * defer-until instant in the future is SKIPPED (passed over, never failed) until
 * the wall clock (`input.now`) reaches it. The two gates COMPOSE — a candidate is
 * chosen only when it is both blocker-eligible and not deferred.
 */

import { isDeferred } from "./defer"

/** A blocked-by relation, reduced to its blocker's workflow-state type.
 * `stateType: null` means the blocker's state could not be read → fail safe. */
export type BlockerLite = { id: string; stateType: string | null }

/** A Ready candidate, normalized from Linear for the pure decision. */
export type LinearIssueLite = {
  id: string
  identifier: string
  title: string
  description: string
  priority: number
  createdAt: string
  labelIds: string[]
  blockers: BlockerLite[]
  /** Parsed defer-until instant (epoch ms), or `null` when absent/malformed.
   * Drives the deferral gate — a future value skips the candidate. */
  deferUntilMs: number | null
  /** True when the description carried a defer marker that failed to parse.
   * Treated as not-deferred (claimable) but surfaced as a logged warning. */
  deferMalformed: boolean
  /** The raw (unparsed) defer marker text, for the malformed warning message. */
  deferRaw: string | null
}

export type SelectDecisionConfig = {
  maxConcurrentBuilds: number
  sourceObservationsLabelId: string
  sourceSentryLabelId: string
  needsDefinitionLabelId: string
}

export type SelectDecisionInput = {
  inProgressCount: number
  candidates: LinearIssueLite[]
  config: SelectDecisionConfig
  /** Wall clock (epoch ms) the deferral gate is evaluated against, injected so
   * the decision stays deterministic in tests. */
  now: number
}

export type SelectSource = "observations" | "sentry" | "groomed"

export type SelectDecisionOutput =
  | { kind: "at-capacity" }
  | { kind: "none" }
  | {
      kind: "claim"
      issue: LinearIssueLite
      source: SelectSource
      inProgressCount: number
    }

/**
 * Sort key for a Linear priority: lower = considered sooner. Linear encodes
 * 0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low — so urgency order
 * is just the numeric value EXCEPT 0, which means "no priority" and must sort
 * LAST (mapped to +Infinity).
 */
export function priorityRank(priority: number): number {
  return priority === 0 ? Number.POSITIVE_INFINITY : priority
}

/** Order candidates by priority (urgency, higher first) then age (older first). */
export function compareCandidates(
  a: LinearIssueLite,
  b: LinearIssueLite,
): number {
  const byPriority = priorityRank(a.priority) - priorityRank(b.priority)
  if (byPriority !== 0) return byPriority
  return a.createdAt.localeCompare(b.createdAt)
}

/** A blocked-by relation clears ONLY when the blocker reached a completed state. */
export function isBlockerCleared(stateType: string | null): boolean {
  return stateType === "completed"
}

/** Eligible iff EVERY blocked-by relation is cleared (vacuously true if none). */
export function isEligible(issue: LinearIssueLite): boolean {
  return issue.blockers.every((b) => isBlockerCleared(b.stateType))
}

/** Deferred iff the candidate's parsed defer instant is strictly after `now`. */
export function isDeferredCandidate(
  issue: LinearIssueLite,
  now: number,
): boolean {
  return isDeferred(issue.deferUntilMs, now)
}

/** Classify the issue's source from its ingester labels (else "groomed"). */
export function classifySource(
  labelIds: string[],
  cfg: SelectDecisionConfig,
): SelectSource {
  if (labelIds.includes(cfg.sourceObservationsLabelId)) return "observations"
  if (labelIds.includes(cfg.sourceSentryLabelId)) return "sentry"
  return "groomed"
}

/**
 * Decide the claim-select outcome (pure). Capacity first; then exclude
 * needs-definition carriers; then pick the highest-priority / oldest candidate
 * whose blockers are all cleared. Blocked candidates are SKIPPED, never failed.
 */
export function decideSelection(
  input: SelectDecisionInput,
): SelectDecisionOutput {
  const { inProgressCount, candidates, config, now } = input
  if (inProgressCount >= config.maxConcurrentBuilds) {
    return { kind: "at-capacity" }
  }

  // Defensive: the server filter already excludes needs-definition, but never
  // claim one even if a stale/duplicate label slipped through.
  const eligibleByLabel = candidates.filter(
    (c) => !c.labelIds.includes(config.needsDefinitionLabelId),
  )
  const ordered = [...eligibleByLabel].sort(compareCandidates)
  // Both gates must clear: not blocked AND not deferred (composes with blocked-by).
  const chosen = ordered.find(
    (c) => isEligible(c) && !isDeferredCandidate(c, now),
  )
  if (!chosen) return { kind: "none" }

  return {
    kind: "claim",
    issue: chosen,
    source: classifySource(chosen.labelIds, config),
    inProgressCount,
  }
}
