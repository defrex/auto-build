import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildDir,
  buildStateSchema,
  bumpAnalytics,
  defaultHarnessMap,
  initState,
  optionalStepDecisionSchema,
  optionalStepIdSchema,
  optionalStepOverridesSchema,
  optionalStepsSchema,
  readState,
  statePath,
  writeState,
} from "./state"

describe("defaultHarnessMap", () => {
  test("claude/opus plans & builds, codex reviews", () => {
    const map = defaultHarnessMap()
    expect(map.plan).toEqual({ bin: "claude", model: "opus" })
    expect(map.build).toEqual({ bin: "claude", model: "opus" })
    expect(map.pr).toEqual({ bin: "claude", model: "opus" })
    expect(map["plan-review"]).toEqual({ bin: "codex" })
    expect(map.review).toEqual({ bin: "codex" })
  })

  test("validates against the schema", () => {
    expect(() =>
      buildStateSchema.shape.harnessMap.parse(defaultHarnessMap()),
    ).not.toThrow()
  })
})

describe("path helpers", () => {
  test("buildDir and statePath compose under build/[feature]", () => {
    expect(buildDir("/repo", "build-flow")).toBe("/repo/build/build-flow")
    expect(statePath("/repo", "build-flow")).toBe(
      "/repo/build/build-flow/state.json",
    )
  })
})

describe("initState", () => {
  test("starts at plan/running with empty review round", () => {
    const s = initState(
      "build-flow",
      "amplified-geography",
      "2026-05-28T00:00:00Z",
    )
    expect(s.feature).toBe("build-flow")
    expect(s.phase).toBe("plan")
    expect(s.status).toBe("running")
    expect(s.reviewRound).toBe(0)
    expect(s.branch).toBe("amplified-geography")
    expect(s.updatedAt).toBe("2026-05-28T00:00:00Z")
    expect(() => buildStateSchema.parse(s)).not.toThrow()
  })

  test("leaves the Linear issue fields unset (a fresh build has no ticket)", () => {
    const s = initState("build-flow", "br", "2026-05-28T00:00:00Z")
    expect(s.linearIssueId).toBeUndefined()
    expect(s.linearIssueUuid).toBeUndefined()
  })

  test("seeds linearIssueId when given a ticket ref (/build PRO-123)", () => {
    const s = initState("build-flow", "br", "2026-05-28T00:00:00Z", "PRO-123")
    expect(s.linearIssueId).toBe("PRO-123")
    expect(s.linearIssueUuid).toBeUndefined()
    expect(() => buildStateSchema.parse(s)).not.toThrow()
  })

  test("seeds BOTH linearIssueId and linearIssueUuid when given", () => {
    const s = initState(
      "build-flow",
      "br",
      "2026-05-28T00:00:00Z",
      "PRO-123",
      "uuid-abc",
    )
    expect(s.linearIssueId).toBe("PRO-123")
    expect(s.linearIssueUuid).toBe("uuid-abc")
    expect(() => buildStateSchema.parse(s)).not.toThrow()
  })

  test("seeds the analytics lifecycle counters at build start", () => {
    const s = initState("build-flow", "br", "2026-05-28T00:00:00Z")
    expect(s.analytics?.startedAt).toBe("2026-05-28T00:00:00Z")
    expect(s.analytics?.planRevisions).toBe(0)
    expect(s.analytics?.humanIntervention).toBe(false)
    expect(s.analytics?.completedEmitted).toBe(false)
  })

  test("seeds sentinelRetries at 0", () => {
    const s = initState("build-flow", "br", "2026-05-28T00:00:00Z")
    expect(s.analytics?.sentinelRetries).toBe(0)
  })
})

