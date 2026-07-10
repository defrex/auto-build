import { describe, expect, test } from "bun:test"
import { buildCommonProperties } from "../analytics/common-properties"
import {
  type AnalyticsSink,
  type CaptureArgs,
  createPipelineAnalytics,
} from "../analytics/pipeline-analytics"
import { resolveConfig } from "./config"
import { type KickoffDeps, kickoff, type SelectResult } from "./kickoff"

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

function recording() {
  const events: CaptureArgs[] = []
  const sink: AnalyticsSink = {
    capture: (a) => events.push(a),
    shutdown: async () => {},
  }
  const analytics = createPipelineAnalytics({
    common: buildCommonProperties({
      process: "kickoff",
      repoRoot: REPO,
      env: {} as NodeJS.ProcessEnv,
      worktreeProvider: "git",
    }),
    distinctId: "op@x.com",
    sink,
  })
  return { analytics, events }
}

function readySelection(n: number, issueId: string): SelectResult {
  return {
    inProgressCount: n,
    issueId,
    issueUuid: `uuid-${issueId}`,
    title: `Title ${issueId}`,
    brief: "brief",
    source: "observations",
  }
}

function makeDeps(
  selections: SelectResult[],
  overrides: Partial<KickoffDeps> = {},
): KickoffDeps {
  const queue = [...selections]
  return {
    runSelect: async () => {
      const next = queue.shift()
      if (!next) throw new Error("runSelect called more than expected")
      return next
    },
    buildDirExists: () => false,
    deriveSlug: async ({ title }) => ({
      slug: title.toLowerCase().replace(/\s+/g, "-"),
      usedFallback: false,
      model: "test-model",
      durationMs: 5,
    }),
    createWorktree: async ({ slug }) => `/worktrees/${slug}`,
    writeSpec: () => {},
    writeIdentity: () => {},
    runBuild: async () => ({ mode: "detached" }),
    log: () => {},
    ...overrides,
  }
}

const names = (events: CaptureArgs[]) => events.map((e) => e.event)
const find = (events: CaptureArgs[], event: string) =>
  events.find((e) => e.event === event)

