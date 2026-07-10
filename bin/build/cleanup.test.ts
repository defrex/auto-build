import { describe, expect, test } from "bun:test"
import {
  decideWorktreeRemoval,
  HERDR_LABEL_MAX,
  matchHerdrWorkspaceId,
  parseHerdrWorkspaceList,
  parseWorktreeList,
  type TeardownIO,
  teardownWorkspace,
  truncateHerdrLabel,
} from "./cleanup"
import type { ShResult } from "./repo"

describe("parseWorktreeList", () => {
  test("multi-entry porcelain → ordered paths (main first)", () => {
    const porcelain = [
      "worktree /repo/main",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repo/../.kickoff-worktrees/slug",
      "HEAD def456",
      "branch refs/heads/kickoff/slug",
      "",
    ].join("\n")
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: "/repo/main" },
      { path: "/repo/../.kickoff-worktrees/slug" },
    ])
  })

  test("empty / garbage → []", () => {
    expect(parseWorktreeList("")).toEqual([])
    expect(parseWorktreeList("garbage\nno worktree lines\n")).toEqual([])
  })
})

describe("decideWorktreeRemoval", () => {
  const main = "/Users/x/code/dispatch"
  // gwt names worktrees `<project>-<safe-branch>`, a sibling of the main checkout.
  const kickoff = "/Users/x/code/dispatch-kickoff-pro-1-my-slug"
  const superset = "/Users/x/.superset/worktrees/proj/kickoff/pro-1-my-slug"
  const porcelain = (...paths: string[]) =>
    paths.map((p) => `worktree ${p}\nHEAD abc\n`).join("\n")

  test("main checkout → skip 'main checkout'", () => {
    const plan = decideWorktreeRemoval(porcelain(main, kickoff), main)
    expect(plan).toEqual({ kind: "skip", reason: "main checkout" })
  })

  test("a gwt sibling linked path → remove with fromMain = first entry", () => {
    const plan = decideWorktreeRemoval(porcelain(main, kickoff), kickoff)
    expect(plan).toEqual({
      kind: "remove",
      fromMain: main,
      worktreePath: kickoff,
    })
  })

  test("a ~/.superset linked path → skip 'not a kickoff worktree'", () => {
    const plan = decideWorktreeRemoval(porcelain(main, superset), superset)
    expect(plan).toEqual({ kind: "skip", reason: "not a kickoff worktree" })
  })

  test("a sibling NOT prefixed with the project name → skip 'not a kickoff worktree'", () => {
    const stray = "/Users/x/code/unrelated-checkout"
    const plan = decideWorktreeRemoval(porcelain(main, stray), stray)
    expect(plan).toEqual({ kind: "skip", reason: "not a kickoff worktree" })
  })

  test("an unlisted path → skip 'not a linked worktree'", () => {
    const plan = decideWorktreeRemoval(
      porcelain(main, kickoff),
      "/some/other/path",
    )
    expect(plan).toEqual({ kind: "skip", reason: "not a linked worktree" })
  })
})

describe("parseHerdrWorkspaceList", () => {
  test("a real result.workspaces shape → entries", () => {
    const stdout = JSON.stringify({
      result: {
        workspaces: [
          { workspace_id: "ws_1", label: "my-slug" },
          { workspace_id: "ws_2", label: "other" },
        ],
      },
    })
    expect(parseHerdrWorkspaceList(stdout)).toEqual([
      { workspaceId: "ws_1", label: "my-slug" },
      { workspaceId: "ws_2", label: "other" },
    ])
  })

  test("non-JSON / unexpected shape → []", () => {
    expect(parseHerdrWorkspaceList("not json")).toEqual([])
    expect(parseHerdrWorkspaceList(JSON.stringify({ result: {} }))).toEqual([])
    expect(
      parseHerdrWorkspaceList(JSON.stringify({ result: { workspaces: "x" } })),
    ).toEqual([])
  })

  test("drops entries missing workspace_id or label", () => {
    const stdout = JSON.stringify({
      result: {
        workspaces: [
          { workspace_id: "ws_1" },
          { label: "no-id" },
          { workspace_id: "ws_2", label: "ok" },
        ],
      },
    })
    expect(parseHerdrWorkspaceList(stdout)).toEqual([
      { workspaceId: "ws_2", label: "ok" },
    ])
  })
})

