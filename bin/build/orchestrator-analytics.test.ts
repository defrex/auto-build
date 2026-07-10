/**
 * Focused analytics coverage for the build orchestrator: the build_completed
 * rollup (emit-once, outcome semantics, time-to-merge anchoring), the identity
 * seed, and monitorPhase's analytics emissions. Full-loop `run()` coverage is
 * out of reach without mocking the harness subprocess; these target the seams
 * the spec cares about.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AnalyticsSink,
  type CaptureArgs,
  createPipelineAnalytics,
} from "../analytics/pipeline-analytics"
import { resolveConfig } from "../kickoff/config"
import type { InReviewDeps } from "./linear-status"
import {
  type Ctx,
  createCtx,
  decideStartup,
  emitBuildCompleted,
  type MonitorDeps,
  monitorPhase,
} from "./orchestrator"
import { reconcileWithBase } from "./repo"
import { type BuildState, buildDir, initState } from "./state"

function recording(common: Partial<CaptureArgs["properties"]> = {}) {
  const events: CaptureArgs[] = []
  const sink: AnalyticsSink = {
    capture: (a) => events.push(a),
    shutdown: async () => {},
  }
  const analytics = createPipelineAnalytics({
    common: {
      process: "build",
      issue_id: "PRO-1",
      issue_uuid: "uuid-1",
      branch: "br",
      slug: "feat",
      worktree_provider: "git",
      run_env: "local",
      tooling_sha: "sha",
      ...common,
    },
    distinctId: "op@x.com",
    sink,
  })
  return { analytics, events }
}

const find = (events: CaptureArgs[], event: string) =>
  events.find((e) => e.event === event)

function stateWithAnalytics(
  patch: Partial<BuildState["analytics"]>,
): BuildState {
  const s = initState("feat", "br", "2026-06-01T00:00:00Z")
  return {
    ...s,
    reviewRound: 2,
    analytics: { ...s.analytics, ...patch } as BuildState["analytics"],
  }
}

describe("decideStartup identity seed", () => {
  test("seeds BOTH linearIssueId and linearIssueUuid on fresh start", () => {
    const decision = decideStartup(
      { specExists: true, state: null, needsInputExists: false },
      "feat",
      "br",
      "t",
      "PRO-9",
      "uuid-9",
    )
    expect(decision.kind).toBe("start")
    if (decision.kind === "start") {
      expect(decision.state.linearIssueId).toBe("PRO-9")
      expect(decision.state.linearIssueUuid).toBe("uuid-9")
    }
  })
})

describe("emitBuildCompleted", () => {
  let tmp: string
  let ctx: Ctx
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "build-completed-"))
    ctx = createCtx({
      repoRoot: tmp,
      feature: "feat",
      buildDir: buildDir(tmp, "feat"),
      baseBranch: "main",
      env: process.env,
      now: () => "2026-06-01T01:00:00Z", // 1h after startedAt
    })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  test("merged: time_to_merge_ms anchors on startedAt, not prOpenedAt", () => {
    const { analytics, events } = recording()
    ctx.analytics = analytics
    const state = stateWithAnalytics({
      startedAt: "2026-06-01T00:00:00Z",
      prOpenedAt: "2026-06-01T00:50:00Z", // 10 min before merge
    })
    const next = emitBuildCompleted(ctx, state, "merged")
    const e = find(events, "build_completed")
    expect(e?.properties.outcome).toBe("merged")
    // Full build-start→merge span = 1h.
    expect(e?.properties.time_to_merge_ms).toBe(3_600_000)
    expect(e?.properties.total_duration_ms).toBe(3_600_000)
    // Narrower PR-open→merge tail = 10 min.
    expect(e?.properties.pr_open_to_merge_ms).toBe(600_000)
    expect(e?.properties.review_rounds).toBe(2)
    expect(next.analytics?.completedEmitted).toBe(true)
  })

  test("merged with no prOpenedAt: time_to_merge non-null, pr_open_to_merge null", () => {
    const { analytics, events } = recording()
    ctx.analytics = analytics
    const state = stateWithAnalytics({ startedAt: "2026-06-01T00:00:00Z" })
    emitBuildCompleted(ctx, state, "merged")
    const e = find(events, "build_completed")
    expect(e?.properties.time_to_merge_ms).toBe(3_600_000)
    expect(e?.properties.pr_open_to_merge_ms).toBeNull()
  })

  test("closed-unmerged: both merge intervals null", () => {
    const { analytics, events } = recording()
    ctx.analytics = analytics
    const state = stateWithAnalytics({
      startedAt: "2026-06-01T00:00:00Z",
      prOpenedAt: "2026-06-01T00:50:00Z",
    })
    emitBuildCompleted(ctx, state, "closed-unmerged")
    const e = find(events, "build_completed")
    expect(e?.properties.outcome).toBe("closed-unmerged")
    expect(e?.properties.time_to_merge_ms).toBeNull()
    expect(e?.properties.pr_open_to_merge_ms).toBeNull()
  })

  test("blocked: human_intervention surfaced, intervals null", () => {
    const { analytics, events } = recording()
    ctx.analytics = analytics
    const state = stateWithAnalytics({
      startedAt: "2026-06-01T00:00:00Z",
      humanIntervention: true,
    })
    emitBuildCompleted(ctx, state, "blocked")
    const e = find(events, "build_completed")
    expect(e?.properties.outcome).toBe("blocked")
    expect(e?.properties.time_to_merge_ms).toBeNull()
    expect(e?.properties.human_intervention).toBe(true)
  })

  test("emit-once: a second call (e.g. resume) does NOT re-emit", () => {
    const { analytics, events } = recording()
    ctx.analytics = analytics
    const state = stateWithAnalytics({ startedAt: "2026-06-01T00:00:00Z" })
    const next = emitBuildCompleted(ctx, state, "merged")
    const again = emitBuildCompleted(ctx, next, "merged")
    expect(events.filter((e) => e.event === "build_completed")).toHaveLength(1)
    expect(again).toBe(next) // unchanged
  })

  test("surfaces sentinel_retries from the analytics counter (PRO-639)", () => {
    const { analytics, events } = recording()
    ctx.analytics = analytics
    const state = stateWithAnalytics({
      startedAt: "2026-06-01T00:00:00Z",
      sentinelRetries: 2,
    })
    emitBuildCompleted(ctx, state, "merged")
    const e = find(events, "build_completed")
    expect(e?.properties.sentinel_retries).toBe(2)
  })

  test("sentinel_retries defaults to 0 when absent", () => {
    const { analytics, events } = recording()
    ctx.analytics = analytics
    emitBuildCompleted(
      ctx,
      stateWithAnalytics({ startedAt: "2026-06-01T00:00:00Z" }),
      "merged",
    )
    const e = find(events, "build_completed")
    expect(e?.properties.sentinel_retries).toBe(0)
  })

  test("carries tooling_sha + worktree_provider (common props merged)", () => {
    const { analytics, events } = recording()
    ctx.analytics = analytics
    emitBuildCompleted(
      ctx,
      stateWithAnalytics({ startedAt: "2026-06-01T00:00:00Z" }),
      "merged",
    )
    const e = find(events, "build_completed")
    expect("tooling_sha" in (e?.properties ?? {})).toBe(true)
    expect("worktree_provider" in (e?.properties ?? {})).toBe(true)
  })
})

const pinnedLinear = resolveConfig({
  linear: {
    teamId: "team_1",
    projectId: "",
    triageStateId: "s_t",
    readyStateId: "s_r",
    inProgressStateId: "s_progress",
    inReviewStateId: "s_review",
    doneStateId: "s_d",
    rejectedStateIds: [],
    sourceObservationsLabelId: "l_o",
    sourceSentryLabelId: "l_s",
    needsDefinitionLabelId: "l_nd",
  },
}).linear

describe("monitorPhase analytics", () => {
  let tmp: string
  let ctx: Ctx
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "monitor-analytics-"))
    ctx = createCtx({
      repoRoot: tmp,
      feature: "feat",
      buildDir: buildDir(tmp, "feat"),
      baseBranch: "main",
      env: process.env,
      now: () => "2026-06-01T00:30:00Z",
    })
  })
  afterEach(() => rmSync(tmp, { recursive: true, force: true }))

  function makeDeps(overrides: Partial<MonitorDeps> = {}): MonitorDeps {
    const statusDeps: InReviewDeps = {
      runStatusAgent: async () => ({ code: 0, resultRaw: '{"moved":true}' }),
      log: () => {},
    }
    return {
      detectPrNumber: () => 42,
      detectPrUrl: () => "https://github.com/o/r/pull/42",
      linear: pinnedLinear,
      statusDeps,
      runMonitor: async ({ poll }) => {
        await poll()
        await poll()
        return { outcome: "done", reason: "PR merged", merged: true }
      },
      fetchPrState: () => "OPEN",
      applyPendingAutoMerge: () => {},
      reconcileWithBase: (repoRoot, baseBranch, feature) =>
        reconcileWithBase(repoRoot, baseBranch, feature),
      ...overrides,
    }
  }

  test("emits build_pr_opened once with duration_since_start_ms + stamps prOpenedAt", async () => {
    const { analytics, events } = recording()
    ctx.analytics = analytics
    const state = {
      ...initState("feat", "br", "2026-06-01T00:00:00Z"),
      phase: "monitor" as const,
      linearIssueId: "PRO-7",
    }
    await monitorPhase(ctx, state, makeDeps())
    const opened = find(events, "build_pr_opened")
    expect(opened?.properties.pr_number).toBe(42)
    expect(opened?.properties.duration_since_start_ms).toBe(1_800_000) // 30 min
    expect(state.analytics?.prOpenedAt).toBe("2026-06-01T00:30:00Z")
    // poll ran twice → monitorPasses folded into state.
    expect(state.analytics?.monitorPasses).toBe(2)
  })

  test("emits build_monitor_action on a reconcile action (success)", async () => {
    const { analytics, events } = recording()
    ctx.analytics = analytics
    const state = {
      ...initState("feat", "br", "2026-06-01T00:00:00Z"),
      phase: "monitor" as const,
      linearIssueId: "PRO-7",
    }
    await monitorPhase(
      ctx,
      state,
      makeDeps({
        runMonitor: async ({ publishArtifacts }) => {
          // Drive the publish callback to exercise build_monitor_action:publish.
          publishArtifacts?.()
          return { outcome: "done", reason: "PR closed", merged: false }
        },
      }),
    )
    const publish = events.find(
      (e) =>
        e.event === "build_monitor_action" && e.properties.action === "publish",
    )
    expect(publish).toBeDefined()
    expect(typeof publish?.properties.success).toBe("boolean")
  })

  test("emits build_monitor_action(rebase, success:false) before escalating on a failed reconcile", async () => {
    const { analytics, events } = recording()
    ctx.analytics = analytics
    const state = {
      ...initState("feat", "br", "2026-06-01T00:00:00Z"),
      phase: "monitor" as const,
      linearIssueId: "PRO-7",
    }
    // `tmp` is not a git repo, so reconcileWithBase's pre-reconcile artifact
    // commit fails (non-zero) → the failure path captures success:false then throws an
    // EscalateError, which propagates out of monitorPhase. The fix-ci and
    // address-review failure paths are structurally identical but route through
    // invokeBuilder (a real harness subprocess), out of reach for this harness.
    await expect(
      monitorPhase(
        ctx,
        state,
        makeDeps({
          runMonitor: async ({ act }) => {
            await act?.({ kind: "rebase" })
            return { outcome: "done", reason: "unreachable", merged: false }
          },
        }),
      ),
    ).rejects.toThrow()
    const rebase = events.find(
      (e) =>
        e.event === "build_monitor_action" && e.properties.action === "rebase",
    )
    expect(rebase).toBeDefined()
    expect(rebase?.properties.success).toBe(false)
  })
})
