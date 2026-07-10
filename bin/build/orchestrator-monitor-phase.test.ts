/**
 * Integration coverage for `monitorPhase` — the orchestrator step that, on entry
 * to the `monitor` phase, detects the PR, advances the Linear ticket to In
 * Review (best-effort), and then runs the PR-poll loop. This is the in-process
 * "orchestrator integration" target the spec asks for: it drives the REAL
 * `monitorPhase` against an injected fake Linear MCP agent (`statusDeps`) and an
 * injected `runMonitor`, over a temp build dir, asserting BOTH that the status
 * mutation is issued through the fake agent AND that `build.log` records the move
 * strictly BEFORE the monitor poll loop begins.
 *
 * Every seam that would otherwise shell out to `gh`/`git` or spawn the Linear MCP
 * subprocess is injected; the status agent's `log` is the REAL `appendLog`, so
 * the build.log ordering assertions are not vacuous.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveConfig } from "../kickoff/config"
import type { InReviewDeps } from "./linear-status"
import { appendLog } from "./log"
import {
  type Ctx,
  createCtx,
  EscalateError,
  type MonitorDeps,
  monitorPhase,
} from "./orchestrator"
import { reconcileWithBase, type ShResult } from "./repo"
import { buildDir, initState, readState } from "./state"

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

function makeState() {
  return {
    ...initState("feat", "br", "t"),
    phase: "monitor" as const,
    linearIssueId: "PRO-7",
    linearIssueUuid: "uuid-7",
  }
}

describe("monitorPhase", () => {
  let tmp: string
  let ctx: Ctx

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "monitor-phase-"))
    ctx = createCtx({
      repoRoot: tmp,
      feature: "feat",
      buildDir: buildDir(tmp, "feat"),
      baseBranch: "main",
      env: process.env,
      now: () => "t",
    })
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  /**
   * Build a `MonitorDeps` whose status agent + monitor loop record an ordered
   * `events` trace and the prompts they receive. The status agent's `log` is the
   * REAL `appendLog(ctx.logPath, …)` so `build.log` content + ordering are real.
   */
  function makeMonitorDeps(overrides: Partial<MonitorDeps> = {}): {
    deps: MonitorDeps
    events: string[]
    prompts: string[]
    applyCalls: number[]
  } {
    const events: string[] = []
    const prompts: string[] = []
    // PRO-660: record applyPendingAutoMerge invocations in a SEPARATE counter
    // (not `events`) so existing `toEqual(events)` assertions stay valid; tests
    // that care about ordering push to `events` via an override.
    const applyCalls: number[] = []
    const statusDeps: InReviewDeps = {
      runStatusAgent: async ({ prompt }) => {
        events.push("status-agent")
        prompts.push(prompt)
        return { code: 0, resultRaw: '{"moved":true}' }
      },
      log: (m) => appendLog(ctx.logPath, m, ctx.now()),
    }
    const deps: MonitorDeps = {
      detectPrNumber: () => 42,
      detectPrUrl: () => "https://github.com/o/r/pull/42",
      linear: pinnedLinear,
      statusDeps,
      runMonitor: async () => {
        events.push("monitor-start")
        return { outcome: "done", reason: "PR merged", merged: true }
      },
      fetchPrState: () => "OPEN",
      applyPendingAutoMerge: (prNumber) => {
        applyCalls.push(prNumber)
      },
      reconcileWithBase: (repoRoot, baseBranch, feature) =>
        reconcileWithBase(repoRoot, baseBranch, feature),
      ...overrides,
    }
    return { deps, events, prompts, applyCalls }
  }

  function readLog(): string {
    return readFileSync(ctx.logPath, "utf-8")
  }

  test("happy progression — move issued, ordered before the monitor loop", async () => {
    const state = makeState()
    const { deps, events, prompts } = makeMonitorDeps()

    const signal = await monitorPhase(ctx, state, deps)

    // The fake agent saw exactly one prompt, carrying the target state, ticket,
    // and the forward-only-advance contract.
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain("s_review")
    expect(prompts[0]).toContain("PRO-7")
    expect(prompts[0]).toMatch(/forward-only state advance/i)

    // The core ordering invariant: the status mutation fires BEFORE the loop.
    expect(events).toEqual(["status-agent", "monitor-start"])

    // build.log records the move before the monitor outcome, in order.
    const log = readLog()
    const movedIdx = log.indexOf("advanced PRO-7 to In Review")
    const monitorIdx = log.indexOf("monitor: PR merged")
    expect(movedIdx).toBeGreaterThanOrEqual(0)
    expect(monitorIdx).toBeGreaterThanOrEqual(0)
    expect(movedIdx).toBeLessThan(monitorIdx)

    expect(signal).toEqual({ phase: "monitor", done: true, merged: true })

    // PR identity is persisted to state.json before the move.
    const persisted = readState(ctx.repoRoot, "feat")
    expect(persisted?.prNumber).toBe(42)
    expect(persisted?.prUrl).toBe("https://github.com/o/r/pull/42")
  })

  test("moved:false → already-at/past no-op logged, monitor still runs in order", async () => {
    const state = makeState()
    const { deps, events } = makeMonitorDeps({
      statusDeps: {
        runStatusAgent: async () => ({
          code: 0,
          resultRaw: '{"moved":false}',
        }),
        log: (m) => appendLog(ctx.logPath, m, ctx.now()),
      },
    })

    await monitorPhase(ctx, state, deps)

    const log = readLog()
    expect(log).toMatch(/no-op|already/i)
    const noopIdx = log.search(/no-op|already/i)
    const monitorIdx = log.indexOf("monitor: PR merged")
    expect(monitorIdx).toBeGreaterThan(noopIdx)
    expect(events).toEqual(["monitor-start"])
  })

  test("no PR found → escalate, status agent + apply NEVER called", async () => {
    const state = makeState()
    const { deps, events, prompts, applyCalls } = makeMonitorDeps({
      detectPrNumber: () => null,
    })

    // One invocation, asserted by two matchers — a single rejected promise can
    // be awaited repeatedly, so the phase never runs twice (no double mutation).
    const result = monitorPhase(ctx, state, deps)
    await expect(result).rejects.toThrow(EscalateError)
    await expect(result).rejects.toThrow(/no PR found/i)
    expect(events).toEqual([])
    expect(prompts).toEqual([])
    // PRO-660: the pending applier is never consulted on the no-PR escalation.
    expect(applyCalls).toEqual([])
  })

  test("pending intent applied when monitorPhase first sees the PR (before the loop)", async () => {
    const state = makeState()
    const { deps, events } = makeMonitorDeps({
      applyPendingAutoMerge: () => {
        events.push("apply-pending")
      },
      runMonitor: async () => {
        events.push("monitor-start")
        return { outcome: "done", reason: "PR merged", merged: true }
      },
    })

    await monitorPhase(ctx, state, deps)

    // The first apply runs deterministically in the phase body, before the loop.
    expect(events.indexOf("apply-pending")).toBeGreaterThanOrEqual(0)
    expect(events.indexOf("apply-pending")).toBeLessThan(
      events.indexOf("monitor-start"),
    )
  })

  test("pending intent retried on later monitor passes (1 body + 2 poll passes)", async () => {
    const state = makeState()
    const { deps, applyCalls } = makeMonitorDeps({
      runMonitor: async ({ poll }) => {
        await poll()
        await poll()
        return { outcome: "done", reason: "PR merged", merged: true }
      },
    })

    await monitorPhase(ctx, state, deps)

    // 1 deterministic body apply + 2 poll-pass retries, each on PR #42.
    expect(applyCalls).toEqual([42, 42, 42])
  })

  test("unpinned In-Review id → graceful skip, monitor still runs", async () => {
    const state = makeState()
    let ran = false
    const { deps, events } = makeMonitorDeps({
      linear: { ...pinnedLinear, inReviewStateId: "" },
      statusDeps: {
        runStatusAgent: async () => {
          ran = true
          return { code: 0, resultRaw: '{"moved":true}' }
        },
        log: (m) => appendLog(ctx.logPath, m, ctx.now()),
      },
    })

    const signal = await monitorPhase(ctx, state, deps)

    expect(ran).toBe(false)
    expect(events).toEqual(["monitor-start"])
    expect(readLog()).toMatch(/in-?review.*not pinned/i)
    expect(signal).toEqual({ phase: "monitor", done: true, merged: true })
  })

  test("agent non-zero exit → warning logged, monitor still runs", async () => {
    const state = makeState()
    const { deps, events } = makeMonitorDeps({
      statusDeps: {
        runStatusAgent: async () => ({ code: 1, resultRaw: null }),
        log: (m) => appendLog(ctx.logPath, m, ctx.now()),
      },
    })

    const signal = await monitorPhase(ctx, state, deps)

    expect(readLog()).toMatch(
      /agent exited 1|continuing without a ticket change/i,
    )
    expect(events).toEqual(["monitor-start"])
    expect(signal).toEqual({ phase: "monitor", done: true, merged: true })
  })

  test("agent throws → warning logged, no throw out of monitorPhase", async () => {
    const state = makeState()
    const { deps, events } = makeMonitorDeps({
      statusDeps: {
        runStatusAgent: async () => {
          throw new Error("MCP boom")
        },
        log: (m) => appendLog(ctx.logPath, m, ctx.now()),
      },
    })

    const signal = await monitorPhase(ctx, state, deps)

    expect(readLog()).toMatch(/in-?review.*fail/i)
    expect(events).toEqual(["monitor-start"])
    expect(signal).toEqual({ phase: "monitor", done: true, merged: true })
  })

  test("monitor gave-up → escalate, but the move still ran first", async () => {
    const state = makeState()
    const { deps, events } = makeMonitorDeps({
      runMonitor: async () => {
        events.push("monitor-start")
        return { outcome: "gave-up", reason: "publish failed 11 times" }
      },
    })

    await expect(monitorPhase(ctx, state, deps)).rejects.toThrow(EscalateError)
    expect(events).toContain("status-agent")
    expect(events).toContain("monitor-start")
  })

  test("reconcile action merges origin/base with --no-edit and pushes plainly (no force)", async () => {
    const state = makeState()
    // Capturing exec scripted for a clean-tree reconcile:
    // add → diff(clean, code 0) → fetch → merge → push.
    const calls: string[][] = []
    const results: ShResult[] = [
      { code: 0, stdout: "", stderr: "" }, // git add
      { code: 0, stdout: "", stderr: "" }, // git diff --cached --quiet (clean)
      { code: 0, stdout: "", stderr: "" }, // git fetch origin main
      { code: 0, stdout: "", stderr: "" }, // git merge origin/main --no-edit
      { code: 0, stdout: "", stderr: "" }, // git push
    ]
    let i = 0
    const capturingExec = (cmd: string[]): ShResult => {
      calls.push(cmd)
      return results[i++] ?? { code: 0, stdout: "", stderr: "" }
    }
    const { deps } = makeMonitorDeps({
      reconcileWithBase: (repoRoot, baseBranch, feature) =>
        reconcileWithBase(repoRoot, baseBranch, feature, capturingExec),
      runMonitor: async ({ act }) => {
        await act?.({ kind: "rebase" })
        return { outcome: "done", reason: "PR merged", merged: true }
      },
    })

    await monitorPhase(ctx, state, deps)

    const fetchIdx = calls.findIndex(
      (c) => c.join(" ") === "git fetch origin main",
    )
    const mergeIdx = calls.findIndex(
      (c) => c.join(" ") === "git merge origin/main --no-edit",
    )
    expect(fetchIdx).toBeGreaterThanOrEqual(0)
    expect(mergeIdx).toBeGreaterThan(fetchIdx)
    expect(calls.at(-1)).toEqual(["git", "push"])
    expect(calls.some((c) => c.includes("--force-with-lease"))).toBe(false)
    expect(calls.some((c) => c[1] === "rebase")).toBe(false)
  })

  // The monitor merge race (PRO-588): a squash merge mid-flight makes the branch
  // read behind/diverged forever, so the act handler chooses `rebase`, which
  // conflicts. `tmp` is not a git repo, so the REAL `reconcileWithBase` fails at
  // its pre-reconcile artifact commit — exactly the failure the recovery must
  // survive. The injected `fetchPrState` stands in for the post-failure re-read.
  test("rebase conflict but PR now MERGED → recover, no throw, exits done", async () => {
    const state = makeState()
    let prStateCalls = 0
    const { deps } = makeMonitorDeps({
      fetchPrState: () => {
        prStateCalls++
        return "MERGED"
      },
      runMonitor: async ({ act }) => {
        await act?.({ kind: "rebase" })
        return { outcome: "done", reason: "PR merged", merged: true }
      },
    })

    const signal = await monitorPhase(ctx, state, deps)

    expect(signal).toEqual({ phase: "monitor", done: true, merged: true })
    expect(readLog()).toMatch(/MERGED — recovering \(no human needed\)/)
    // The re-read is consulted exactly once — only on the rebase failure.
    expect(prStateCalls).toBe(1)
  })

  test("rebase conflict but PR now CLOSED → recover, no throw", async () => {
    const state = makeState()
    const { deps } = makeMonitorDeps({
      fetchPrState: () => "CLOSED",
      runMonitor: async ({ act }) => {
        await act?.({ kind: "rebase" })
        return { outcome: "done", reason: "PR closed", merged: false }
      },
    })

    const signal = await monitorPhase(ctx, state, deps)

    expect(signal).toEqual({ phase: "monitor", done: true, merged: false })
    expect(readLog()).toMatch(/CLOSED — recovering \(no human needed\)/)
  })

  test("rebase conflict and PR still OPEN → escalate as a conflict", async () => {
    const state = makeState()
    let prStateCalls = 0
    const { deps } = makeMonitorDeps({
      fetchPrState: () => {
        prStateCalls++
        return "OPEN"
      },
      runMonitor: async ({ act }) => {
        await act?.({ kind: "rebase" })
        return { outcome: "done", reason: "unreachable", merged: false }
      },
    })

    const result = monitorPhase(ctx, state, deps)
    await expect(result).rejects.toThrow(EscalateError)
    await expect(result).rejects.toThrow(/rebase step failed/i)
    expect(prStateCalls).toBeGreaterThan(0)
  })
})
