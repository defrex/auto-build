import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { resolveConfig } from "./config"
import {
  type BuildRunResult,
  KICKOFF_BASE_REF,
  type KickoffDeps,
  kickoff,
  parseSelectResult,
  runBuildWithProvider,
  type SelectResult,
  uniqueSlug,
} from "./kickoff"

const LINEAR = {
  teamId: "t",
  projectId: "p",
  triageStateId: "s_t",
  readyStateId: "s_r",
  inProgressStateId: "s_p",
  doneStateId: "s_d",
  rejectedStateIds: [],
  sourceObservationsLabelId: "l_o",
  sourceSentryLabelId: "l_s",
  needsDefinitionLabelId: "l_nd",
}

const config = resolveConfig({ linear: LINEAR, maxConcurrentBuilds: 1 })
const config3 = resolveConfig({ linear: LINEAR, maxConcurrentBuilds: 3 })

const REPO = "/repo"

/** Where the fake createWorktree dep puts worktrees. */
const worktreePathFor = (slug: string) => `/worktrees/${slug}`

type Recorder = {
  events: string[]
  deps: KickoffDeps
  specs: Map<string, string>
}

function makeDeps(
  selections: SelectResult | SelectResult[],
  overrides: Partial<KickoffDeps> & {
    buildExists?: Set<string>
    buildResult?: BuildRunResult
  } = {},
): Recorder {
  const queue = Array.isArray(selections) ? [...selections] : [selections]
  const events: string[] = []
  const specs = new Map<string, string>()
  const buildExists = overrides.buildExists ?? new Set<string>()
  const deps: KickoffDeps = {
    runSelect: async () => {
      const next = queue.shift()
      if (!next) throw new Error("runSelect called more times than expected")
      return next
    },
    buildDirExists: (slug) => buildExists.has(slug),
    createWorktree: async ({ slug, branch, base }) => {
      events.push(`createWorktree:slug=${slug}:${branch}:base=${base}`)
      return worktreePathFor(slug)
    },
    writeSpec: (specPath, contents) => {
      events.push(`writeSpec:${specPath}`)
      specs.set(specPath, contents)
    },
    runBuild: async ({ slug, worktreePath }) => {
      // Assert the build can read the spec from its cwd at spawn time.
      const specPath = join(worktreePath, "build", slug, "spec.md")
      events.push(
        `runBuild:slug=${slug}:cwd=${worktreePath}:specPresent=${specs.has(specPath)}`,
      )
      return overrides.buildResult ?? { mode: "detached" }
    },
    log: (m) => events.push(`log:${m}`),
    ...stripHelpers(overrides),
  }
  return { events, deps, specs }
}

function stripHelpers(o: Record<string, unknown>): Partial<KickoffDeps> {
  const { buildExists, buildResult, ...rest } = o
  return rest as Partial<KickoffDeps>
}

function readySelection(n: number, title: string): SelectResult {
  return {
    inProgressCount: n,
    issueId: `DIS-${100 + n}`,
    issueUuid: `uuid-${n}`,
    title,
    brief: `Brief for ${title}.`,
    source: "observations",
  }
}

const ready: SelectResult = {
  inProgressCount: 0,
  issueId: "DIS-123",
  issueUuid: "uuid-1",
  title: "Make Reads Bounded",
  brief: "Several unbounded collects. Paginate them.",
  source: "observations",
}

describe("uniqueSlug", () => {
  test("returns base when free, suffixes on collision", () => {
    expect(uniqueSlug("x", () => false)).toBe("x")
    const taken = new Set(["x", "x-2"])
    expect(uniqueSlug("x", (s) => taken.has(s))).toBe("x-3")
  })
})

