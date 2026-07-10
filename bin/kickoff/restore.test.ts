import { describe, expect, test } from "bun:test"
import {
  herdrWorkspacesForSlug,
  identifySupervisorPane,
  indexBranches,
  normalizeAttachedBranch,
  parseHerdrPaneList,
  parseRestoreResult,
  type RestoreDeps,
  type RestoreTicket,
  resolveRestoreBranch,
  resolveRestoreSlug,
  restore,
  supervisorPresent,
} from "./restore"

describe("indexBranches", () => {
  test("folds local + origin/ refs into one BranchRef", () => {
    const m = indexBranches([
      "kickoff/pro-1-foo",
      "origin/kickoff/pro-1-foo",
      "origin/kickoff/pro-2-bar",
      "main",
      "origin/HEAD",
    ])
    expect(m.get("kickoff/pro-1-foo")).toEqual({
      branch: "kickoff/pro-1-foo",
      localExists: true,
      remoteExists: true,
    })
    expect(m.get("kickoff/pro-2-bar")).toEqual({
      branch: "kickoff/pro-2-bar",
      localExists: false,
      remoteExists: true,
    })
    expect(m.get("main")).toEqual({
      branch: "main",
      localExists: true,
      remoteExists: false,
    })
    expect(m.has("HEAD")).toBe(false)
  })
})

describe("normalizeAttachedBranch", () => {
  test("plain kickoff branch unchanged", () => {
    expect(normalizeAttachedBranch("kickoff/PRO-1-foo")).toBe(
      "kickoff/PRO-1-foo",
    )
  })
  test("strips a leading origin/", () => {
    expect(normalizeAttachedBranch("origin/kickoff/PRO-1-foo")).toBe(
      "kickoff/PRO-1-foo",
    )
  })
  test("strips an owner: PR-head prefix", () => {
    expect(normalizeAttachedBranch("owner:kickoff/PRO-1-foo")).toBe(
      "kickoff/PRO-1-foo",
    )
  })
  test("empty / whitespace / leading-dash → null", () => {
    expect(normalizeAttachedBranch("")).toBeNull()
    expect(normalizeAttachedBranch("   ")).toBeNull()
    expect(normalizeAttachedBranch("-x")).toBeNull()
    expect(normalizeAttachedBranch(null)).toBeNull()
  })
})