describe("analytics state", () => {
  test("old state without analytics still parses", () => {
    const old = {
      feature: "feat",
      phase: "build",
      status: "running",
      reviewRound: 0,
      branch: "br",
      harnessMap: defaultHarnessMap(),
      updatedAt: "2026-05-28T00:00:00Z",
    }
    expect(() => buildStateSchema.parse(old)).not.toThrow()
    expect(buildStateSchema.parse(old).analytics).toBeUndefined()
  })

  test("bumpAnalytics increments and defaults a missing block", () => {
    const s = initState("feat", "br", "2026-05-28T00:00:00Z")
    const bumped = bumpAnalytics(s, {
      planRevisions: (s.analytics?.planRevisions ?? 0) + 1,
    })
    expect(bumped.analytics?.planRevisions).toBe(1)
    // Original is unchanged (pure).
    expect(s.analytics?.planRevisions).toBe(0)
  })

  test("bumpAnalytics increments sentinelRetries", () => {
    const s = initState("feat", "br", "2026-05-28T00:00:00Z")
    const bumped = bumpAnalytics(s, {
      sentinelRetries: (s.analytics?.sentinelRetries ?? 0) + 1,
    })
    expect(bumped.analytics?.sentinelRetries).toBe(1)
    expect(s.analytics?.sentinelRetries).toBe(0)
  })

  test("an old state.json without sentinelRetries parses with the default 0", () => {
    const old = buildStateSchema.parse({
      feature: "feat",
      phase: "build",
      status: "running",
      reviewRound: 0,
      branch: "br",
      harnessMap: defaultHarnessMap(),
      analytics: {
        startedAt: "2026-05-28T00:00:00Z",
        planRevisions: 0,
        validateReentries: 0,
        revalidateAttempts: 0,
        monitorPasses: 0,
        humanIntervention: false,
        completedEmitted: false,
      },
      updatedAt: "2026-05-28T00:00:00Z",
    })
    expect(old.analytics?.sentinelRetries).toBe(0)
  })

  test("bumpAnalytics on a state predating the field defaults the block", () => {
    const old = buildStateSchema.parse({
      feature: "feat",
      phase: "build",
      status: "running",
      reviewRound: 0,
      branch: "br",
      harnessMap: defaultHarnessMap(),
      updatedAt: "2026-05-28T00:00:00Z",
    })
    const bumped = bumpAnalytics(old, { humanIntervention: true })
    expect(bumped.analytics?.humanIntervention).toBe(true)
    expect(bumped.analytics?.startedAt).toBe("2026-05-28T00:00:00Z")
    expect(() => buildStateSchema.parse(bumped)).not.toThrow()
  })
})

describe("optional-step schemas (evals)", () => {
  test("optionalStepsSchema accepts an evals decision", () => {
    expect(
      optionalStepsSchema.parse({
        e2e: { needed: false, rationale: "x" },
        evals: { needed: true, rationale: "changed a system prompt" },
      }),
    ).toEqual({
      e2e: { needed: false, rationale: "x" },
      evals: { needed: true, rationale: "changed a system prompt" },
    })
  })

  test("a state with optionalSteps.evals + overrides.evals + analytics.evalsNeeded round-trips", () => {
    const parsed = buildStateSchema.parse({
      feature: "feat",
      phase: "validate",
      status: "running",
      reviewRound: 0,
      branch: "br",
      harnessMap: defaultHarnessMap(),
      optionalSteps: { evals: { needed: true, rationale: "y" } },
      optionalStepOverrides: { evals: "off" },
      analytics: {
        startedAt: "2026-07-08T00:00:00Z",
        planRevisions: 0,
        validateReentries: 0,
        revalidateAttempts: 0,
        monitorPasses: 0,
        evalsNeeded: true,
        evalsPassed: false,
        humanIntervention: false,
        completedEmitted: false,
      },
      updatedAt: "2026-07-08T00:00:00Z",
    })
    expect(parsed.optionalSteps?.evals?.needed).toBe(true)
    expect(parsed.optionalStepOverrides?.evals).toBe("off")
    expect(parsed.analytics?.evalsNeeded).toBe(true)
    expect(parsed.analytics?.evalsPassed).toBe(false)
  })

  test("an unknown optional-step id is still rejected (strictObject)", () => {
    expect(() =>
      optionalStepsSchema.parse({ bogus: { needed: true, rationale: "x" } }),
    ).toThrow()
  })
})

