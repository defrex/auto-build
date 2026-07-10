import { describe, expect, test } from "bun:test"
import { type CleanupDeps, cleanupPhase, createCtx } from "./orchestrator"
import type { ShResult } from "./repo"
import { type BuildState, initState } from "./state"

const now = "2026-06-19T00:00:00Z"

/** A Ctx whose repoRoot is the in-scope kickoff worktree path (a gwt sibling). */
function ctxFor(repoRoot = "/code/dispatch-kickoff-pro-1-my-slug") {
  return createCtx({
    repoRoot,
    feature: "my-slug",
    buildDir: `${repoRoot}/build/my-slug`,
    baseBranch: "main",
    env: process.env,
    now: () => now,
  })
}

function stateWith(over: Partial<BuildState> = {}): BuildState {
  return {
    ...initState("my-slug", "kickoff/my-slug", now),
    phase: "cleanup",
    status: "running",
    prNumber: 595,
    ...over,
  }
}

const ok: ShResult = { code: 0, stdout: "", stderr: "" }

class ExitSentinel extends Error {}

type FakeOpts = {
  merged?: boolean
  porcelain?: string
  herdrList?: string
  removeResult?: ShResult
  forceRemoveResult?: ShResult
  closeResult?: ShResult
}

const MAIN_PATH = "/code/dispatch"
const KICKOFF_PATH = "/code/dispatch-kickoff-pro-1-my-slug"
const inScopePorcelain = `worktree ${MAIN_PATH}\nHEAD a\n\nworktree ${KICKOFF_PATH}\nHEAD b\n`
const oneWorkspace = JSON.stringify({
  result: { workspaces: [{ workspace_id: "ws_1", label: "my-slug" }] },
})

/**
 * Records every call by name (so order + presence are assertable); behavior is
 * controlled by value options rather than full function overrides, so the
 * recording stays centralized. `exit` throws a sentinel the test asserts on.
 */
function fakeDeps(opts: FakeOpts = {}): {
  deps: CleanupDeps
  calls: string[]
  closeArgs: Array<[string, string]>
  stderrLines: string[]
} {
  const calls: string[] = []
  const closeArgs: Array<[string, string]> = []
  const stderrLines: string[] = []
  const deps: CleanupDeps = {
    isPrMerged: () => {
      calls.push("isPrMerged")
      return opts.merged ?? true
    },
    worktreeListPorcelain: () => {
      calls.push("worktreeListPorcelain")
      return opts.porcelain ?? inScopePorcelain
    },
    herdrWorkspaceListRaw: () => {
      calls.push("herdrWorkspaceListRaw")
      return opts.herdrList ?? oneWorkspace
    },
    removeWorktree: () => {
      calls.push("removeWorktree")
      return opts.removeResult ?? ok
    },
    forceRemoveWorktreeDir: () => {
      calls.push("forceRemoveWorktreeDir")
      return opts.forceRemoveResult ?? ok
    },
    closeHerdrWorkspace: (cwd, id) => {
      calls.push("closeHerdrWorkspace")
      closeArgs.push([cwd, id])
      return opts.closeResult ?? ok
    },
    log: () => {},
    stderr: (s) => {
      stderrLines.push(s)
    },
    sleep: async () => {},
    exit: () => {
      calls.push("exit")
      throw new ExitSentinel()
    },
  }
  return { deps, calls, closeArgs, stderrLines }
}