describe("resolveRestoreBranch", () => {
  test("attached PR head branch wins (precedence #1)", () => {
    const idx = indexBranches(["kickoff/pro-1-foo"])
    const r = resolveRestoreBranch({
      issueId: "PRO-1",
      title: "Foo",
      attachedBranch: "kickoff/pro-1-foo",
      branchIndex: idx,
    })
    expect(r.source).toBe("attached")
    expect(r.branch).toBe("kickoff/pro-1-foo")
    expect(r.sourceRef).toBe("kickoff/pro-1-foo")
  })

  test("attached branch with no PR still wins (resolver is source-agnostic)", () => {
    const idx = indexBranches(["origin/kickoff/pro-1-foo"])
    const r = resolveRestoreBranch({
      issueId: "PRO-1",
      title: "Foo",
      attachedBranch: "kickoff/pro-1-foo",
      branchIndex: idx,
    })
    expect(r.source).toBe("attached")
    expect(r.sourceRef).toBe("origin/kickoff/pro-1-foo")
  })

  test("attached branch NOT carrying the Linear id beats an existing id branch (precedence #1 > #2)", () => {
    const idx = indexBranches(["kickoff/pro-1-foo", "feature/some-rename"])
    const r = resolveRestoreBranch({
      issueId: "PRO-1",
      title: "Foo",
      attachedBranch: "feature/some-rename",
      branchIndex: idx,
    })
    expect(r.source).toBe("attached")
    expect(r.branch).toBe("feature/some-rename")
  })

  test("falls back to existing id branch when nothing attached", () => {
    const idx = indexBranches(["kickoff/pro-1-foo"])
    const r = resolveRestoreBranch({
      issueId: "PRO-1",
      title: "Foo",
      attachedBranch: null,
      branchIndex: idx,
    })
    expect(r.source).toBe("existing")
    expect(r.branch).toBe("kickoff/pro-1-foo")
  })

  test("remote-only existing branch — no origin/ leaks into branch", () => {
    const idx = indexBranches(["origin/kickoff/pro-1-foo"])
    const r = resolveRestoreBranch({
      issueId: "PRO-1",
      title: "Foo",
      attachedBranch: null,
      branchIndex: idx,
    })
    expect(r).toEqual({
      branch: "kickoff/pro-1-foo",
      localExists: false,
      remoteExists: true,
      source: "existing",
      sourceRef: "origin/kickoff/pro-1-foo",
    })
  })

  test("derived fallback when nothing attached and no id branch", () => {
    const idx = indexBranches(["main"])
    const r = resolveRestoreBranch({
      issueId: "PRO-9",
      title: "Brand New Thing",
      attachedBranch: null,
      branchIndex: idx,
    })
    expect(r.source).toBe("derived")
    expect(r.branch).toBe("pro-9-brand-new-thing")
    expect(r.sourceRef).toBeNull()
  })

  test("rename-desync: existing id branch wins over re-derivation", () => {
    const idx = indexBranches(["kickoff/pro-1-original-name"])
    const r = resolveRestoreBranch({
      issueId: "PRO-1",
      title: "A Completely Different Title Now",
      attachedBranch: null,
      branchIndex: idx,
    })
    expect(r.source).toBe("existing")
    expect(r.branch).toBe("kickoff/pro-1-original-name")
  })
})

describe("resolveRestoreSlug", () => {
  test("parses the slug from a kickoff-scheme branch name", () => {
    expect(
      resolveRestoreSlug({
        branch: "kickoff/pro-532-my-cool-slug",
        title: "Whatever",
        committedBuildDirs: [],
      }),
    ).toBe("my-cool-slug")
  })

  test("single committed build dir (excluding kickoff) used when branch not kickoff-scheme", () => {
    expect(
      resolveRestoreSlug({
        branch: "feature/x",
        title: "Whatever",
        committedBuildDirs: ["kickoff", "the-slug"],
      }),
    ).toBe("the-slug")
  })

  test("ambiguous build dirs → title fallback", () => {
    expect(
      resolveRestoreSlug({
        branch: "feature/x",
        title: "Title Here",
        committedBuildDirs: ["a", "b"],
      }),
    ).toBe("title-here")
  })

  test("no build dir → title fallback", () => {
    expect(
      resolveRestoreSlug({
        branch: "feature/x",
        title: "Title Here",
        committedBuildDirs: [],
      }),
    ).toBe("title-here")
  })
})

describe("herdr pane helpers", () => {
  const panes = [
    { paneId: "p1", workspaceId: "ws_1", agent: "claude" },
    { paneId: "p2", workspaceId: "ws_1", agent: null },
  ]

  test("parseHerdrPaneList tolerant", () => {
    const stdout = JSON.stringify({
      result: {
        panes: [
          { pane_id: "p1", workspace_id: "ws_1", agent: "claude" },
          { pane_id: "p2", workspace_id: "ws_1" },
        ],
      },
    })
    expect(parseHerdrPaneList(stdout)).toEqual(panes)
    expect(parseHerdrPaneList("not json")).toEqual([])
  })

  test("supervisorPresent", () => {
    expect(supervisorPresent(panes, "ws_1")).toBe(true)
    expect(
      supervisorPresent(
        [{ paneId: "p2", workspaceId: "ws_1", agent: null }],
        "ws_1",
      ),
    ).toBe(false)
  })

  test("identifySupervisorPane: single non-dashboard candidate → that pane", () => {
    const isDashboard = (id: string) => id === "p2"
    expect(
      identifySupervisorPane({
        panes: [
          { paneId: "p1", workspaceId: "ws_1", agent: null },
          { paneId: "p2", workspaceId: "ws_1", agent: null },
        ],
        isDashboard,
      }),
    ).toBe("p1")
  })

  test("identifySupervisorPane: 0 or >1 candidates → null", () => {
    const none = (_: string) => true
    expect(
      identifySupervisorPane({
        panes: [{ paneId: "p1", workspaceId: "ws_1", agent: null }],
        isDashboard: none,
      }),
    ).toBeNull()
    const never = (_: string) => false
    expect(
      identifySupervisorPane({
        panes: [
          { paneId: "p1", workspaceId: "ws_1", agent: null },
          { paneId: "p2", workspaceId: "ws_1", agent: null },
        ],
        isDashboard: never,
      }),
    ).toBeNull()
  })
})

