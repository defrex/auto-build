import { describe, expect, test } from "bun:test"
import type { LinearConfig } from "../kickoff/config"
import { orderedStateBuckets, rankOfState } from "./linear-state-order"

const linear: LinearConfig = {
  teamId: "team_1",
  projectId: "proj_1",
  triageStateId: "s_triage",
  readyStateId: "s_ready",
  inProgressStateId: "s_progress",
  inReviewStateId: "s_review",
  doneStateId: "s_done",
  rejectedStateIds: ["s_rejected_a", "s_rejected_b"],
  sourceObservationsLabelId: "l_obs",
  sourceSentryLabelId: "l_sentry",
  needsDefinitionLabelId: "l_needs_def",
}

describe("rankOfState", () => {
  test("ranks triage and ready as 0 (earlier)", () => {
    expect(rankOfState(linear, "s_triage")).toBe(0)
    expect(rankOfState(linear, "s_ready")).toBe(0)
  })

  test("ranks in-progress as 1", () => {
    expect(rankOfState(linear, "s_progress")).toBe(1)
  })

  test("ranks in-review as 2", () => {
    expect(rankOfState(linear, "s_review")).toBe(2)
  })

  test("ranks done and every rejected id as 3 (terminal)", () => {
    expect(rankOfState(linear, "s_done")).toBe(3)
    expect(rankOfState(linear, "s_rejected_a")).toBe(3)
    expect(rankOfState(linear, "s_rejected_b")).toBe(3)
  })

  test("returns null for an unrecognized id (e.g. Linear's Backlog)", () => {
    expect(rankOfState(linear, "s_backlog")).toBeNull()
    expect(rankOfState(linear, "")).toBeNull()
  })

  test("an unpinned in-review id leaves rank 2 unrecognized", () => {
    const noReview = { ...linear, inReviewStateId: "" }
    expect(rankOfState(noReview, "s_review")).toBeNull()
  })
})

describe("orderedStateBuckets", () => {
  test("returns the four ranked buckets with their configured ids", () => {
    const buckets = orderedStateBuckets(linear)
    expect(buckets).toEqual([
      {
        rank: 0,
        label: "triage/ready (earlier)",
        stateIds: ["s_triage", "s_ready"],
      },
      { rank: 1, label: "In-Progress", stateIds: ["s_progress"] },
      { rank: 2, label: "In Review", stateIds: ["s_review"] },
      {
        rank: 3,
        label: "Done/canceled (terminal)",
        stateIds: ["s_done", "s_rejected_a", "s_rejected_b"],
      },
    ])
  })

  test("excludes empty-string config ids (unpinned in-review → no rank-2 bucket)", () => {
    const noReview = { ...linear, inReviewStateId: "" }
    const buckets = orderedStateBuckets(noReview)
    expect(buckets.find((b) => b.rank === 2)).toBeUndefined()
    // the other buckets survive
    expect(buckets.map((b) => b.rank)).toEqual([0, 1, 3])
  })

  test("drops a bucket entirely when all its ids are empty", () => {
    const bare: LinearConfig = {
      ...linear,
      triageStateId: "",
      readyStateId: "",
    }
    const buckets = orderedStateBuckets(bare)
    expect(buckets.find((b) => b.rank === 0)).toBeUndefined()
  })

  test("duplicate ids across fields resolve to the lowest rank (first wins)", () => {
    const dup = { ...linear, inReviewStateId: "s_progress" }
    // s_progress is rank 1; the rank-2 bucket also lists it, but rankOfState
    // returns the lowest matching rank.
    expect(rankOfState(dup, "s_progress")).toBe(1)
  })
})