describe("kickoff analytics", () => {
  test("nothing-ready: pass_started (null count) + pass_completed outcome", async () => {
    const { analytics, events } = recording()
    await kickoff(REPO, config, makeDeps([{ none: true }]), {
      analytics,
      mode: "single",
    })
    expect(names(events)).toEqual([
      "kickoff_pass_started",
      "kickoff_pass_completed",
    ])
    const started = find(events, "kickoff_pass_started")
    expect(started?.properties.in_progress_count).toBeNull()
    expect(started?.properties.mode).toBe("single")
    const completed = find(events, "kickoff_pass_completed")
    expect(completed?.properties.outcome).toBe("nothing-ready")
    expect(completed?.properties.exit_code).toBe(0)
  })

  test("at-capacity none → outcome at-capacity", async () => {
    const { analytics, events } = recording()
    await kickoff(REPO, config, makeDeps([{ none: true, atCapacity: true }]), {
      analytics,
    })
    expect(find(events, "kickoff_pass_completed")?.properties.outcome).toBe(
      "at-capacity",
    )
  })

  test("claim + detached launch emits the full per-issue sequence", async () => {
    const { analytics, events } = recording()
    await kickoff(REPO, config, makeDeps([readySelection(0, "PRO-1")]), {
      analytics,
    })
    expect(names(events)).toEqual([
      "kickoff_pass_started",
      "kickoff_issue_claimed",
      "kickoff_slug_derived",
      "kickoff_worktree_created",
      "kickoff_build_launched",
      "kickoff_pass_completed",
    ])
    const claimed = find(events, "kickoff_issue_claimed")
    expect(claimed?.properties.issue_id).toBe("PRO-1")
    expect(claimed?.properties.source).toBe("observations")
    // slug/branch not yet derived → PRESENT and null.
    expect("branch" in (claimed?.properties ?? {})).toBe(true)
    expect(claimed?.properties.branch).toBeNull()
    expect(claimed?.properties.slug).toBeNull()
    // issue_id real → build group attached on the claim.
    expect(claimed?.groups).toEqual({ build: "PRO-1" })

    const slug = find(events, "kickoff_slug_derived")
    expect(slug?.properties.used_fallback).toBe(false)
    expect(slug?.properties.model).toBe("test-model")
    expect(typeof slug?.properties.slug).toBe("string")

    const wt = find(events, "kickoff_worktree_created")
    expect(wt?.properties.provider).toBe("git")
    expect(wt?.properties.success).toBe(true)

    const launched = find(events, "kickoff_build_launched")
    expect(launched?.properties.launch_mode).toBe("detached")

    const completed = find(events, "kickoff_pass_completed")
    expect(completed?.properties.outcome).toBe("launched")
    expect(completed?.properties.launched_count).toBe(1)
  })

  test("sync build counts toward launched_count (no detached undercount)", async () => {
    const { analytics, events } = recording()
    const code = await kickoff(
      REPO,
      config,
      makeDeps([readySelection(0, "PRO-7")], {
        runBuild: async () => ({ mode: "sync", code: 0 }),
      }),
      { analytics },
    )
    expect(code).toBe(0)
    const launched = find(events, "kickoff_build_launched")
    expect(launched?.properties.launch_mode).toBe("sync")
    const completed = find(events, "kickoff_pass_completed")
    expect(completed?.properties.outcome).toBe("launched")
    expect(completed?.properties.launched_count).toBe(1)
  })

  test("sync build emits launched at the SPAWN point, before runBuild resolves", async () => {
    const { analytics, events } = recording()
    // A sync runBuild that blocks until "build completion", calling onLaunch at
    // the spawn point. The launched event must be queued BEFORE the block ends —
    // otherwise a stalled/killed sync build leaves no launched event and
    // duration_ms degrades into build runtime.
    let launchedAtSpawn = false
    const code = await kickoff(
      REPO,
      config,
      makeDeps([readySelection(0, "PRO-8")], {
        runBuild: async ({ onLaunch }) => {
          onLaunch?.("sync")
          // The launched event must already be recorded at this point (spawn),
          // well before this promise resolves with the build's exit code.
          launchedAtSpawn = events.some(
            (e) => e.event === "kickoff_build_launched",
          )
          return { mode: "sync", code: 0 }
        },
      }),
      { analytics },
    )
    expect(code).toBe(0)
    expect(launchedAtSpawn).toBe(true)
    const launched = find(events, "kickoff_build_launched")
    expect(launched?.properties.launch_mode).toBe("sync")
    // Not double-counted: the post-resolve fallback no-ops once onLaunch fired.
    expect(
      events.filter((e) => e.event === "kickoff_build_launched"),
    ).toHaveLength(1)
  })

  test("pass-level events: keys present, null, no build group", async () => {
    const { analytics, events } = recording()
    await kickoff(REPO, config, makeDeps([{ none: true }]), { analytics })
    for (const e of events) {
      expect("issue_id" in e.properties).toBe(true)
      expect(e.properties.issue_id).toBeNull()
      expect("branch" in e.properties).toBe(true)
      expect(e.properties.branch).toBeNull()
      expect(e.groups).toBeUndefined()
    }
  })

  test("every event carries tooling_sha + worktree_provider keys", async () => {
    const { analytics, events } = recording()
    await kickoff(REPO, config, makeDeps([readySelection(0, "PRO-2")]), {
      analytics,
    })
    expect(events.length).toBeGreaterThan(0)
    for (const e of events) {
      expect("tooling_sha" in e.properties).toBe(true)
      expect("worktree_provider" in e.properties).toBe(true)
    }
  })

  test("duplicate re-return does NOT emit a second claim", async () => {
    const { analytics, events } = recording()
    const sel = readySelection(0, "PRO-3")
    await kickoff(REPO, config3, makeDeps([sel, sel]), { analytics })
    const claims = events.filter((e) => e.event === "kickoff_issue_claimed")
    expect(claims).toHaveLength(1)
    expect(find(events, "kickoff_pass_completed")?.properties.outcome).toBe(
      "duplicate",
    )
  })

  test("claimed-but-stranded over capacity emits claim BEFORE at-capacity completed", async () => {
    const { analytics, events } = recording()
    // inProgressCount (3) >= maxConcurrentBuilds (3) → stranded.
    await kickoff(REPO, config3, makeDeps([readySelection(3, "PRO-4")]), {
      analytics,
    })
    const claimIdx = names(events).indexOf("kickoff_issue_claimed")
    const completedIdx = names(events).indexOf("kickoff_pass_completed")
    expect(claimIdx).toBeGreaterThanOrEqual(0)
    expect(claimIdx).toBeLessThan(completedIdx)
    const completed = find(events, "kickoff_pass_completed")
    expect(completed?.properties.outcome).toBe("at-capacity")
    expect(completed?.properties.at_capacity_stranded).toBe(true)
    expect(completed?.properties.exit_code).toBe(1)
  })

  test("worktree failure → success:false + outcome worktree-fail", async () => {
    const { analytics, events } = recording()
    await kickoff(
      REPO,
      config,
      makeDeps([readySelection(0, "PRO-5")], {
        createWorktree: async () => {
          throw new Error("gwt boom")
        },
      }),
      { analytics },
    )
    expect(find(events, "kickoff_worktree_created")?.properties.success).toBe(
      false,
    )
    expect(find(events, "kickoff_pass_completed")?.properties.outcome).toBe(
      "worktree-fail",
    )
  })

  test("select-crash still emits pass_started (once) then select-crash", async () => {
    const { analytics, events } = recording()
    await kickoff(
      REPO,
      config,
      makeDeps([], {
        runSelect: async () => {
          throw new Error("select down")
        },
      }),
      { analytics },
    )
    expect(names(events)).toEqual([
      "kickoff_pass_started",
      "kickoff_pass_completed",
    ])
    expect(
      find(events, "kickoff_pass_started")?.properties.in_progress_count,
    ).toBeNull()
    expect(find(events, "kickoff_pass_completed")?.properties.outcome).toBe(
      "select-crash",
    )
  })

  test("a thrown sink never breaks the pass (best-effort)", async () => {
    const throwing = createPipelineAnalytics({
      common: buildCommonProperties({
        process: "kickoff",
        repoRoot: REPO,
        env: {} as NodeJS.ProcessEnv,
        worktreeProvider: "git",
      }),
      distinctId: "op@x.com",
      sink: {
        capture: () => {
          throw new Error("sink boom")
        },
        shutdown: async () => {},
      },
    })
    const code = await kickoff(
      REPO,
      config,
      makeDeps([readySelection(0, "PRO-6")]),
      { analytics: throwing },
    )
    expect(code).toBe(0)
  })
})
