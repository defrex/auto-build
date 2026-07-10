import { describe, expect, test } from "bun:test"
import type { ShResult } from "../build/repo"
import {
  type CleanupModeDeps,
  decideCleanupSafety,
  parseWorktreeEntries,
  resolveCleanupTarget,
  runCleanup,
} from "./cleanup-mode"

const MAIN = "/code/dispatch"
// gwt names worktrees `<project>-<safe-branch>`, a sibling of the main checkout.
const KICKOFF = "/code/dispatch-kickoff-pro-1-my-slug"

const ok: ShResult = { code: 0, stdout: "", stderr: "" }
const fail: ShResult = { code: 1, stdout: "", stderr: "" }

describe("parseWorktreeEntries", () => {
  test("captures the branch line (short name) per entry", () => {
    const porcelain = [
      `worktree ${MAIN}`,
      "HEAD abc",
      "branch refs/heads/main",
      "",
      `worktree ${KICKOFF}`,
      "HEAD def",
      "branch refs/heads/kickoff/pro-1-my-slug",
      "",
    ].join("\n")
    expect(parseWorktreeEntries(porcelain)).toEqual([
      { path: MAIN, branch: "main" },
      { path: KICKOFF, branch: "kickoff/pro-1-my-slug" },
    ])
  })

  test("detached / no branch → null", () => {
    const porcelain = [
      `worktree ${MAIN}`,
      "HEAD abc",
      "branch refs/heads/main",
      "",
      `worktree ${KICKOFF}`,
      "HEAD def",
      "detached",
      "",
    ].join("\n")
    expect(parseWorktreeEntries(porcelain)).toEqual([
      { path: MAIN, branch: "main" },
      { path: KICKOFF, branch: null },
    ])
  })

  test("garbage → []", () => {
    expect(parseWorktreeEntries("nonsense\n")).toEqual([])
  })
})

describe("resolveCleanupTarget", () => {
  const entries = [
    { path: MAIN, branch: "main" },
    { path: KICKOFF, branch: "kickoff/pro-1-my-slug" },
  ]

  test("slug + branch together → error", () => {
    const r = resolveCleanupTarget({
      entries,
      mainPath: MAIN,
      currentPath: MAIN,
      slug: "my-slug",
      branch: "kickoff/pro-1-my-slug",
    })
    expect(r.kind).toBe("error")
  })

  test("branch hit → target", () => {
    const r = resolveCleanupTarget({
      entries,
      mainPath: MAIN,
      currentPath: MAIN,
      slug: null,
      branch: "kickoff/pro-1-my-slug",
    })
    expect(r).toEqual({ kind: "target", path: KICKOFF, slug: "my-slug" })
  })

  test("branch miss → no-target", () => {
    const r = resolveCleanupTarget({
      entries,
      mainPath: MAIN,
      currentPath: MAIN,
      slug: null,
      branch: "kickoff/nope",
    })
    expect(r.kind).toBe("no-target")
  })

  test("slug hit → target", () => {
    const r = resolveCleanupTarget({
      entries,
      mainPath: MAIN,
      currentPath: MAIN,
      slug: "my-slug",
      branch: null,
    })
    expect(r).toEqual({ kind: "target", path: KICKOFF, slug: "my-slug" })
  })

  test("slug miss → no-target", () => {
    const r = resolveCleanupTarget({
      entries,
      mainPath: MAIN,
      currentPath: MAIN,
      slug: "other",
      branch: null,
    })
    expect(r.kind).toBe("no-target")
  })

  test("no flags, current is the worktree → target (slug from branch)", () => {
    const r = resolveCleanupTarget({
      entries,
      mainPath: MAIN,
      currentPath: KICKOFF,
      slug: null,
      branch: null,
    })
    expect(r).toEqual({ kind: "target", path: KICKOFF, slug: "my-slug" })
  })

  test("no flags, current worktree on a detached/non-scheme branch → slug = basename", () => {
    const stray = "/code/dispatch-feature-x"
    const r = resolveCleanupTarget({
      entries: [
        { path: MAIN, branch: "main" },
        { path: stray, branch: null },
      ],
      mainPath: MAIN,
      currentPath: stray,
      slug: null,
      branch: null,
    })
    expect(r).toEqual({
      kind: "target",
      path: stray,
      slug: "dispatch-feature-x",
    })
  })

  test("no flags, current is main → no-target", () => {
    const r = resolveCleanupTarget({
      entries,
      mainPath: MAIN,
      currentPath: MAIN,
      slug: null,
      branch: null,
    })
    expect(r.kind).toBe("no-target")
  })
})

describe("decideCleanupSafety", () => {
  const base = {
    statusPorcelain: "",
    aheadOfOrigin: false,
    hasUpstream: true,
    force: false,
    merged: false,
  }

  test("clean tree, in sync → ok", () => {
    expect(decideCleanupSafety(base).ok).toBe(true)
  })

  test("force bypasses everything", () => {
    expect(
      decideCleanupSafety({
        ...base,
        statusPorcelain: " M file",
        aheadOfOrigin: true,
        hasUpstream: false,
        force: true,
      }).ok,
    ).toBe(true)
  })

  test("uncommitted → refuse even under --merged", () => {
    const r = decideCleanupSafety({
      ...base,
      statusPorcelain: " M file",
      merged: true,
    })
    expect(r.ok).toBe(false)
  })

  test("unpushed (ahead) → refuse without --merged", () => {
    expect(decideCleanupSafety({ ...base, aheadOfOrigin: true }).ok).toBe(false)
  })

  test("unpushed (no upstream) → refuse without --merged", () => {
    expect(decideCleanupSafety({ ...base, hasUpstream: false }).ok).toBe(false)
  })

  test("unpushed cleared by --merged", () => {
    expect(
      decideCleanupSafety({
        ...base,
        aheadOfOrigin: true,
        hasUpstream: false,
        merged: true,
      }).ok,
    ).toBe(true)
  })
})