describe("kickoff", () => {
  test("nothing ready → exit 0, no worktree", async () => {
    const { events, deps } = makeDeps({ none: true })
    expect(await kickoff(REPO, config, deps)).toBe(0)
    expect(events.some((e) => e.startsWith("createWorktree"))).toBe(false)
  })

  test("at capacity (agent reports it without claiming) → exit 0, no worktree", async () => {
    const { events, deps } = makeDeps({ none: true, atCapacity: true })
    expect(await kickoff(REPO, config, deps)).toBe(0)
    expect(events.some((e) => e.startsWith("createWorktree"))).toBe(false)
    expect(events.some((e) => e.includes("at capacity"))).toBe(true)
  })

  test("agent claims an issue DESPITE capacity → exit 1, names the stranded issue", async () => {
    // By contract a non-none selection means the agent already moved the
    // issue to In-Progress — exiting 0 here would strand it silently.
    const { events, deps } = makeDeps({ ...ready, inProgressCount: 1 })
    expect(await kickoff(REPO, config, deps)).toBe(1)
    expect(events.some((e) => e.startsWith("createWorktree"))).toBe(false)
    expect(
      events.some((e) => e.includes("DIS-123") && e.includes("capacity")),
    ).toBe(true)
  })

  test("select agent failure → exit 3 (nothing claimed — distinct from a stranded claim)", async () => {
    const { events, deps } = makeDeps([], {
      runSelect: async () => {
        throw new Error("select agent exited 1")
      },
    })
    expect(await kickoff(REPO, config, deps)).toBe(3)
    expect(events.some((e) => e.includes("select agent failed"))).toBe(true)
  })

  test("select agent re-returning an issue already launched this run → exit 1, no duplicate build", async () => {
    const again = { ...readySelection(0, "Fix A"), inProgressCount: 1 }
    const { events, deps } = makeDeps([readySelection(0, "Fix A"), again])
    expect(await kickoff(REPO, config3, deps)).toBe(1)
    expect(events.filter((e) => e.startsWith("runBuild"))).toHaveLength(1)
    expect(events.some((e) => e.includes("duplicate"))).toBe(true)
  })

  test("branch contains the lowercased issue id", async () => {
    const { events, deps } = makeDeps(ready)
    await kickoff(REPO, config, deps)
    const wt = events.find((e) => e.startsWith("createWorktree"))
    expect(wt).toContain("kickoff/dis-123-make-reads-bounded")
  })

  test("worktree is based off the canonical base ref, not current HEAD", async () => {
    const { events, deps } = makeDeps(ready)
    await kickoff(REPO, config, deps)
    const wt = events.find((e) => e.startsWith("createWorktree"))
    expect(wt).toContain(`base=${KICKOFF_BASE_REF}`)
  })

  test("ordering + colocation: worktree → spec (in worktree) → build (cwd=worktree, spec present)", async () => {
    const { events, deps } = makeDeps(ready)
    await kickoff(REPO, config, deps)
    const order = events.map((e) => e.split(":")[0])
    const wt = order.indexOf("createWorktree")
    const ws = order.indexOf("writeSpec")
    const rb = order.indexOf("runBuild")
    expect(wt).toBeGreaterThanOrEqual(0)
    expect(wt).toBeLessThan(ws)
    expect(ws).toBeLessThan(rb)

    // Spec + build cwd both use the path RETURNED by createWorktree — the
    // provider owns the path; kickoff must not derive it independently.
    const worktreePath = worktreePathFor("make-reads-bounded")
    const specEvent = events.find((e) => e.startsWith("writeSpec"))
    expect(specEvent).toContain(
      join(worktreePath, "build", "make-reads-bounded", "spec.md"),
    )
    const buildEvent = events.find((e) => e.startsWith("runBuild"))
    expect(buildEvent).toContain(`cwd=${worktreePath}`)
    expect(buildEvent).toContain("specPresent=true")
  })

  test("spec contents are the Linear brief verbatim", async () => {
    const { deps, specs } = makeDeps(ready)
    await kickoff(REPO, config, deps)
    const [contents] = [...specs.values()]
    expect(contents).toContain("Several unbounded collects. Paginate them.")
  })

  test("collision suffixes the slug", async () => {
    const { events, deps } = makeDeps(ready, {
      buildExists: new Set(["make-reads-bounded"]),
    })
    await kickoff(REPO, config, deps)
    const wt = events.find((e) => e.startsWith("createWorktree"))
    expect(wt).toContain("make-reads-bounded-2")
  })

  test("failed launch (worktree throws) → exit 1, logs claimed-but-unbuilt", async () => {
    const { events, deps } = makeDeps(ready, {
      createWorktree: async () => {
        throw new Error("worktree boom")
      },
    })
    expect(await kickoff(REPO, config, deps)).toBe(1)
    expect(
      events.some((e) =>
        e.includes("DIS-123 claimed but build never launched"),
      ),
    ).toBe(true)
    expect(events.some((e) => e.startsWith("runBuild"))).toBe(false)
  })

  test("runBuild throw → exit 1, logged as launch-failed-state-unknown", async () => {
    const { events, deps } = makeDeps(ready, {
      runBuild: async () => {
        throw new Error("terminal create crashed")
      },
    })
    expect(await kickoff(REPO, config, deps)).toBe(1)
    expect(events.some((e) => e.includes("DIS-123 build launch failed"))).toBe(
      true,
    )
  })

  describe("detached fill-to-capacity loop", () => {
    test("keeps claiming + launching until the select agent reports capacity", async () => {
      const { events, deps } = makeDeps([
        readySelection(0, "First Fix"),
        readySelection(1, "Second Fix"),
        { none: true, atCapacity: true },
      ])
      expect(await kickoff(REPO, config3, deps)).toBe(0)
      const launches = events.filter((e) => e.startsWith("runBuild"))
      expect(launches).toHaveLength(2)
      expect(events.some((e) => e.includes("at capacity"))).toBe(true)
    })

    test("stops when nothing more is ready", async () => {
      const { events, deps } = makeDeps([
        readySelection(0, "Only Fix"),
        { none: true },
      ])
      expect(await kickoff(REPO, config3, deps)).toBe(0)
      expect(events.filter((e) => e.startsWith("runBuild"))).toHaveLength(1)
    })

    test("hard-caps launches at maxConcurrentBuilds even if the select agent misbehaves", async () => {
      // Select agent keeps returning ready issues and never reports capacity.
      const { events, deps } = makeDeps([
        readySelection(0, "Fix A"),
        readySelection(1, "Fix B"),
        readySelection(2, "Fix C"),
        readySelection(0, "Fix D"),
        readySelection(1, "Fix E"),
      ])
      expect(await kickoff(REPO, config3, deps)).toBe(0)
      expect(events.filter((e) => e.startsWith("runBuild"))).toHaveLength(3)
    })

    test("a mid-loop failed launch exits 1 (already-launched builds keep running)", async () => {
      let calls = 0
      const { events, deps } = makeDeps(
        [readySelection(0, "Fix A"), readySelection(1, "Fix B")],
        {
          createWorktree: async ({ slug }) => {
            if (++calls === 2) throw new Error("worktree boom")
            return worktreePathFor(slug)
          },
        },
      )
      expect(await kickoff(REPO, config3, deps)).toBe(1)
      expect(
        events.some((e) => e.includes("claimed but build never launched")),
      ).toBe(true)
    })
  })

  describe("synchronous fallback (git provider / no visible launch)", () => {
    test("a sync build's exit code is returned and ends the run (one build per run)", async () => {
      const { events, deps } = makeDeps(
        [readySelection(0, "Only Fix"), readySelection(1, "Never Reached")],
        { buildResult: { mode: "sync", code: 2 } },
      )
      expect(await kickoff(REPO, config3, deps)).toBe(2)
      expect(events.filter((e) => e.startsWith("runBuild"))).toHaveLength(1)
    })
  })
})

