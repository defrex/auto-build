/**
 * Pure-core tests for the kickoff claim-select decision. This is where the bulk
 * of the selection rules are pinned (capacity, needs-definition exclusion,
 * priority/age ordering, the blocker gate with its fail-safe, and source
 * classification) — all without any Linear IO.
 */

import { describe, expect, test } from "bun:test"
import {
  classifySource,
  compareCandidates,
  decideSelection,
  isBlockerCleared,
  isDeferredCandidate,
  isEligible,
  type LinearIssueLite,
  priorityRank,
  type SelectDecisionInput,
} from "./select-decision"

const CFG = {
  maxConcurrentBuilds: 2,
  sourceObservationsLabelId: "l_obs",
  sourceSentryLabelId: "l_sentry",
  needsDefinitionLabelId: "l_nd",
}

const NOW = Date.parse("2026-07-09T00:00:00.000Z")

let seq = 0
function mk(overrides: Partial<LinearIssueLite> = {}): LinearIssueLite {
  seq += 1
  return {
    id: `u-${seq}`,
    identifier: `PRO-${seq}`,
    title: `issue ${seq}`,
    description: `brief ${seq}`,
    priority: 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    labelIds: [],
    blockers: [],
    deferUntilMs: null,
    deferMalformed: false,
    deferRaw: null,
    ...overrides,
  }
}

function input(over: Partial<SelectDecisionInput> = {}): SelectDecisionInput {
  return { inProgressCount: 0, candidates: [], config: CFG, now: NOW, ...over }
}

describe("priorityRank", () => {
  test("0 (no priority) sorts LAST, urgent(1) before high(2)", () => {
    expect(priorityRank(0)).toBe(Number.POSITIVE_INFINITY)
    expect(priorityRank(1)).toBeLessThan(priorityRank(2))
    expect(priorityRank(4)).toBeLessThan(priorityRank(0))
  })
})

describe("isBlockerCleared", () => {
  test("only a completed blocker is cleared; everything else (incl null) blocks", () => {
    expect(isBlockerCleared("completed")).toBe(true)
    for (const t of ["backlog", "triage", "unstarted", "started", "canceled"]) {
      expect(isBlockerCleared(t)).toBe(false)
    }
    expect(isBlockerCleared(null)).toBe(false)
  })
})

describe("classifySource", () => {
  test("observations / sentry / groomed by label presence", () => {
    expect(classifySource(["l_obs"], CFG)).toBe("observations")
    expect(classifySource(["l_sentry"], CFG)).toBe("sentry")
    expect(classifySource(["whatever"], CFG)).toBe("groomed")
  })
})