describe("matchHerdrWorkspaceId", () => {
  test("exact match → id", () => {
    expect(
      matchHerdrWorkspaceId(
        [
          { workspaceId: "ws_1", label: "my-slug" },
          { workspaceId: "ws_2", label: "other" },
        ],
        "my-slug",
      ),
    ).toBe("ws_1")
  })

  test("slug > 50 chars matched against its 50-char truncation → id", () => {
    const slug = "a".repeat(60)
    const label = slug.slice(0, HERDR_LABEL_MAX)
    expect(label.length).toBe(HERDR_LABEL_MAX)
    expect(
      matchHerdrWorkspaceId([{ workspaceId: "ws_long", label }], slug),
    ).toBe("ws_long")
  })

  test("two workspaces sharing the same truncated label → null (ambiguous)", () => {
    const slug = "b".repeat(60)
    const label = slug.slice(0, HERDR_LABEL_MAX)
    expect(
      matchHerdrWorkspaceId(
        [
          { workspaceId: "ws_a", label },
          { workspaceId: "ws_b", label },
        ],
        slug,
      ),
    ).toBeNull()
  })

  test("no match → null", () => {
    expect(
      matchHerdrWorkspaceId(
        [{ workspaceId: "ws_1", label: "other" }],
        "my-slug",
      ),
    ).toBeNull()
  })

  test("a short label that isn't a real prefix does not falsely match", () => {
    // label is shorter than 50, not equal to slug nor its truncation → no match.
    expect(
      matchHerdrWorkspaceId([{ workspaceId: "ws_1", label: "my" }], "my-slug"),
    ).toBeNull()
  })
})

describe("truncateHerdrLabel", () => {
  test("caps at HERDR_LABEL_MAX", () => {
    expect(truncateHerdrLabel("x".repeat(100)).length).toBe(HERDR_LABEL_MAX)
    expect(truncateHerdrLabel("short")).toBe("short")
  })
})

