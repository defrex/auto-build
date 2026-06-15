import { describe, expect, test } from "bun:test"
import { DEFAULT_SENTRY, type SentryConfig } from "./config"
import {
  passesSentryThreshold,
  type SentryIssueShape,
  sentrySignalId,
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

describe("sentrySignalId", () => {
  test("is project-scoped and stable", () => {
    expect(
      sentrySignalId({
        organizationSlug: "kickoff",
        projectSlug: "product-web",
        shortId: "PRODUCT-WEB-1A",
      }),
    ).toBe("sentry:kickoff/product-web/PRODUCT-WEB-1A")
  })

  test("different projects with the same shortId get distinct ids", () => {
    const a = sentrySignalId({
      organizationSlug: "o",
      projectSlug: "p1",
      shortId: "X",
    })
    const b = sentrySignalId({
      organizationSlug: "o",
      projectSlug: "p2",
      shortId: "X",
    })
    expect(a).not.toBe(b)
  })
})

describe("passesSentryThreshold", () => {
  test("healthy issue passes (seen since deploy)", () => {
    const v = passesSentryThreshold(issue(), config, {
      now: NOW,
      latestDeployAt: "2026-06-07T00:00:00Z",
    })
    expect(v.pass).toBe(true)
  })

  test("below min events fails", () => {
    const v = passesSentryThreshold(issue({ events: 5 }), config, {
      now: NOW,
      latestDeployAt: "2026-06-07T00:00:00Z",
    })
    expect(v.pass).toBe(false)
    expect(v.reason).toMatch(/events/)
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
    const v = passesSentryThreshold(issue({ users: 1 }), config, {
      now: NOW,
      latestDeployAt: null,
    })
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
