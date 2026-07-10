import { describe, expect, test } from "bun:test"
import { DEFAULT_SENTRY, type SentryConfig } from "./config"
import {
  passesSentryThreshold,
  prioritizeSentryCandidates,
  type SentryIssueShape,
  type SentryPriorityInput,
} from "./sentry-filter"

const NOW = "2026-06-09T00:00:00Z"
const config: SentryConfig = { ...DEFAULT_SENTRY }

function issue(p: Partial<SentryIssueShape> = {}): SentryIssueShape {
  return {
    shortId: "PRODUCT-WEB-1",
    events: 100,
    users: 10,
    lastSeen: "2026-06-08T00:00:00Z",
    status: "unresolved",
    environment: "production",
    ...p,
  }
}

describe("passesSentryThreshold", () => {
  test("healthy issue passes (seen since deploy)", () => {
    const v = passesSentryThreshold(issue(), config, {
      now: NOW,
      latestDeployAt: "2026-06-07T00:00:00Z",
    })
    expect(v.pass).toBe(true)
  })

  test("below min events fails", () => {
    // events: 1 is below the floor of 2; exercise the branch explicitly rather
    // than leaning on the default magnitude (which is now a low 2).
    const v = passesSentryThreshold(issue({ events: 1 }), config, {
      now: NOW,
      latestDeployAt: "2026-06-07T00:00:00Z",
    })
    expect(v.pass).toBe(false)
    expect(v.reason).toMatch(/events/)
  })

  test("minEvents: 2 — events: 2 passes, events: 1 fails (pins the low floor)", () => {
    // Regression guard: a repeating prod error triages from its second
    // occurrence. If a future change bumps minEvents back up, this fails loudly.
    const passes = passesSentryThreshold(issue({ events: 2 }), config, {
      now: NOW,
      latestDeployAt: "2026-06-07T00:00:00Z",
    })
    expect(passes.pass).toBe(true)

    const fails = passesSentryThreshold(issue({ events: 1 }), config, {
      now: NOW,
      latestDeployAt: "2026-06-07T00:00:00Z",
    })
    expect(fails.pass).toBe(false)
    expect(fails.reason).toMatch(/events/)
  })

  test("minAffectedUsers: 0 passes an issue with users: 0", () => {
    const v = passesSentryThreshold(
      issue({ users: 0 }),
      { ...config, minAffectedUsers: 0 },
      {
        now: NOW,
        latestDeployAt: "2026-06-07T00:00:00Z",
      },
    )
    expect(v.pass).toBe(true)
  })

  test("below min affected users fails", () => {
    // The default floor is 0 by design, so cover the branch with an explicit
    // positive floor rather than the default.
    const v = passesSentryThreshold(
      issue({ users: 1 }),
      { ...config, minAffectedUsers: 5 },
      {
        now: NOW,
        latestDeployAt: "2026-06-07T00:00:00Z",
      },
    )
    expect(v.pass).toBe(false)
    expect(v.reason).toMatch(/users/)
  })

  test("resolved status fails", () => {
    const v = passesSentryThreshold(issue({ status: "resolved" }), config, {
      now: NOW,
      latestDeployAt: null,
    })
    expect(v.pass).toBe(false)
  })

  test("wrong environment fails", () => {
    const v = passesSentryThreshold(issue({ environment: "staging" }), config, {
      now: NOW,
      latestDeployAt: null,
    })
    expect(v.pass).toBe(false)
  })

  test("stale by lookback window fails", () => {
    const v = passesSentryThreshold(
      issue({ lastSeen: "2026-05-01T00:00:00Z" }),
      config,
      { now: NOW, latestDeployAt: null },
    )
    expect(v.pass).toBe(false)
    expect(v.reason).toMatch(/lookback/)
  })

  test("lastSeen before latestDeployAt fails (Blocking #3)", () => {
    const v = passesSentryThreshold(
      issue({ lastSeen: "2026-06-05T00:00:00Z" }),
      config,
      { now: NOW, latestDeployAt: "2026-06-06T00:00:00Z" },
    )
    expect(v.pass).toBe(false)
    expect(v.reason).toMatch(/not seen since latest deploy/)
  })

  test("lastSeen at/after latestDeployAt passes", () => {
    const v = passesSentryThreshold(
      issue({ lastSeen: "2026-06-06T00:00:00Z" }),
      config,
      { now: NOW, latestDeployAt: "2026-06-06T00:00:00Z" },
    )
    expect(v.pass).toBe(true)
  })

  test("null latestDeployAt → falls back to staleAfterDeployFallbackDays window", () => {
    // within fallback window (3d) → passes but flags skipped check
    const within = passesSentryThreshold(
      issue({ lastSeen: "2026-06-07T00:00:00Z" }),
      config,
      { now: NOW, latestDeployAt: null },
    )
    expect(within.pass).toBe(true)
    expect(within.reason).toMatch(/SKIPPED/)

    // outside fallback window → fails
    const outside = passesSentryThreshold(
      issue({ lastSeen: "2026-06-04T00:00:00Z" }),
      config,
      { now: NOW, latestDeployAt: null },
    )
    expect(outside.pass).toBe(false)
    expect(outside.reason).toMatch(/fallback/)
  })
})