describe("teardownWorkspace", () => {
  const MAIN = "/code/dispatch"
  const TARGET = "/code/dispatch-kickoff-pro-1-my-slug"
  const inScope = `worktree ${MAIN}\nHEAD a\n\nworktree ${TARGET}\nHEAD b\n`
  const oneWorkspace = JSON.stringify({
    result: { workspaces: [{ workspace_id: "ws_1", label: "my-slug" }] },
  })
  const ok: ShResult = { code: 0, stdout: "", stderr: "" }

  type FakeOpts = {
    porcelain?: string
    herdrList?: string
    removeResult?: ShResult
    forceRemoveResult?: ShResult
    closeResult?: ShResult
  }

  function fakeIo(opts: FakeOpts = {}): {
    io: TeardownIO
    calls: string[]
    closeArgs: Array<[string, string]>
    removeArgs: Array<[string, string]>
    forceRemoveArgs: Array<[string, string]>
  } {
    const calls: string[] = []
    const closeArgs: Array<[string, string]> = []
    const removeArgs: Array<[string, string]> = []
    const forceRemoveArgs: Array<[string, string]> = []
    const io: TeardownIO = {
      worktreeListPorcelain: () => {
        calls.push("worktreeListPorcelain")
        return opts.porcelain ?? inScope
      },
      herdrWorkspaceListRaw: () => {
        calls.push("herdrWorkspaceListRaw")
        return opts.herdrList ?? oneWorkspace
      },
      removeWorktree: (fromMain, worktreePath) => {
        calls.push("removeWorktree")
        removeArgs.push([fromMain, worktreePath])
        return opts.removeResult ?? ok
      },
      forceRemoveWorktreeDir: (fromMain, worktreePath) => {
        calls.push("forceRemoveWorktreeDir")
        forceRemoveArgs.push([fromMain, worktreePath])
        return opts.forceRemoveResult ?? ok
      },
      closeHerdrWorkspace: (cwd, id) => {
        calls.push("closeHerdrWorkspace")
        closeArgs.push([cwd, id])
        return opts.closeResult ?? ok
      },
    }
    return { io, calls, closeArgs, removeArgs, forceRemoveArgs }
  }

  test("gate skip (main checkout) → noop; remove NOT called", async () => {
    const { io, calls } = fakeIo({ porcelain: `worktree ${MAIN}\nHEAD a\n` })
    const outcome = await teardownWorkspace({
      targetPath: MAIN,
      slug: "my-slug",
      io,
    })
    expect(outcome.kind).toBe("noop")
    expect(calls).not.toContain("removeWorktree")
    expect(calls).not.toContain("forceRemoveWorktreeDir")
    expect(calls).not.toContain("closeHerdrWorkspace")
  })

  test("herdrId null (no workspace) → noop; remove NOT called", async () => {
    const { io, calls } = fakeIo({
      herdrList: JSON.stringify({ result: { workspaces: [] } }),
    })
    const outcome = await teardownWorkspace({
      targetPath: TARGET,
      slug: "my-slug",
      io,
    })
    expect(outcome.kind).toBe("noop")
    expect(calls).not.toContain("removeWorktree")
  })

  test("herdrId null (ambiguous >1 workspace) → noop; remove NOT called", async () => {
    const slug = "c".repeat(60)
    const label = slug.slice(0, HERDR_LABEL_MAX)
    const { io, calls } = fakeIo({
      porcelain: `worktree ${MAIN}\nHEAD a\n\nworktree /code/dispatch-${slug}\nHEAD b\n`,
      herdrList: JSON.stringify({
        result: {
          workspaces: [
            { workspace_id: "ws_a", label },
            { workspace_id: "ws_b", label },
          ],
        },
      }),
    })
    const outcome = await teardownWorkspace({
      targetPath: `/code/dispatch-${slug}`,
      slug,
      io,
    })
    expect(outcome.kind).toBe("noop")
    expect(calls).not.toContain("removeWorktree")
  })

  test("remove fails → escalates, then closes; outcome torn-down clean", async () => {
    const { io, calls } = fakeIo({
      removeResult: { code: 1, stdout: "", stderr: "is dirty" },
      forceRemoveResult: { code: 0, stdout: "", stderr: "" },
    })
    const outcome = await teardownWorkspace({
      targetPath: TARGET,
      slug: "my-slug",
      io,
    })
    expect(outcome).toEqual({
      kind: "torn-down",
      worktreeRemoveError: null,
      workspaceCloseFailed: null,
    })
    const removeIdx = calls.indexOf("removeWorktree")
    const forceIdx = calls.indexOf("forceRemoveWorktreeDir")
    const closeIdx = calls.indexOf("closeHerdrWorkspace")
    expect(removeIdx).toBeGreaterThanOrEqual(0)
    expect(removeIdx).toBeLessThan(forceIdx)
    expect(forceIdx).toBeLessThan(closeIdx)
  })

  test("remove + escalation both fail → torn-down with worktreeRemoveError, close still runs", async () => {
    const { io, calls } = fakeIo({
      removeResult: { code: 1, stdout: "", stderr: "is dirty" },
      forceRemoveResult: { code: 1, stdout: "", stderr: "prune failed" },
    })
    const outcome = await teardownWorkspace({
      targetPath: TARGET,
      slug: "my-slug",
      io,
    })
    expect(outcome).toEqual({
      kind: "torn-down",
      worktreeRemoveError: "prune failed",
      workspaceCloseFailed: null,
    })
    // The key regression assertion: close runs despite removal failure.
    expect(calls).toContain("closeHerdrWorkspace")
  })

  test("happy path → torn-down; escalation NOT called; remove before close; close cwd == fromMain", async () => {
    const { io, calls, closeArgs, removeArgs } = fakeIo()
    const outcome = await teardownWorkspace({
      targetPath: TARGET,
      slug: "my-slug",
      io,
    })
    expect(outcome).toEqual({
      kind: "torn-down",
      worktreeRemoveError: null,
      workspaceCloseFailed: null,
    })
    expect(calls).not.toContain("forceRemoveWorktreeDir")
    expect(removeArgs).toEqual([[MAIN, TARGET]])
    expect(closeArgs).toEqual([[MAIN, "ws_1"]])
    const removeIdx = calls.indexOf("removeWorktree")
    const closeIdx = calls.indexOf("closeHerdrWorkspace")
    expect(removeIdx).toBeGreaterThanOrEqual(0)
    expect(removeIdx).toBeLessThan(closeIdx)
  })

  test("close fails → torn-down with workspaceCloseFailed set", async () => {
    const { io } = fakeIo({
      closeResult: { code: 1, stdout: "", stderr: "no daemon" },
    })
    const outcome = await teardownWorkspace({
      targetPath: TARGET,
      slug: "my-slug",
      io,
    })
    expect(outcome).toEqual({
      kind: "torn-down",
      worktreeRemoveError: null,
      workspaceCloseFailed: "no daemon",
    })
  })

  test("onBeforeRemove runs after gate, before remove; NOT run on noop", async () => {
    const order: string[] = []
    const { io } = fakeIo()
    await teardownWorkspace({
      targetPath: TARGET,
      slug: "my-slug",
      io: {
        ...io,
        removeWorktree: (fromMain, worktreePath) => {
          order.push("removeWorktree")
          return io.removeWorktree(fromMain, worktreePath)
        },
      },
      onBeforeRemove: async () => {
        order.push("onBeforeRemove")
      },
    })
    expect(order).toEqual(["onBeforeRemove", "removeWorktree"])

    // NOT run on noop.
    const ran: string[] = []
    const { io: io2 } = fakeIo({
      herdrList: JSON.stringify({ result: { workspaces: [] } }),
    })
    await teardownWorkspace({
      targetPath: TARGET,
      slug: "my-slug",
      io: io2,
      onBeforeRemove: async () => {
        ran.push("onBeforeRemove")
      },
    })
    expect(ran).toEqual([])
  })
})
