import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { ShResult } from "../build/repo"
import {
  gitWorktreeProvider,
  herdrWorktreeProvider,
  makeWorktreeProvider,
  supersetWorktreeProvider,
} from "./worktree-provider"

const REPO = "/Users/me/code/product"
const ARGS = {
  repoRoot: REPO,
  slug: "make-reads-bounded",
  branch: "dis-123-make-reads-bounded",
}
/** Where `gwt add <branch>` lands the worktree: a sibling of the main checkout. */
const GWT_PATH = "/Users/me/code/product-dis-123-make-reads-bounded"

const ok: ShResult = { code: 0, stdout: "", stderr: "" }

describe("gitWorktreeProvider", () => {
  test("pathFor is a gwt sibling <project>-<safe-branch> dir", () => {
    const provider = gitWorktreeProvider()
    expect(provider.pathFor(ARGS)).toBe(GWT_PATH)
  })

  test("slugInUse matches a sibling worktree dir ending in -<slug> (any issue id)", () => {
    const provider = gitWorktreeProvider({
      listDir: (p) =>
        p === "/Users/me/code"
          ? ["product", "product-dis-999-make-reads-bounded", "other"]
          : [],
    })
    expect(
      provider.slugInUse({ repoRoot: REPO, slug: "make-reads-bounded" }),
    ).toBe(true)
    expect(provider.slugInUse({ repoRoot: REPO, slug: "other" })).toBe(false)
  })

  test("create runs `gwt add <branch>` and captures the path from stdout", async () => {
    const calls: string[][] = []
    const provider = gitWorktreeProvider({
      run: (cmd) => {
        calls.push(cmd)
        return cmd[1] === "add"
          ? {
              code: 0,
              stdout: `${GWT_PATH}\n`,
              stderr: "Running worktree-init.sh...",
            }
          : ok
      },
    })
    const handle = await provider.create({ ...ARGS, base: "main" })
    // Preflight first, then the create — both via gwt.
    expect(calls[0]).toEqual(["gwt", "--version"])
    expect(calls[1]).toEqual(["gwt", "add", ARGS.branch])
    // The path comes from gwt's stdout, not the prediction.
    expect(handle.path).toBe(GWT_PATH)
  })

  test("create throws a clear `gwt not found` error when gwt is not on PATH", async () => {
    const calls: string[][] = []
    const provider = gitWorktreeProvider({
      run: (cmd) => {
        calls.push(cmd)
        return cmd[1] === "--version"
          ? { code: 127, stdout: "", stderr: "command not found" }
          : ok
      },
    })
    await expect(provider.create({ ...ARGS, base: "main" })).rejects.toThrow(
      /gwt not found/,
    )
    // Never attempts the add when the preflight fails.
    expect(calls.some((c) => c[1] === "add")).toBe(false)
  })

  test("create throws when `gwt add` fails", async () => {
    const provider = gitWorktreeProvider({
      run: (cmd) =>
        cmd[1] === "add"
          ? { code: 1, stdout: "", stderr: "branch exists" }
          : ok,
    })
    await expect(provider.create({ ...ARGS, base: "main" })).rejects.toThrow(
      /gwt add/,
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
      join(WORKTREES_ROOT, "dis-123-make-reads-bounded"),
    )
  })

  test("slugInUse collides on slug regardless of the issue id in the dir name", () => {
    const provider = makeProvider({
      listDir: (path) =>
        path === WORKTREES_ROOT ? ["dis-999-make-reads-bounded"] : [],
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
    const WORKTREE = join(WORKTREES_ROOT, "dis-123-make-reads-bounded")
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

describe("herdrWorktreeProvider", () => {
  const WORKTREE = GWT_PATH
  const buildArgs = {
    handle: {},
    worktreePath: WORKTREE,
    slug: "make-reads-bounded",
  }

  /** A `run` mock that emits the herdr/claude JSON shapes for the happy path. */
  function herdrRun(opts: {
    calls?: string[][]
    impl?: (cmd: string[]) => ShResult | undefined
  }) {
    return (cmd: string[]): ShResult => {
      opts.calls?.push(cmd)
      const override = opts.impl?.(cmd)
      if (override) return override
      if (cmd[0] === "herdr" && cmd[1] === "workspace" && cmd[2] === "create")
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              workspace: { workspace_id: "ws-1" },
              root_pane: { pane_id: "pane-left" },
            },
          }),
          stderr: "",
        }
      if (cmd[0] === "herdr" && cmd[1] === "pane" && cmd[2] === "split") {
        // First split (right) → top-right monitor pane; second split (down) →
        // bottom-right dev-server pane.
        const down = cmd.includes("down")
        return {
          code: 0,
          stdout: JSON.stringify({
            result: { pane: { pane_id: down ? "pane-dev" : "pane-right" } },
          }),
          stderr: "",
        }
      }
      return ok
    }
  }

  test("delegates pathFor/slugInUse/create to the git provider", async () => {
    const calls: string[][] = []
    const provider = herdrWorktreeProvider({
      gitHooks: {
        run: (cmd) => {
          calls.push(cmd)
          return cmd[1] === "add"
            ? { code: 0, stdout: `${WORKTREE}\n`, stderr: "" }
            : ok
        },
        listDir: (p) =>
          p === "/Users/me/code" ? ["product-dis-123-make-reads-bounded"] : [],
      },
    })
    expect(provider.pathFor(ARGS)).toBe(WORKTREE)
    expect(
      provider.slugInUse({ repoRoot: REPO, slug: "make-reads-bounded" }),
    ).toBe(true)
    expect(provider.slugInUse({ repoRoot: REPO, slug: "other" })).toBe(false)
    const handle = await provider.create({ ...ARGS, base: "main" })
    expect(calls[0]).toEqual(["gwt", "--version"])
    expect(calls[1]).toEqual(["gwt", "add", ARGS.branch])
    expect(handle.path).toBe(WORKTREE)
  })

  test("has no surface hook (workspace is created at launch time)", () => {
    expect(herdrWorktreeProvider({}).surface).toBeUndefined()
  })

  test("startVisibleBuild happy path opens a three-pane workspace and returns true", async () => {
    const calls: string[][] = []
    const logs: string[] = []
    const writes: Array<{ path: string; contents: string }> = []
    const provider = herdrWorktreeProvider({
      log: (m) => logs.push(m),
      run: herdrRun({ calls }),
      writeFile: (path, contents) => writes.push({ path, contents }),
    })
    expect(await provider.startVisibleBuild?.(buildArgs)).toBe(true)

    // Call order: probe → claude → create → split(right) → split(down) →
    // monitor run → supervisor run.
    const seq = calls.map((c) => c.slice(0, 3).join(" "))
    expect(seq[0]).toBe("herdr workspace list")
    expect(seq[1]).toBe("claude --version")
    expect(seq[2]).toBe("herdr workspace create")
    expect(seq[3]).toBe("herdr pane split")
    expect(seq[4]).toBe("herdr pane split")

    const create = calls.find((c) => c[2] === "create")
    expect(create).toContain("--cwd")
    expect(create).toContain(WORKTREE)
    expect(create).toContain("--label")
    expect(create).toContain("make-reads-bounded")
    expect(create).toContain("--no-focus")

    const splits = calls.filter((c) => c[1] === "pane" && c[2] === "split")
    expect(splits).toHaveLength(2)
    // First split: right of the root (left) pane → top-right monitor.
    expect(splits[0]).toContain("pane-left")
    expect(splits[0]).toContain("--direction")
    expect(splits[0]).toContain("right")
    // Second split: below the monitor pane → bottom-right dev-server pane.
    expect(splits[1]).toContain("pane-right")
    expect(splits[1]).toContain("--direction")
    expect(splits[1]).toContain("down")

    const paneRuns = calls.filter((c) => c[1] === "pane" && c[2] === "run")
    // Exactly TWO pane runs — the dev pane is created but NOT run (lazy launch).
    expect(paneRuns).toHaveLength(2)
    expect(paneRuns.some((c) => c[3] === "pane-dev")).toBe(false)
    // Monitor pane runs the dashboard with an ABSOLUTE script path AND the
    // absolute build-dir argument (the path form, not the bare slug).
    const monitor = paneRuns[0]
    expect(monitor[3]).toBe("pane-right")
    expect(monitor[4]).toBe(
      `bun run ${WORKTREE}/bin/build/dashboard.ts ${WORKTREE}/build/make-reads-bounded`,
    )
    // Supervisor pane (the commit point) runs claude "/build <slug>".
    const supervisor = paneRuns[1]
    expect(supervisor[3]).toBe("pane-left")
    expect(supervisor[4]).toBe('claude "/build make-reads-bounded"')

    // The dev-server pane id is recorded for the build process to read.
    expect(writes).toHaveLength(1)
    expect(writes[0].path).toBe(
      `${WORKTREE}/build/make-reads-bounded/.build/dev-server-pane.json`,
    )
    expect(JSON.parse(writes[0].contents)).toEqual({
      paneId: "pane-dev",
      workspaceId: "ws-1",
      worktreePath: WORKTREE,
    })

    expect(logs.some((l) => l.includes("ws-1"))).toBe(true)
  })

  test("second split (dev pane) fails → false, closes the orphan, no supervisor", async () => {
    const calls: string[][] = []
    const provider = herdrWorktreeProvider({
      run: herdrRun({
        calls,
        impl: (cmd) =>
          cmd[1] === "pane" && cmd[2] === "split" && cmd.includes("down")
            ? { code: 1, stdout: "", stderr: "split failed" }
            : undefined,
      }),
    })
    expect(await provider.startVisibleBuild?.(buildArgs)).toBe(false)
    expect(calls.some((c) => c[1] === "pane" && c[2] === "run")).toBe(false)
    expect(calls).toContainEqual(["herdr", "workspace", "close", "ws-1"])
  })

  test("recording the dev pane fails → false, closes the orphan, no supervisor", async () => {
    const calls: string[][] = []
    const provider = herdrWorktreeProvider({
      run: herdrRun({ calls }),
      writeFile: () => {
        throw new Error("disk full")
      },
    })
    expect(await provider.startVisibleBuild?.(buildArgs)).toBe(false)
    expect(calls.some((c) => c[1] === "pane" && c[2] === "run")).toBe(false)
    expect(calls).toContainEqual(["herdr", "workspace", "close", "ws-1"])
  })

  test("returns false (headless) when herdr is unavailable", async () => {
    const calls: string[][] = []
    const logs: string[] = []
    const provider = herdrWorktreeProvider({
      log: (m) => logs.push(m),
      run: herdrRun({
        calls,
        impl: (cmd) =>
          cmd[1] === "workspace" && cmd[2] === "list"
            ? { code: 1, stdout: "", stderr: "daemon down" }
            : undefined,
      }),
    })
    expect(await provider.startVisibleBuild?.(buildArgs)).toBe(false)
    expect(calls.some((c) => c[2] === "create")).toBe(false)
    expect(logs.some((l) => l.includes("headless"))).toBe(true)
  })

  test("returns false (headless) when claude is not runnable", async () => {
    const calls: string[][] = []
    const provider = herdrWorktreeProvider({
      run: herdrRun({
        calls,
        impl: (cmd) =>
          cmd[0] === "claude"
            ? { code: 127, stdout: "", stderr: "command not found" }
            : undefined,
      }),
    })
    expect(await provider.startVisibleBuild?.(buildArgs)).toBe(false)
    expect(calls.some((c) => c[2] === "create")).toBe(false)
  })

  test("returns false (headless) when workspace create fails", async () => {
    const calls: string[][] = []
    const provider = herdrWorktreeProvider({
      run: herdrRun({
        calls,
        impl: (cmd) =>
          cmd[1] === "workspace" && cmd[2] === "create"
            ? { code: 1, stdout: "", stderr: "no daemon" }
            : undefined,
      }),
    })
    expect(await provider.startVisibleBuild?.(buildArgs)).toBe(false)
    expect(calls.some((c) => c[1] === "pane" && c[2] === "run")).toBe(false)
  })

  test("returns false (headless) when create output is unparseable", async () => {
    const calls: string[][] = []
    const provider = herdrWorktreeProvider({
      run: herdrRun({
        calls,
        impl: (cmd) =>
          cmd[1] === "workspace" && cmd[2] === "create"
            ? { code: 0, stdout: "not json", stderr: "" }
            : undefined,
      }),
    })
    expect(await provider.startVisibleBuild?.(buildArgs)).toBe(false)
    expect(calls.some((c) => c[2] === "split")).toBe(false)
  })

  test("pane split fails → false, closes the orphan workspace, no supervisor", async () => {
    const calls: string[][] = []
    const provider = herdrWorktreeProvider({
      run: herdrRun({
        calls,
        impl: (cmd) =>
          cmd[1] === "pane" && cmd[2] === "split"
            ? { code: 1, stdout: "", stderr: "split failed" }
            : undefined,
      }),
    })
    expect(await provider.startVisibleBuild?.(buildArgs)).toBe(false)
    expect(calls.some((c) => c[1] === "pane" && c[2] === "run")).toBe(false)
    expect(calls).toContainEqual(["herdr", "workspace", "close", "ws-1"])
  })

  test("monitor pane run fails → false, closes orphan, supervisor never sent", async () => {
    const calls: string[][] = []
    const provider = herdrWorktreeProvider({
      writeFile: () => {},
      run: herdrRun({
        calls,
        impl: (cmd) =>
          cmd[1] === "pane" && cmd[2] === "run" && cmd[3] === "pane-right"
            ? { code: 1, stdout: "", stderr: "pane gone" }
            : undefined,
      }),
    })
    expect(await provider.startVisibleBuild?.(buildArgs)).toBe(false)
    // The supervisor pane (pane-left) run must NEVER have been issued.
    expect(
      calls.some(
        (c) => c[1] === "pane" && c[2] === "run" && c[3] === "pane-left",
      ),
    ).toBe(false)
    expect(calls).toContainEqual(["herdr", "workspace", "close", "ws-1"])
  })

  test("supervisor pane run fails → THROWS (unknown state) and does NOT close the live workspace", async () => {
    const calls: string[][] = []
    const provider = herdrWorktreeProvider({
      writeFile: () => {},
      run: herdrRun({
        calls,
        impl: (cmd) =>
          cmd[1] === "pane" && cmd[2] === "run" && cmd[3] === "pane-left"
            ? { code: 1, stdout: "", stderr: "shell vanished" }
            : undefined,
      }),
    })
    await expect(provider.startVisibleBuild?.(buildArgs)).rejects.toThrow(
      /ws-1/,
    )
    // The live workspace must NOT be torn down on the ambiguous commit point.
    expect(calls.some((c) => c[1] === "workspace" && c[2] === "close")).toBe(
      false,
    )
  })
})

describe("makeWorktreeProvider", () => {
  test("selects the git provider by default name", () => {
    expect(makeWorktreeProvider({ provider: "git" }).name).toBe("git")
  })

  test("selects the herdr provider when configured", () => {
    expect(makeWorktreeProvider({ provider: "herdr" }).name).toBe("herdr")
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