describe("herdrWorkspacesForSlug", () => {
  test("0 / 1 / 2 matches", () => {
    expect(herdrWorkspacesForSlug([], "s")).toEqual([])
    expect(
      herdrWorkspacesForSlug([{ workspaceId: "ws_1", label: "s" }], "s"),
    ).toEqual(["ws_1"])
    expect(
      herdrWorkspacesForSlug(
        [
          { workspaceId: "ws_1", label: "s" },
          { workspaceId: "ws_2", label: "s" },
        ],
        "s",
      ),
    ).toEqual(["ws_1", "ws_2"])
  })
})

describe("parseRestoreResult", () => {
  test("valid array → tickets (branch null preserved)", () => {
    const v = [
      {
        issueId: "PRO-1",
        issueUuid: "u1",
        title: "T1",
        branch: "kickoff/pro-1-x",
      },
      { issueId: "PRO-2", issueUuid: "u2", title: "T2", branch: null },
    ]
    expect(parseRestoreResult(v, "/tmp/r.json")).toEqual(v as RestoreTicket[])
  })

  test("empty array → []", () => {
    expect(parseRestoreResult([], "/tmp/r.json")).toEqual([])
  })

  test("non-array → throws", () => {
    expect(() => parseRestoreResult({ none: true }, "/tmp/r.json")).toThrow()
  })

  test("malformed item → throws", () => {
    expect(() => parseRestoreResult([{ issueId: "" }], "/tmp/r.json")).toThrow()
  })
})

// --- restore() orchestration --------------------------------------------------

const MAIN = "/code/dispatch"
const WT_ROOT_ENTRY = `worktree ${MAIN}\nHEAD a\nbranch refs/heads/main\n`

type FakeOpts = {
  tickets?: RestoreTicket[]
  branches?: string[]
  worktreePorcelain?: string
  pathExists?: (p: string) => boolean
  remoteBranchExists?: (b: string) => boolean
  fetchRemoteBranch?: (b: string) => void
  lsTreeBuildDirs?: (ref: string) => string[]
  prMerged?: (ref: string) => boolean
  herdrWorkspaceList?: string
  herdrPaneList?: (ws: string) => string
  paneIsDashboard?: (p: string) => boolean
  startWorkspace?: (a: {
    worktreePath: string
    slug: string
  }) => Promise<boolean>
  runInPane?: (a: { paneId: string; slug: string }) => boolean
}