describe("cleanupPhase", () => {
  test("1. prNumber == null → returns done, no teardown", async () => {
    const { deps, calls } = fakeDeps()
    const sig = await cleanupPhase(
      ctxFor(),
      stateWith({ prNumber: undefined }),
      deps,
    )
    expect(sig).toEqual({ phase: "cleanup", done: true })
    expect(calls).not.toContain("removeWorktree")
    expect(calls).not.toContain("closeHerdrWorkspace")
    expect(calls).not.toContain("exit")
  })

  test("2. isPrMerged → false → returns done, no teardown", async () => {
    const { deps, calls } = fakeDeps({ merged: false })
    const sig = await cleanupPhase(ctxFor(), stateWith(), deps)
    expect(sig).toEqual({ phase: "cleanup", done: true })
    expect(calls).not.toContain("removeWorktree")
  })

  test("3. merged but decideWorktreeRemoval skips (main checkout) → returns done", async () => {
    // repoRoot is the main checkout (first porcelain entry) → skip.
    const { deps, calls } = fakeDeps({
      porcelain: "worktree /code/dispatch\nHEAD a\n",
    })
    const sig = await cleanupPhase(ctxFor("/code/dispatch"), stateWith(), deps)
    expect(sig).toEqual({ phase: "cleanup", done: true })
    expect(calls).not.toContain("removeWorktree")
  })

  test("4. merged, in-scope worktree but herdrId == null (headless) → returns done, removeWorktree NOT called", async () => {
    const { deps, calls } = fakeDeps({
      herdrList: JSON.stringify({ result: { workspaces: [] } }),
    })
    const sig = await cleanupPhase(ctxFor(), stateWith(), deps)
    expect(sig).toEqual({ phase: "cleanup", done: true })
    expect(calls).not.toContain("removeWorktree")
    expect(calls).not.toContain("closeHerdrWorkspace")
  })

  test("5. removeWorktree fails but escalation succeeds → close + exit (no leftover stderr)", async () => {
    const { deps, calls, closeArgs, stderrLines } = fakeDeps({
      removeResult: { code: 1, stdout: "", stderr: "is dirty" },
      forceRemoveResult: ok,
    })
    await expect(cleanupPhase(ctxFor(), stateWith(), deps)).rejects.toThrow(
      ExitSentinel,
    )
    expect(calls).toContain("closeHerdrWorkspace")
    expect(calls).toContain("exit")
    expect(closeArgs).toEqual([[MAIN_PATH, "ws_1"]])
    expect(stderrLines.join("")).not.toContain("worktree not fully removed")
  })

  test("5b. removeWorktree + escalation both fail → still close + exit, stderr warns", async () => {
    const { deps, calls, stderrLines } = fakeDeps({
      removeResult: { code: 1, stdout: "", stderr: "is dirty" },
      forceRemoveResult: { code: 1, stdout: "", stderr: "boom" },
    })
    await expect(cleanupPhase(ctxFor(), stateWith(), deps)).rejects.toThrow(
      ExitSentinel,
    )
    expect(calls).toContain("closeHerdrWorkspace")
    expect(calls).toContain("exit")
    expect(stderrLines.join("")).toContain("worktree not fully removed")
    expect(stderrLines.join("")).toContain("boom")
  })

  test("6. removeWorktree ok → close called with (fromMain, herdrId), then exit reached; remove before close", async () => {
    const { deps, calls, closeArgs } = fakeDeps()
    await expect(cleanupPhase(ctxFor(), stateWith(), deps)).rejects.toThrow(
      ExitSentinel,
    )
    expect(closeArgs).toEqual([[MAIN_PATH, "ws_1"]])
    const removeIdx = calls.indexOf("removeWorktree")
    const closeIdx = calls.indexOf("closeHerdrWorkspace")
    expect(removeIdx).toBeGreaterThanOrEqual(0)
    expect(removeIdx).toBeLessThan(closeIdx)
    expect(calls).toContain("exit")
  })

  test("7. close fails after a successful remove → stderr written, exit still reached", async () => {
    const { deps, calls, stderrLines } = fakeDeps({
      closeResult: { code: 1, stdout: "", stderr: "no daemon" },
    })
    await expect(cleanupPhase(ctxFor(), stateWith(), deps)).rejects.toThrow(
      ExitSentinel,
    )
    expect(stderrLines.join("")).toContain("herdr workspace close failed")
    expect(calls).toContain("exit")
  })
})