describe("Linear issue fields", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "build-flow-linear-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test("linearIssueId/linearIssueUuid round-trip through write/read", () => {
    const s = {
      ...initState("feat", "br", "2026-05-28T00:00:00Z"),
      linearIssueId: "PRO-123",
      linearIssueUuid: "uuid-abc",
    }
    writeState(repo, s, "2026-05-28T01:00:00Z")
    const read = readState(repo, "feat")
    expect(read?.linearIssueId).toBe("PRO-123")
    expect(read?.linearIssueUuid).toBe("uuid-abc")
  })

  test("an existing state.json without the keys still parses (optional)", () => {
    const s = initState("feat", "br", "2026-05-28T00:00:00Z")
    writeState(repo, s, "2026-05-28T00:00:00Z")
    // simulate a pre-existing file that never had the new keys
    const raw = JSON.parse(
      readFileSync(statePath(repo, "feat"), "utf-8"),
    ) as Record<string, unknown>
    expect("linearIssueId" in raw).toBe(false)
    expect(readState(repo, "feat")?.feature).toBe("feat")
  })

  test("linearTitle/linearSummary/linearUrl round-trip through write/read", () => {
    const s = {
      ...initState("feat", "br", "2026-05-28T00:00:00Z"),
      linearTitle: "Redesign the build dashboard header",
      linearSummary: "Reorient the header around a human title + summary.",
      linearUrl: "https://linear.app/dispatch/issue/PRO-507",
    }
    writeState(repo, s, "2026-05-28T01:00:00Z")
    const read = readState(repo, "feat")
    expect(read?.linearTitle).toBe("Redesign the build dashboard header")
    expect(read?.linearSummary).toBe(
      "Reorient the header around a human title + summary.",
    )
    expect(read?.linearUrl).toBe("https://linear.app/dispatch/issue/PRO-507")
  })

  test("a state.json without the title/summary/url keys still parses (optional)", () => {
    const s = initState("feat", "br", "2026-05-28T00:00:00Z")
    writeState(repo, s, "2026-05-28T00:00:00Z")
    const read = readState(repo, "feat")
    expect(read?.linearTitle).toBeUndefined()
    expect(read?.linearSummary).toBeUndefined()
    expect(read?.linearUrl).toBeUndefined()
  })
})

describe("PR identity fields", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "build-flow-pr-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test("prNumber/prUrl round-trip through write/read", () => {
    const s = {
      ...initState("feat", "br", "2026-05-28T00:00:00Z"),
      prNumber: 595,
      prUrl: "https://github.com/dispatch/dispatch/pull/595",
    }
    writeState(repo, s, "2026-05-28T01:00:00Z")
    const read = readState(repo, "feat")
    expect(read?.prNumber).toBe(595)
    expect(read?.prUrl).toBe("https://github.com/dispatch/dispatch/pull/595")
  })

  test("a state.json without prNumber/prUrl still parses (optional, back-compat)", () => {
    const s = initState("feat", "br", "2026-05-28T00:00:00Z")
    writeState(repo, s, "2026-05-28T00:00:00Z")
    const read = readState(repo, "feat")
    expect(read?.prNumber).toBeUndefined()
    expect(read?.prUrl).toBeUndefined()
  })
})

describe("devUrl persisted field", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "build-flow-devurl-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test("devUrl round-trips through write/read", () => {
    const s = {
      ...initState("feat", "br", "2026-05-28T00:00:00Z"),
      devUrl: "https://product-feat.dispatch.localhost",
    }
    writeState(repo, s, "2026-05-28T01:00:00Z")
    const read = readState(repo, "feat")
    expect(read?.devUrl).toBe("https://product-feat.dispatch.localhost")
  })

  test("a state.json without devUrl still parses (optional, back-compat)", () => {
    const s = initState("feat", "br", "2026-05-28T00:00:00Z")
    writeState(repo, s, "2026-05-28T00:00:00Z")
    const read = readState(repo, "feat")
    expect(read?.devUrl).toBeUndefined()
  })
})