function fakeDeps(opts: FakeOpts = {}): {
  deps: RestoreDeps
  calls: {
    createWorktree: unknown[]
    startWorkspace: unknown[]
    runInPane: unknown[]
  }
  logs: string[]
} {
  const calls = {
    createWorktree: [] as unknown[],
    startWorkspace: [] as unknown[],
    runInPane: [] as unknown[],
  }
  const logs: string[] = []
  const deps: RestoreDeps = {
    runRestoreSelect: async () => opts.tickets ?? [],
    listAllBranches: () => opts.branches ?? ["main"],
    remoteBranchExists: opts.remoteBranchExists ?? (() => false),
    fetchRemoteBranch: opts.fetchRemoteBranch ?? (() => {}),
    worktreeListPorcelain: () => opts.worktreePorcelain ?? WT_ROOT_ENTRY,
    pathExists: opts.pathExists ?? (() => false),
    lsTreeBuildDirs: opts.lsTreeBuildDirs ?? (() => []),
    prMerged: opts.prMerged ?? (() => false),
    createWorktree: (a) => {
      calls.createWorktree.push(a)
    },
    herdrWorkspaceListRaw: () =>
      opts.herdrWorkspaceList ?? JSON.stringify({ result: { workspaces: [] } }),
    herdrPaneListRaw: (ws) =>
      (opts.herdrPaneList ?? (() => JSON.stringify({ result: { panes: [] } })))(
        ws,
      ),
    paneIsDashboard: opts.paneIsDashboard ?? (() => false),
    startWorkspace:
      opts.startWorkspace ??
      (async (a) => {
        calls.startWorkspace.push(a)
        return true
      }),
    runInPane:
      opts.runInPane ??
      ((a) => {
        calls.runInPane.push(a)
        return true
      }),
    log: (m) => logs.push(m),
  }
  // Wrap createWorktree-tracking startWorkspace if a custom one was supplied.
  if (opts.startWorkspace) {
    const inner = opts.startWorkspace
    deps.startWorkspace = async (a) => {
      calls.startWorkspace.push(a)
      return inner(a)
    }
  }
  if (opts.runInPane) {
    const inner = opts.runInPane
    deps.runInPane = (a) => {
      calls.runInPane.push(a)
      return inner(a)
    }
  }
  return { deps, calls, logs }
}

const config = {} as never

