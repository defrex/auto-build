/**
 * Forward-only state ordering over the CONFIGURED Linear workflow-state ids.
 *
 * Pure leaf module: imports only the `LinearConfig` *type*, so both the prompt
 * renderer (`prompts.ts`) and the impure move step (`linear-status.ts`) can
 * import it with no import cycle.
 *
 * The shared rule both ticket transitions obey is "advance, never retreat"
 * along these ranked buckets:
 *
 *   0  triage / ready          (earlier)
 *   1  In-Progress
 *   2  In Review
 *   3  Done / canceled         (terminal — done + every rejected id)
 *
 * A state id that maps to no bucket (e.g. Linear's "Backlog", which has no
 * `LinearConfig` field, or an unpinned in-review id) is treated conservatively
 * as unrecognized — left alone rather than assumed "earlier".
 */

import type { LinearConfig } from "../kickoff/config"

export type StateBucket = { rank: number; label: string; stateIds: string[] }

/**
 * The ranked buckets over the CONFIGURED Linear state ids (pure). Empty-string
 * ids are filtered out, and a bucket with no remaining ids is dropped entirely
 * (so an unpinned `inReviewStateId` simply means there is no rank-2 bucket).
 */
export function orderedStateBuckets(linear: LinearConfig): StateBucket[] {
  const buckets: StateBucket[] = [
    {
      rank: 0,
      label: "triage/ready (earlier)",
      stateIds: [linear.triageStateId, linear.readyStateId],
    },
    { rank: 1, label: "In-Progress", stateIds: [linear.inProgressStateId] },
    { rank: 2, label: "In Review", stateIds: [linear.inReviewStateId] },
    {
      rank: 3,
      label: "Done/canceled (terminal)",
      stateIds: [linear.doneStateId, ...linear.rejectedStateIds],
    },
  ]
  return buckets
    .map((b) => ({ ...b, stateIds: b.stateIds.filter((id) => id !== "") }))
    .filter((b) => b.stateIds.length > 0)
}

/**
 * Rank of a state id, or `null` if it maps to no configured bucket (pure). When
 * an id appears in more than one bucket (ids are distinct in practice), the
 * lowest rank wins — the buckets are scanned in ascending rank order.
 */
export function rankOfState(
  linear: LinearConfig,
  stateId: string,
): number | null {
  if (stateId === "") return null
  for (const bucket of orderedStateBuckets(linear)) {
    if (bucket.stateIds.includes(stateId)) return bucket.rank
  }
  return null
}
