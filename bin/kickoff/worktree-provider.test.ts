import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { ShResult } from "../build/repo"
import {
  gitWorktreeProvider,
  makeWorktreeProvider,
  supersetWorktreeProvider,
} from "./worktree-provider"

const REPO = "/Users/me/code/product"
const ARGS = {
  repoRoot: REPO,
  slug: "make-reads-bounded",
  branch: "kickoff/dis-123-make-reads-bounded",
}

const ok: ShResult = { code: 0, stdout: "", stderr: "" }

describe("gitWorktreeProvider", () => {
  test("pathFor is a sibling .kickoff-worktrees/<slug> dir", () => {
    const provider = gitWorktreeProvider()
    expect(provider.pathFor(ARGS)).toBe(
      "/Users/me/code/.kickoff-worktrees/make-reads-bounded",
    )
  })

  test("slugInUse is keyed by slug alone (any issue id collides)", () => {
    const provider = gitWorktreeProvider({
      exists: (p) =>
        p === "/Users/me/code/.kickoff-worktrees/make-reads-bounded",
    })
    expect(
      provider.slugInUse({ repoRoot: REPO, slug: "make-reads-bounded" }),
    ).toBe(true)
    expect(provider.slugInUse({ repoRoot: REPO, slug: "other" })).toBe(false)
  })

  test("create fetches the base then adds a worktree off origin/<base>", async () => {
    const calls: string[][] = []
    const provider = gitWorktreeProvider({
      run: (cmd) => {
        calls.push(cmd)
        return ok
      },
    })
    await provider.create({ ...ARGS, base: "main" })
    expect(calls[0]).toEqual(["git", "fetch", "origin", "main"])
    expect(calls[1]).toEqual([
      "git",
      "worktree",
      "add",
      provider.pathFor(ARGS),
      "-b",
      ARGS.branch,
      "origin/main",
    ])
  })

  test("create throws when the fetch fails (never branch off a stale ref)", async () => {
    const provider = gitWorktreeProvider({
      run: (cmd) =>
        cmd[1] === "fetch" ? { code: 1, stdout: "", stderr: "no network" } : ok,
    })
    await expect(provider.create({ ...ARGS, base: "main" })).rejects.toThrow(
      /fetch/,
    )
  })

  test("create throws when the worktree add fails", async () => {
    const provider = gitWorktreeProvider({
      run: (cmd) =>
        cmd[1] === "worktree"
          ? { code: 1, stdout: "", stderr: "branch exists" }
          : ok,
    })
    await expect(provider.create({ ...ARGS, base: "main" })).rejects.toThrow(
      /worktree add/,
    )
  })

  test("has no UI hooks (plain git has no UI to surface into)", () => {
    const provider = gitWorktreeProvider()
    expect(provider.surface).toBeUndefined()
    expect(provider.startVisibleBuild).toBeUndefined()
  })
})