describe("restore()", () => {
  test("worktree exists + supervisor present → already-present (no create/start/runInPane)", async () => {
    const wtPorcelain = `${WT_ROOT_ENTRY}\nworktree ${MAIN}-kickoff-pro-1-foo\nHEAD b\nbranch refs/heads/kickoff/pro-1-foo\n`
    const { deps, calls, logs } = fakeDeps({
      tickets: [
        {
          issueId: "PRO-1",
          issueUuid: "u",
          title: "Foo",
          branch: "kickoff/pro-1-foo",
        },
      ],
      branches: ["kickoff/pro-1-foo"],
      worktreePorcelain: wtPorcelain,
      herdrWorkspaceList: JSON.stringify({
        result: { workspaces: [{ workspace_id: "ws_1", label: "foo" }] },
      }),
      herdrPaneList: () =>
        JSON.stringify({
          result: {
            panes: [{ pane_id: "p1", workspace_id: "ws_1", agent: "claude" }],
          },
        }),
    })
    const code = await restore(MAIN, config, deps)
    expect(code).toBe(0)
    expect(calls.createWorktree).toEqual([])
    expect(calls.startWorkspace).toEqual([])
    expect(calls.runInPane).toEqual([])
    expect(logs.join("\n")).toMatch(/PRO-1: already-present/)
  })

  test("workspace open + no live supervisor → recovered via runInPane", async () => {
    const wtPorcelain = `${WT_ROOT_ENTRY}\nworktree ${MAIN}-kickoff-pro-1-foo\nHEAD b\nbranch refs/heads/kickoff/pro-1-foo\n`
    const { deps, calls, logs } = fakeDeps({
      tickets: [
        {
          issueId: "PRO-1",
          issueUuid: "u",
          title: "Foo",
          branch: "kickoff/pro-1-foo",
        },
      ],
      branches: ["kickoff/pro-1-foo"],
      worktreePorcelain: wtPorcelain,
      herdrWorkspaceList: JSON.stringify({
        result: { workspaces: [{ workspace_id: "ws_1", label: "foo" }] },
      }),
      herdrPaneList: () =>
        JSON.stringify({
          result: {
            panes: [
              { pane_id: "p1", workspace_id: "ws_1", agent: null },
              { pane_id: "p2", workspace_id: "ws_1", agent: null },
            ],
          },
        }),
      paneIsDashboard: (p) => p === "p2",
    })
    const code = await restore(MAIN, config, deps)
    expect(code).toBe(0)
    expect(calls.runInPane).toEqual([{ paneId: "p1", slug: "foo" }])
    expect(logs.join("\n")).toMatch(/PRO-1: recovered/)
  })

  test("workspace open + supervisor pane unidentifiable → skipped", async () => {
    const wtPorcelain = `${WT_ROOT_ENTRY}\nworktree ${MAIN}-kickoff-pro-1-foo\nHEAD b\nbranch refs/heads/kickoff/pro-1-foo\n`
    const { deps, calls, logs } = fakeDeps({
      tickets: [
        {
          issueId: "PRO-1",
          issueUuid: "u",
          title: "Foo",
          branch: "kickoff/pro-1-foo",
        },
      ],
      branches: ["kickoff/pro-1-foo"],
      worktreePorcelain: wtPorcelain,
      herdrWorkspaceList: JSON.stringify({
        result: { workspaces: [{ workspace_id: "ws_1", label: "foo" }] },
      }),
      herdrPaneList: () =>
        JSON.stringify({
          result: {
            panes: [
              { pane_id: "p1", workspace_id: "ws_1", agent: null },
              { pane_id: "p2", workspace_id: "ws_1", agent: null },
            ],
          },
        }),
      paneIsDashboard: () => false, // 2 non-dashboard candidates → ambiguous
    })
    const code = await restore(MAIN, config, deps)
    expect(code).toBe(0)
    expect(calls.runInPane).toEqual([])
    expect(logs.join("\n")).toMatch(/PRO-1: skipped/)
  })

  test("fresh ticket (no branch anywhere) → create (fresh) + startWorkspace → started", async () => {
    const { deps, calls, logs } = fakeDeps({
      tickets: [
        { issueId: "PRO-9", issueUuid: "u", title: "New Thing", branch: null },
      ],
      branches: ["main"],
    })
    const code = await restore(MAIN, config, deps)
    expect(code).toBe(0)
    expect(calls.createWorktree).toEqual([
      {
        path: `/code/dispatch-pro-9-new-thing`,
        branch: "pro-9-new-thing",
        mode: "fresh",
        base: "main",
      },
    ])
    expect(calls.startWorkspace).toEqual([
      {
        worktreePath: `/code/dispatch-pro-9-new-thing`,
        slug: "new-thing",
      },
    ])
    expect(logs.join("\n")).toMatch(/PRO-9: started/)
    expect(logs.join("\n")).toMatch(/unrecoverable|unpushed/i)
  })

  test("remote-only branch → create (remote) with origin/ sourceRef driving ls-tree/prMerged", async () => {
    const seenRefs: string[] = []
    const { deps, calls } = fakeDeps({
      tickets: [
        { issueId: "PRO-1", issueUuid: "u", title: "Foo", branch: null },
      ],
      branches: ["origin/kickoff/pro-1-foo"],
      lsTreeBuildDirs: (ref) => {
        seenRefs.push(ref)
        return ["foo"]
      },
      prMerged: (ref) => {
        seenRefs.push(ref)
        return false
      },
    })
    const code = await restore(MAIN, config, deps)
    expect(code).toBe(0)
    expect(calls.createWorktree).toEqual([
      {
        path: `/code/dispatch-kickoff-pro-1-foo`,
        branch: "kickoff/pro-1-foo",
        mode: "remote",
        base: "main",
      },
    ])
    expect(seenRefs).toContain("origin/kickoff/pro-1-foo")
  })

  test("attached non-scheme branch, remote-only, committed build dir → slug from build dir (fetched before inspection)", async () => {
    // The branch exists only on the remote (proven by git ls-remote), NOT yet in
    // this clone's origin/* refs. Until fetchRemoteBranch primes origin/<branch>,
    // ls-tree origin/<branch>:build reads a missing ref and returns []. Model that
    // ordering: lsTreeBuildDirs yields the committed dir ONLY after the fetch.
    let fetched = false
    const fetchedBranches: string[] = []
    const { deps, calls } = fakeDeps({
      tickets: [
        {
          issueId: "PRO-7",
          issueUuid: "u",
          // Title differs from the committed build slug — proving the slug is
          // taken from build/ artifacts, not slugify(title).
          title: "Renamed Title",
          branch: "feature/cool-rename",
        },
      ],
      // Not in local refs → remoteBranchExists (ls-remote) is the only proof.
      branches: ["main"],
      remoteBranchExists: (b) => b === "feature/cool-rename",
      fetchRemoteBranch: (b) => {
        fetchedBranches.push(b)
        fetched = true
      },
      lsTreeBuildDirs: (ref) =>
        fetched && ref === "origin/feature/cool-rename"
          ? ["committed-slug"]
          : [],
    })
    const code = await restore(MAIN, config, deps)
    expect(code).toBe(0)
    // Fetched the remote branch (so origin/<branch> exists before inspection).
    expect(fetchedBranches).toEqual(["feature/cool-rename"])
    // Worktree + workspace use the build-dir slug, not slugify("Renamed Title").
    expect(calls.createWorktree).toEqual([
      {
        path: `/code/dispatch-feature-cool-rename`,
        branch: "feature/cool-rename",
        mode: "remote",
        base: "main",
      },
    ])
    expect(calls.startWorkspace).toEqual([
      {
        worktreePath: `/code/dispatch-feature-cool-rename`,
        slug: "committed-slug",
      },
    ])
  })

  test("startWorkspace returns false → skipped, pass continues", async () => {
    const { deps, logs } = fakeDeps({
      tickets: [
        { issueId: "PRO-9", issueUuid: "u", title: "New Thing", branch: null },
      ],
      startWorkspace: async () => false,
    })
    const code = await restore(MAIN, config, deps)
    expect(code).toBe(0)
    expect(logs.join("\n")).toMatch(/PRO-9: skipped/)
  })

  test("startWorkspace throws → caught, skipped, next ticket still processed", async () => {
    const { deps, calls, logs } = fakeDeps({
      tickets: [
        { issueId: "PRO-9", issueUuid: "u", title: "New Thing", branch: null },
        {
          issueId: "PRO-10",
          issueUuid: "u2",
          title: "Another Thing",
          branch: null,
        },
      ],
      startWorkspace: async (a) => {
        if (a.slug === "new-thing") throw new Error("boom")
        return true
      },
    })
    const code = await restore(MAIN, config, deps)
    expect(code).toBe(0)
    expect(logs.join("\n")).toMatch(/PRO-9: skipped/)
    expect(logs.join("\n")).toMatch(/PRO-10: started/)
    // both tickets created their worktree
    expect(calls.createWorktree.length).toBe(2)
  })

  test("already-merged branch → skipped", async () => {
    const { deps, calls, logs } = fakeDeps({
      tickets: [
        { issueId: "PRO-1", issueUuid: "u", title: "Foo", branch: null },
      ],
      branches: ["origin/kickoff/pro-1-foo"],
      prMerged: () => true,
    })
    const code = await restore(MAIN, config, deps)
    expect(code).toBe(0)
    expect(calls.createWorktree).toEqual([])
    expect(logs.join("\n")).toMatch(/PRO-1: skipped/)
    expect(logs.join("\n")).toMatch(/merged/i)
  })

  test("occupied unregistered path → skipped (not clobbered)", async () => {
    const { deps, calls, logs } = fakeDeps({
      tickets: [
        { issueId: "PRO-9", issueUuid: "u", title: "New Thing", branch: null },
      ],
      pathExists: () => true,
    })
    const code = await restore(MAIN, config, deps)
    expect(code).toBe(0)
    expect(calls.createWorktree).toEqual([])
    expect(logs.join("\n")).toMatch(/PRO-9: skipped/)
  })
})