describe("prioritizeSentryCandidates", () => {
  function candidate(
    p: Partial<SentryPriorityInput> = {},
  ): SentryPriorityInput {
    return {
      shortId: "PRODUCT-WEB-1",
      events: 10,
      users: 0,
      isRegressedOrEscalating: false,
      ...p,
    }
  }

  test("Tier A beats Tier B even with far fewer events", () => {
    const tierB = candidate({ shortId: "B", events: 10000 })
    const tierA = candidate({
      shortId: "A",
      events: 2,
      isRegressedOrEscalating: true,
    })
    const out = prioritizeSentryCandidates([tierB, tierA])
    expect(out.map((c) => c.shortId)).toEqual(["A", "B"])
  })

  test("flat tier: two Tier A issues order by events desc", () => {
    // Regressed and escalating both set the single `isRegressedOrEscalating`
    // flag — the tier is flat, so only events/users decide within it.
    const escalating = candidate({
      shortId: "ESC",
      events: 5,
      isRegressedOrEscalating: true,
    })
    const regressed = candidate({
      shortId: "REG",
      events: 50,
      isRegressedOrEscalating: true,
    })
    const out = prioritizeSentryCandidates([escalating, regressed])
    expect(out.map((c) => c.shortId)).toEqual(["REG", "ESC"])
  })

  test("within a tier: events descending", () => {
    const low = candidate({ shortId: "LOW", events: 3 })
    const high = candidate({ shortId: "HIGH", events: 300 })
    const mid = candidate({ shortId: "MID", events: 30 })
    const out = prioritizeSentryCandidates([low, high, mid])
    expect(out.map((c) => c.shortId)).toEqual(["HIGH", "MID", "LOW"])
  })

  test("events tie → users descending (boost-only tiebreak)", () => {
    const fewUsers = candidate({ shortId: "FEW", events: 10, users: 1 })
    const manyUsers = candidate({ shortId: "MANY", events: 10, users: 9 })
    const out = prioritizeSentryCandidates([fewUsers, manyUsers])
    expect(out.map((c) => c.shortId)).toEqual(["MANY", "FEW"])
  })

  test("events + users tie → shortId ascending (deterministic total order)", () => {
    const c1 = candidate({ shortId: "PRODUCT-WEB-9", events: 10, users: 2 })
    const c2 = candidate({ shortId: "PRODUCT-WEB-1", events: 10, users: 2 })
    const out = prioritizeSentryCandidates([c1, c2])
    expect(out.map((c) => c.shortId)).toEqual([
      "PRODUCT-WEB-1",
      "PRODUCT-WEB-9",
    ])
  })

  test("input-order independent (does not rely on sort stability)", () => {
    const a = candidate({
      shortId: "A",
      events: 5,
      isRegressedOrEscalating: true,
    })
    const b = candidate({ shortId: "B", events: 100 })
    const c = candidate({ shortId: "C", events: 5, users: 3 })
    const forward = prioritizeSentryCandidates([a, b, c]).map((x) => x.shortId)
    const reversed = prioritizeSentryCandidates([c, b, a]).map((x) => x.shortId)
    expect(forward).toEqual(reversed)
  })

  test("does not mutate the input array", () => {
    const input = [
      candidate({ shortId: "A", events: 1 }),
      candidate({ shortId: "B", events: 100 }),
    ]
    const snapshot = input.map((c) => c.shortId)
    prioritizeSentryCandidates(input)
    expect(input.map((c) => c.shortId)).toEqual(snapshot)
  })

  test("empty array → empty array", () => {
    expect(prioritizeSentryCandidates([])).toEqual([])
  })

  test("generic: extra fields on richer candidates survive the reorder", () => {
    type Rich = SentryPriorityInput & { verdict: string }
    const input: Rich[] = [
      {
        shortId: "B",
        events: 1,
        users: 0,
        isRegressedOrEscalating: false,
        verdict: "b",
      },
      {
        shortId: "A",
        events: 9,
        users: 0,
        isRegressedOrEscalating: false,
        verdict: "a",
      },
    ]
    const out = prioritizeSentryCandidates(input)
    expect(out.map((c) => c.verdict)).toEqual(["a", "b"])
  })
})