describe("parseSelectResult", () => {
  test("accepts a none result and a full ready result", () => {
    expect(parseSelectResult({ none: true, atCapacity: true }, "f")).toEqual({
      none: true,
      atCapacity: true,
    })
    expect(parseSelectResult({ ...ready }, "f")).toEqual(ready)
  })

  test("rejects well-formed JSON with missing/blank required fields", () => {
    expect(() => parseSelectResult({ ...ready, title: "" }, "f")).toThrow(
      /invalid result/,
    )
    const { issueId, ...rest } = ready as Record<string, unknown>
    expect(() => parseSelectResult(rest, "f")).toThrow(/invalid result/)
    expect(() => parseSelectResult(null, "f")).toThrow(/invalid result/)
    expect(() => parseSelectResult({ ...ready, source: "vibes" }, "f")).toThrow(
      /invalid result/,
    )
  })
})

describe("runBuildWithProvider", () => {
  const args = { handle: {}, slug: "s", worktreePath: "/wt/s" }

  test("detached when the provider launches a visible build", async () => {
    const result = await runBuildWithProvider({
      ...args,
      provider: { startVisibleBuild: async () => true },
      headless: async () => {
        throw new Error("headless must not run")
      },
    })
    expect(result).toEqual({ mode: "detached" })
  })

  test("falls back to a sync headless build when visible launch is unavailable or unsupported", async () => {
    expect(
      await runBuildWithProvider({
        ...args,
        provider: { startVisibleBuild: async () => false },
        headless: async () => 2,
      }),
    ).toEqual({ mode: "sync", code: 2 })
    expect(
      await runBuildWithProvider({
        ...args,
        provider: {},
        headless: async () => 0,
      }),
    ).toEqual({ mode: "sync", code: 0 })
  })

  test("propagates a launch throw WITHOUT running headless (state unknown — no blind retry)", async () => {
    let headlessRan = false
    await expect(
      runBuildWithProvider({
        ...args,
        provider: {
          startVisibleBuild: async () => {
            throw new Error("CLI crashed mid-launch")
          },
        },
        headless: async () => {
          headlessRan = true
          return 0
        },
      }),
    ).rejects.toThrow(/crashed/)
    expect(headlessRan).toBe(false)
  })
})