describe("decideSelection", () => {
  test("at capacity → at-capacity, candidates ignored", () => {
    const out = decideSelection(
      input({ inProgressCount: 2, candidates: [mk()] }),
    )
    expect(out.kind).toBe("at-capacity")
  })

  test("empty queue → none", () => {
    expect(decideSelection(input()).kind).toBe("none")
  })

  test("a Ready issue carrying needs-definition is excluded", () => {
    const out = decideSelection(
      input({ candidates: [mk({ labelIds: ["l_nd"] })] }),
    )
    expect(out.kind).toBe("none")
  })

  test("urgent (1) beats high (2) even when newer", () => {
    const high = mk({ priority: 2, createdAt: "2025-01-01T00:00:00.000Z" })
    const urgent = mk({ priority: 1, createdAt: "2026-06-01T00:00:00.000Z" })
    const out = decideSelection(input({ candidates: [high, urgent] }))
    expect(out.kind === "claim" && out.issue.id).toBe(urgent.id)
  })

  test("priority 0 sorts last vs low (4)", () => {
    const none = mk({ priority: 0, createdAt: "2020-01-01T00:00:00.000Z" })
    const low = mk({ priority: 4, createdAt: "2026-01-01T00:00:00.000Z" })
    const out = decideSelection(input({ candidates: [none, low] }))
    expect(out.kind === "claim" && out.issue.id).toBe(low.id)
  })

  test("equal priority → older first", () => {
    const newer = mk({ priority: 3, createdAt: "2026-06-01T00:00:00.000Z" })
    const older = mk({ priority: 3, createdAt: "2026-01-01T00:00:00.000Z" })
    const out = decideSelection(input({ candidates: [newer, older] }))
    expect(out.kind === "claim" && out.issue.id).toBe(older.id)
  })

  test("a completed blocker clears; no blockers claims", () => {
    const cleared = mk({ blockers: [{ id: "b", stateType: "completed" }] })
    expect(decideSelection(input({ candidates: [cleared] })).kind).toBe("claim")
    const open = mk({ blockers: [] })
    expect(decideSelection(input({ candidates: [open] })).kind).toBe("claim")
  })

  test("a started/canceled/unreadable blocker blocks (only candidate → none)", () => {
    for (const stateType of ["started", "canceled", null]) {
      const out = decideSelection(
        input({ candidates: [mk({ blockers: [{ id: "b", stateType }] })] }),
      )
      expect(out.kind).toBe("none")
    }
  })

  test("mixed blockers [completed, started] still blocks", () => {
    const out = decideSelection(
      input({
        candidates: [
          mk({
            blockers: [
              { id: "b1", stateType: "completed" },
              { id: "b2", stateType: "started" },
            ],
          }),
        ],
      }),
    )
    expect(out.kind).toBe("none")
  })

  test("skips a higher-priority blocked candidate for a lower-priority eligible one", () => {
    const blockedUrgent = mk({
      priority: 1,
      blockers: [{ id: "b", stateType: "started" }],
    })
    const eligibleLow = mk({ priority: 4, blockers: [] })
    const out = decideSelection(
      input({ candidates: [blockedUrgent, eligibleLow] }),
    )
    expect(out.kind === "claim" && out.issue.id).toBe(eligibleLow.id)
  })

  test("claim carries inProgressCount and classified source", () => {
    const issue = mk({ labelIds: ["l_sentry"] })
    const out = decideSelection(
      input({ inProgressCount: 1, candidates: [issue] }),
    )
    expect(out).toEqual({
      kind: "claim",
      issue,
      source: "sentry",
      inProgressCount: 1,
    })
  })

  test("a future-deferred sole candidate → none (skipped, not chosen)", () => {
    const deferred = mk({ deferUntilMs: NOW + 86_400_000 })
    expect(decideSelection(input({ candidates: [deferred] })).kind).toBe("none")
  })

  test("a past-deferred candidate is claimed (no effect)", () => {
    const past = mk({ deferUntilMs: NOW - 1 })
    expect(decideSelection(input({ candidates: [past] })).kind).toBe("claim")
  })

  test("an absent-defer candidate is claimed (today's behaviour)", () => {
    expect(
      decideSelection(input({ candidates: [mk({ deferUntilMs: null })] })).kind,
    ).toBe("claim")
  })

  test("an exact-now defer is claimed (boundary: at/after is eligible)", () => {
    const atNow = mk({ deferUntilMs: NOW })
    expect(decideSelection(input({ candidates: [atNow] })).kind).toBe("claim")
  })

  test("skips a higher-priority deferred candidate for a lower-priority eligible one", () => {
    const deferredUrgent = mk({ priority: 1, deferUntilMs: NOW + 86_400_000 })
    const eligibleLow = mk({ priority: 4 })
    const out = decideSelection(
      input({ candidates: [deferredUrgent, eligibleLow] }),
    )
    expect(out.kind === "claim" && out.issue.id).toBe(eligibleLow.id)
  })

  test("deferred AND blocked → skipped until both gates clear", () => {
    // future-defer + completed-blocker → still deferred → none
    const futureDeferDoneBlock = mk({
      deferUntilMs: NOW + 86_400_000,
      blockers: [{ id: "b", stateType: "completed" }],
    })
    expect(
      decideSelection(input({ candidates: [futureDeferDoneBlock] })).kind,
    ).toBe("none")

    // past-defer + started-blocker → still blocked → none
    const pastDeferStartedBlock = mk({
      deferUntilMs: NOW - 1,
      blockers: [{ id: "b", stateType: "started" }],
    })
    expect(
      decideSelection(input({ candidates: [pastDeferStartedBlock] })).kind,
    ).toBe("none")

    // past-defer + completed-blocker → both clear → claim
    const bothClear = mk({
      deferUntilMs: NOW - 1,
      blockers: [{ id: "b", stateType: "completed" }],
    })
    expect(decideSelection(input({ candidates: [bothClear] })).kind).toBe(
      "claim",
    )
  })

  test("isDeferredCandidate mirrors the future-instant gate", () => {
    expect(isDeferredCandidate(mk({ deferUntilMs: NOW + 1 }), NOW)).toBe(true)
    expect(isDeferredCandidate(mk({ deferUntilMs: NOW }), NOW)).toBe(false)
    expect(isDeferredCandidate(mk({ deferUntilMs: NOW - 1 }), NOW)).toBe(false)
    expect(isDeferredCandidate(mk({ deferUntilMs: null }), NOW)).toBe(false)
  })

  test("isEligible mirrors the blocker gate", () => {
    expect(isEligible(mk({ blockers: [] }))).toBe(true)
    expect(
      isEligible(mk({ blockers: [{ id: "b", stateType: "completed" }] })),
    ).toBe(true)
    expect(
      isEligible(mk({ blockers: [{ id: "b", stateType: "started" }] })),
    ).toBe(false)
  })

  test("compareCandidates is a stable priority-then-age comparator", () => {
    const a = mk({ priority: 1, createdAt: "2026-01-02T00:00:00.000Z" })
    const b = mk({ priority: 1, createdAt: "2026-01-01T00:00:00.000Z" })
    expect(compareCandidates(a, b)).toBeGreaterThan(0)
    expect(compareCandidates(b, a)).toBeLessThan(0)
  })
})