describe("optional-step persisted fields", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "build-flow-optstep-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test("optionalSteps + optionalStepOverrides round-trip through write/read", () => {
    const s = {
      ...initState("feat", "br", "2026-05-28T00:00:00Z"),
      optionalSteps: {
        e2e: { needed: true, rationale: "touches a new settings page" },
      },
      optionalStepOverrides: { e2e: "off" as const },
    }
    writeState(repo, s, "2026-05-28T01:00:00Z")
    const read = readState(repo, "feat")
    expect(read?.optionalSteps?.e2e).toEqual({
      needed: true,
      rationale: "touches a new settings page",
    })
    expect(read?.optionalStepOverrides?.e2e).toBe("off")
  })

  test("a state.json without the new fields still parses, leaving both undefined", () => {
    const s = initState("feat", "br", "2026-05-28T00:00:00Z")
    writeState(repo, s, "2026-05-28T00:00:00Z")
    const read = readState(repo, "feat")
    expect(read?.optionalSteps).toBeUndefined()
    expect(read?.optionalStepOverrides).toBeUndefined()
  })
})

describe("optional-step schemas", () => {
  test("optionalStepDecisionSchema rejects an empty rationale", () => {
    expect(() =>
      optionalStepDecisionSchema.parse({ needed: true, rationale: "" }),
    ).toThrow()
    expect(() =>
      optionalStepDecisionSchema.parse({ needed: true, rationale: "x" }),
    ).not.toThrow()
  })

  test("optionalStepOverridesSchema rejects a value other than on/off", () => {
    expect(() => optionalStepOverridesSchema.parse({ e2e: "maybe" })).toThrow()
    expect(() => optionalStepOverridesSchema.parse({ e2e: "on" })).not.toThrow()
    expect(() =>
      optionalStepOverridesSchema.parse({ e2e: "off" }),
    ).not.toThrow()
  })

  test("optionalStepIdSchema rejects an unknown id", () => {
    expect(() => optionalStepIdSchema.parse("bad")).toThrow()
    expect(optionalStepIdSchema.parse("e2e")).toBe("e2e")
  })

  test("optionalStepsSchema rejects an unknown key (z.strictObject)", () => {
    expect(() =>
      optionalStepsSchema.parse({ bad: { needed: true, rationale: "x" } }),
    ).toThrow()
  })

  test("optionalStepOverridesSchema rejects an unknown key (z.strictObject)", () => {
    expect(() => optionalStepOverridesSchema.parse({ bad: "off" })).toThrow()
  })

  test("optionalStepsSchema accepts an empty {} and a sole {e2e}", () => {
    expect(optionalStepsSchema.parse({})).toEqual({})
    expect(
      optionalStepsSchema.parse({ e2e: { needed: false, rationale: "x" } }),
    ).toEqual({ e2e: { needed: false, rationale: "x" } })
  })

  test("every registered id has a schema key (type-honesty guard)", () => {
    for (const id of optionalStepIdSchema.options) {
      expect(id in optionalStepsSchema.shape).toBe(true)
    }
  })
})

describe("readState / writeState round-trip", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "build-flow-state-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test("readState returns null before any write", () => {
    expect(readState(repo, "feat")).toBeNull()
  })

  test("writeState creates the spec dir and round-trips through readState", () => {
    const s = initState("feat", "branch-x", "2026-05-28T00:00:00Z")
    writeState(repo, s, "2026-05-28T01:00:00Z")
    const read = readState(repo, "feat")
    expect(read?.feature).toBe("feat")
    expect(read?.phase).toBe("plan")
    expect(read?.updatedAt).toBe("2026-05-28T01:00:00Z")
  })

  test("writeState stamps updatedAt and pretty-prints with trailing newline", () => {
    const s = initState("feat", "branch-x", "2026-05-28T00:00:00Z")
    const stamped = writeState(repo, s, "2026-05-28T02:00:00Z")
    expect(stamped.updatedAt).toBe("2026-05-28T02:00:00Z")
    const raw = readFileSync(statePath(repo, "feat"), "utf-8")
    expect(raw.endsWith("}\n")).toBe(true)
    expect(raw).toContain('  "phase": "plan"')
  })

  test("readState rejects malformed state", () => {
    const s = initState("feat", "branch-x", "2026-05-28T00:00:00Z")
    writeState(repo, s, "2026-05-28T00:00:00Z")
    const path = statePath(repo, "feat")
    writeFileSync(path, JSON.stringify({ feature: "feat", phase: "nope" }))
    expect(() => readState(repo, "feat")).toThrow()
  })
})