describe("supersetWorktreeProvider", () => {
  const PROJECT = "00000000-0000-4000-8000-000000000000"
  const WORKTREES_ROOT = join("/Users/me", ".superset", "worktrees", PROJECT)

  function makeProvider(opts: {
    runImpl?: (cmd: string[]) => ShResult
    readyAfterPolls?: number
    calls?: string[][]
    logs?: string[]
    listDir?: (path: string) => string[]
  }) {
    let polls = 0
    return supersetWorktreeProvider({
      projectId: PROJECT,
      homeDir: "/Users/me",
      log: (m) => opts.logs?.push(m),
      run: (cmd) => {
        opts.calls?.push(cmd)
        if (opts.runImpl) return opts.runImpl(cmd)
        return cmd[0] === "superset" && cmd[1] === "workspaces"
          ? {
              code: 0,
              stdout: JSON.stringify({ workspace: { id: "ws-1" } }),
              stderr: "",
            }
          : cmd[0] === "superset" && cmd[1] === "terminals"
            ? {
                code: 0,
                stdout: JSON.stringify({ terminalId: "term-1" }),
                stderr: "",
              }
            : ok
      },
      isGitReady: () => ++polls > (opts.readyAfterPolls ?? 0),
      listDir: opts.listDir ?? (() => []),
      sleep: async () => {},
      timeoutMs: 100,
      pollIntervalMs: 10,
    })
  }

  test("pathFor nests the branch under ~/.superset/worktrees/<projectId>", () => {
    const provider = makeProvider({})
    expect(provider.pathFor(ARGS)).toBe(
      join(WORKTREES_ROOT, "kickoff", "dis-123-make-reads-bounded"),
    )
  })

  test("slugInUse collides on slug regardless of the issue id in the dir name", () => {
    const provider = makeProvider({
      listDir: (path) =>
        path === join(WORKTREES_ROOT, "kickoff")
          ? ["dis-999-make-reads-bounded"]
          : [],
    })
    expect(
      provider.slugInUse({ repoRoot: REPO, slug: "make-reads-bounded" }),
    ).toBe(true)
    expect(provider.slugInUse({ repoRoot: REPO, slug: "other" })).toBe(false)
  })

  test("create invokes the superset CLI with branch, base, and project", async () => {
    const calls: string[][] = []
    const provider = makeProvider({ calls })
    await provider.create({ ...ARGS, base: "main" })
    expect(calls[0]).toEqual([
      "superset",
      "workspaces",
      "create",
      "--local",
      "--project",
      PROJECT,
      "--name",
      ARGS.slug,
      "--branch",
      ARGS.branch,
      "--base-branch",
      "main",
      "--json",
    ])
  })

  test("create waits until the worktree is git-ready (setup is async)", async () => {
    const provider = makeProvider({ readyAfterPolls: 3 })
    await expect(provider.create({ ...ARGS, base: "main" })).resolves.toEqual({
      workspaceId: "ws-1",
    })
  })

  test("create logs the workspace id so the operator can delete it later", async () => {
    const logs: string[] = []
    const provider = makeProvider({ logs })
    await provider.create({ ...ARGS, base: "main" })
    expect(logs.some((l) => l.includes("ws-1"))).toBe(true)
  })

  test("create logs raw CLI output when the workspace id cannot be parsed", async () => {
    const logs: string[] = []
    const provider = makeProvider({
      logs,
      runImpl: (cmd) =>
        cmd[0] === "superset"
          ? { code: 0, stdout: "not json at all", stderr: "" }
          : ok,
    })
    await provider.create({ ...ARGS, base: "main" })
    expect(logs.some((l) => l.includes("not json at all"))).toBe(true)
  })

  test("create verifies the worktree is based on a fresh origin/<base> once ready", async () => {
    const calls: string[][] = []
    const provider = makeProvider({ calls })
    await provider.create({ ...ARGS, base: "main" })
    expect(calls).toContainEqual(["git", "fetch", "origin", "main"])
    expect(calls).toContainEqual([
      "git",
      "merge-base",
      "--is-ancestor",
      "origin/main",
      "HEAD",
    ])
  })

  test("create warns (but proceeds) when the base is stale or unverifiable", async () => {
    const staleLogs: string[] = []
    const stale = makeProvider({
      logs: staleLogs,
      runImpl: (cmd) =>
        cmd[1] === "merge-base"
          ? { code: 1, stdout: "", stderr: "" }
          : cmd[0] === "superset"
            ? { code: 0, stdout: "{}", stderr: "" }
            : ok,
    })
    await stale.create({ ...ARGS, base: "main" })
    expect(staleLogs.some((l) => l.includes("stale"))).toBe(true)

    const fetchFailLogs: string[] = []
    const fetchFail = makeProvider({
      logs: fetchFailLogs,
      runImpl: (cmd) =>
        cmd[1] === "fetch"
          ? { code: 1, stdout: "", stderr: "no network" }
          : cmd[0] === "superset"
            ? { code: 0, stdout: "{}", stderr: "" }
            : ok,
    })
    await fetchFail.create({ ...ARGS, base: "main" })
    expect(fetchFailLogs.some((l) => l.includes("could not verify"))).toBe(true)
  })

  test("create throws when the CLI fails", async () => {
    const provider = makeProvider({
      runImpl: () => ({ code: 1, stdout: "", stderr: "not logged in" }),
    })
    await expect(provider.create({ ...ARGS, base: "main" })).rejects.toThrow(
      /superset workspaces create/,
    )
  })

  test("create throws when the worktree never becomes ready", async () => {
    const provider = makeProvider({ readyAfterPolls: 1000 })
    await expect(provider.create({ ...ARGS, base: "main" })).rejects.toThrow(
      /not ready/,
    )
  })

  test("surface opens the workspace in the desktop app", () => {
    const calls: string[][] = []
    const provider = makeProvider({ calls })
    provider.surface?.({ workspaceId: "ws-1" })
    expect(calls).toContainEqual(["superset", "workspaces", "open", "ws-1"])
  })

  test("surface warns (never throws) when the open fails or the id is missing", () => {
    const logs: string[] = []
    const failing = makeProvider({
      logs,
      runImpl: () => ({ code: 1, stdout: "", stderr: "app not running" }),
    })
    expect(() => failing.surface?.({ workspaceId: "ws-1" })).not.toThrow()
    expect(logs.some((l) => l.includes("warning"))).toBe(true)

    const calls: string[][] = []
    const noId = makeProvider({ calls })
    noId.surface?.({})
    expect(calls).toEqual([])
  })

  describe("startVisibleBuild", () => {
    const WORKTREE = join(
      WORKTREES_ROOT,
      "kickoff",
      "dis-123-make-reads-bounded",
    )
    const buildArgs = {
      handle: { workspaceId: "ws-1" },
      worktreePath: WORKTREE,
      slug: "make-reads-bounded",
    }

    test("launches a supervising claude /build session in a superset terminal and returns true", async () => {
      const calls: string[][] = []
      const logs: string[] = []
      const provider = makeProvider({ calls, logs })
      expect(await provider.startVisibleBuild?.(buildArgs)).toBe(true)
      const term = calls.find((c) => c[1] === "terminals")
      expect(term).toBeDefined()
      expect(term).toContain("--workspace")
      expect(term).toContain("ws-1")
      expect(term).toContain("--cwd")
      expect(term).toContain(WORKTREE)
      const command = term?.[term.indexOf("--command") + 1]
      expect(command).toBe('claude "/build make-reads-bounded"')
      // The terminal id is the operator's pointer to the running build.
      expect(logs.some((l) => l.includes("term-1"))).toBe(true)
    })

    test("returns false (fall back to headless) when the terminal cannot be created", async () => {
      const logs: string[] = []
      const provider = makeProvider({
        logs,
        runImpl: (cmd) =>
          cmd[1] === "terminals"
            ? { code: 1, stdout: "", stderr: "host gone" }
            : ok,
      })
      expect(await provider.startVisibleBuild?.(buildArgs)).toBe(false)
      expect(logs.some((l) => l.includes("headless"))).toBe(true)
    })

    test("returns false (fall back to headless) when claude is not runnable", async () => {
      const logs: string[] = []
      const calls: string[][] = []
      const provider = makeProvider({
        calls,
        logs,
        runImpl: (cmd) =>
          cmd[0] === "claude"
            ? { code: 127, stdout: "", stderr: "command not found" }
            : ok,
      })
      expect(await provider.startVisibleBuild?.(buildArgs)).toBe(false)
      expect(calls.some((c) => c[1] === "terminals")).toBe(false)
      expect(logs.some((l) => l.includes("headless"))).toBe(true)
    })

    test("returns false (fall back to headless) when the handle has no workspace id", async () => {
      const calls: string[][] = []
      const provider = makeProvider({ calls })
      expect(
        await provider.startVisibleBuild?.({ ...buildArgs, handle: {} }),
      ).toBe(false)
      expect(calls.some((c) => c[1] === "terminals")).toBe(false)
    })
  })
})

describe("makeWorktreeProvider", () => {
  test("selects the git provider by default name", () => {
    expect(makeWorktreeProvider({ provider: "git" }).name).toBe("git")
  })

  test("selects the superset provider when configured", () => {
    expect(
      makeWorktreeProvider({ provider: "superset", supersetProjectId: "p-1" })
        .name,
    ).toBe("superset")
  })

  test("throws for superset without a project id", () => {
    expect(() => makeWorktreeProvider({ provider: "superset" })).toThrow(
      /supersetProjectId/,
    )
  })
})