// --- runCleanup orchestration -------------------------------------------------

type FakeOpts = {
  porcelain?: string
  status?: string
  upstream?: ShResult
  ahead?: ShResult
  teardownResult?: import("../build/cleanup").TeardownOutcome
}

function fakeDeps(opts: FakeOpts = {}): {
  deps: CleanupModeDeps
  logs: string[]
  teardownCalls: Array<{ targetPath: string; slug: string }>
} {
  const logs: string[] = []
  const teardownCalls: Array<{ targetPath: string; slug: string }> = []
  const porcelain =
    opts.porcelain ??
    [
      `worktree ${MAIN}`,
      "HEAD a",
      "branch refs/heads/main",
      "",
      `worktree ${KICKOFF}`,
      "HEAD b",
      "branch refs/heads/kickoff/pro-1-my-slug",
      "",
    ].join("\n")
  const deps: CleanupModeDeps = {
    worktreeListPorcelain: () => porcelain,
    statusPorcelain: () => opts.status ?? "",
    upstreamRef: () => opts.upstream ?? ok,
    aheadCount: () => opts.ahead ?? { code: 0, stdout: "0", stderr: "" },
    teardown: async (a) => {
      teardownCalls.push({ targetPath: a.targetPath, slug: a.slug })
      return (
        opts.teardownResult ?? {
          kind: "torn-down",
          worktreeRemoveError: null,
          workspaceCloseFailed: null,
        }
      )
    },
    log: (m) => logs.push(m),
  }
  return { deps, logs, teardownCalls }
}

describe("runCleanup", () => {
  test("no-target (main checkout, no flags) → 0, no teardown", async () => {
    const { deps, teardownCalls } = fakeDeps()
    const code = await runCleanup(
      MAIN,
      { slug: null, branch: null, force: false, merged: false },
      deps,
    )
    expect(code).toBe(0)
    expect(teardownCalls).toEqual([])
  })

  test("conflict (slug + branch) → 1", async () => {
    const { deps } = fakeDeps()
    const code = await runCleanup(
      KICKOFF,
      {
        slug: "my-slug",
        branch: "kickoff/pro-1-my-slug",
        force: false,
        merged: false,
      },
      deps,
    )
    expect(code).toBe(1)
  })

  test("guard refusal (dirty tree) → 1, no teardown", async () => {
    const { deps, teardownCalls } = fakeDeps({ status: " M file" })
    const code = await runCleanup(
      KICKOFF,
      { slug: null, branch: null, force: false, merged: false },
      deps,
    )
    expect(code).toBe(1)
    expect(teardownCalls).toEqual([])
  })

  test("happy teardown → 0, teardown called with the resolved target", async () => {
    const { deps, teardownCalls } = fakeDeps()
    const code = await runCleanup(
      KICKOFF,
      { slug: null, branch: null, force: false, merged: false },
      deps,
    )
    expect(code).toBe(0)
    expect(teardownCalls).toEqual([{ targetPath: KICKOFF, slug: "my-slug" }])
  })

  test("teardown leftover files (remove not fully cleaned) → 0, tolerated", async () => {
    const { deps } = fakeDeps({
      teardownResult: {
        kind: "torn-down",
        worktreeRemoveError: "boom",
        workspaceCloseFailed: null,
      },
    })
    const code = await runCleanup(
      KICKOFF,
      { slug: null, branch: null, force: false, merged: false },
      deps,
    )
    expect(code).toBe(0)
  })

  test("teardown close-failed → 1", async () => {
    const { deps } = fakeDeps({
      teardownResult: {
        kind: "torn-down",
        worktreeRemoveError: null,
        workspaceCloseFailed: "no daemon",
      },
    })
    const code = await runCleanup(
      KICKOFF,
      { slug: null, branch: null, force: false, merged: false },
      deps,
    )
    expect(code).toBe(1)
  })

  test("teardown noop → 0", async () => {
    const { deps } = fakeDeps({
      teardownResult: { kind: "noop", reason: "x" },
    })
    const code = await runCleanup(
      KICKOFF,
      { slug: null, branch: null, force: false, merged: false },
      deps,
    )
    expect(code).toBe(0)
  })

  test("branch-target happy teardown → 0", async () => {
    const { deps, teardownCalls } = fakeDeps()
    const code = await runCleanup(
      MAIN,
      {
        slug: null,
        branch: "kickoff/pro-1-my-slug",
        force: false,
        merged: false,
      },
      deps,
    )
    expect(code).toBe(0)
    expect(teardownCalls).toEqual([{ targetPath: KICKOFF, slug: "my-slug" }])
  })

  test("dirty tree cleared by --force → teardown runs", async () => {
    const { deps, teardownCalls } = fakeDeps({ status: " M file" })
    const code = await runCleanup(
      KICKOFF,
      { slug: null, branch: null, force: true, merged: false },
      deps,
    )
    expect(code).toBe(0)
    expect(teardownCalls.length).toBe(1)
  })

  test("upstream lookup failure → hasUpstream=false → refused without --merged", async () => {
    const { deps } = fakeDeps({ upstream: fail })
    const code = await runCleanup(
      KICKOFF,
      { slug: null, branch: null, force: false, merged: false },
      deps,
    )
    expect(code).toBe(1)
  })
})
