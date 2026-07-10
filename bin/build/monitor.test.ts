import { describe, expect, test } from "bun:test"
import {
  decideMonitorAction,
  failingCheckNames,
  monitorPr,
  type PrSnapshot,
  type PublishOutcome,
  parsePrSnapshot,
} from "./monitor"

const base: PrSnapshot = {
  state: "OPEN",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  behindBase: false,
  baseFetchOk: true,
  failingChecks: [],
  unresolvedThreads: 0,
}

describe("failingCheckNames", () => {
  test("picks up failing conclusions and states", () => {
    const names = failingCheckNames([
      { name: "build", conclusion: "SUCCESS" },
      { name: "test", conclusion: "FAILURE" },
      { context: "ci/legacy", state: "ERROR" },
      { name: "lint", conclusion: "TIMED_OUT" },
    ])
    expect(names).toEqual(["test", "ci/legacy", "lint"])
  })

  test("empty when everything passed", () => {
    expect(
      failingCheckNames([{ name: "build", conclusion: "SUCCESS" }]),
    ).toEqual([])
  })
})

describe("parsePrSnapshot", () => {
  test("merges gh view JSON with the unresolved count and behind/fetch flags", () => {
    const snap = parsePrSnapshot(
      {
        state: "OPEN",
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        statusCheckRollup: [{ name: "test", conclusion: "FAILURE" }],
      },
      3,
      false,
      true,
    )
    expect(snap).toEqual({
      state: "OPEN",
      mergeable: "MERGEABLE",
      mergeStateStatus: "BLOCKED",
      behindBase: false,
      baseFetchOk: true,
      failingChecks: ["test"],
      unresolvedThreads: 3,
    })
  })

  test("carries behindBase: true through", () => {
    const snap = parsePrSnapshot({ state: "OPEN" }, 0, true, true)
    expect(snap.behindBase).toBe(true)
    expect(snap.baseFetchOk).toBe(true)
  })

  test("carries baseFetchOk: false through", () => {
    const snap = parsePrSnapshot({ state: "OPEN" }, 0, false, false)
    expect(snap.baseFetchOk).toBe(false)
    expect(snap.behindBase).toBe(false)
  })

  test("defaults missing fields to UNKNOWN", () => {
    const snap = parsePrSnapshot({}, 0, false, true)
    expect(snap.state).toBe("UNKNOWN")
    expect(snap.failingChecks).toEqual([])
  })
})

describe("decideMonitorAction", () => {
  test("merged / closed are terminal, carrying the merged flag", () => {
    expect(decideMonitorAction({ ...base, state: "MERGED" })).toEqual({
      kind: "done",
      reason: "PR merged",
      merged: true,
    })
    expect(decideMonitorAction({ ...base, state: "CLOSED" })).toEqual({
      kind: "done",
      reason: "PR closed",
      merged: false,
    })
  })

  test("mergeable + clean + current + no threads is ready (non-terminal)", () => {
    expect(decideMonitorAction(base)).toEqual({ kind: "ready" })
  })

  test("behindBase: true → rebase even when mergeStateStatus is CLEAN", () => {
    expect(decideMonitorAction({ ...base, behindBase: true })).toEqual({
      kind: "rebase",
    })
  })

  test("baseFetchOk: false (otherwise green) → wait, not ready", () => {
    expect(decideMonitorAction({ ...base, baseFetchOk: false })).toEqual({
      kind: "wait",
    })
  })

  test("baseFetchOk: false + behindBase: false does not rebase", () => {
    const action = decideMonitorAction({
      ...base,
      baseFetchOk: false,
      behindBase: false,
    })
    expect(action.kind).not.toBe("rebase")
  })

  test("baseFetchOk: false + mergeStateStatus BEHIND → wait, not rebase", () => {
    // A failed base fetch leaves behindBase:false but GitHub may still report
    // BEHIND. We must NOT rebase (the rebase would re-fail the same fetch and
    // escalate to a human); keep watching on the active cadence instead.
    expect(
      decideMonitorAction({
        ...base,
        baseFetchOk: false,
        behindBase: false,
        mergeStateStatus: "BEHIND",
      }),
    ).toEqual({ kind: "wait" })
  })

  test("behind base (BEHIND) takes priority → rebase", () => {
    expect(
      decideMonitorAction({
        ...base,
        mergeStateStatus: "BEHIND",
        failingChecks: ["test"],
        unresolvedThreads: 2,
      }),
    ).toEqual({ kind: "rebase" })
  })

  test("failing CI before review threads", () => {
    expect(
      decideMonitorAction({
        ...base,
        mergeStateStatus: "BLOCKED",
        failingChecks: ["test"],
        unresolvedThreads: 2,
      }),
    ).toEqual({ kind: "fix-ci", failingChecks: ["test"] })
  })

  test("unresolved threads when CI is green", () => {
    expect(
      decideMonitorAction({
        ...base,
        mergeStateStatus: "BLOCKED",
        unresolvedThreads: 1,
      }),
    ).toEqual({ kind: "address-review" })
  })

  test("waits when blocked but nothing actionable (e.g. CI pending)", () => {
    expect(
      decideMonitorAction({
        ...base,
        mergeable: "UNKNOWN",
        mergeStateStatus: "UNSTABLE",
      }),
    ).toEqual({ kind: "wait" })
  })
})

describe("monitorPr", () => {
  test("acts on blockers, announces ready once, stops only on terminal", async () => {
    const snapshots: PrSnapshot[] = [
      { ...base, behindBase: true }, // rebase
      { ...base, mergeStateStatus: "BLOCKED", failingChecks: ["test"] }, // fix-ci
      { ...base, mergeable: "UNKNOWN", mergeStateStatus: "UNSTABLE" }, // wait
      base, // ready
      { ...base, state: "MERGED" }, // done
    ]
    const acted: string[] = []
    let readyFired = 0
    const result = await monitorPr({
      poll: async () => snapshots.shift() as PrSnapshot,
      act: async (a) => {
        acted.push(a.kind)
      },
      sleep: async () => {},
      activeIntervalMs: 1,
      idleIntervalMs: 1,
      publishArtifacts: () => ({ status: "clean" }),
      onReady: () => {
        readyFired++
      },
    })
    expect(result).toEqual({
      outcome: "done",
      reason: "PR merged",
      merged: true,
    })
    expect(acted).toEqual(["rebase", "fix-ci"])
    expect(readyFired).toBe(1)
  })

  test("a closed (not merged) PR is done with merged:false", async () => {
    const snapshots: PrSnapshot[] = [{ ...base, state: "CLOSED" }]
    const result = await monitorPr({
      poll: async () => snapshots.shift() as PrSnapshot,
      act: async () => {},
      sleep: async () => {},
      activeIntervalMs: 1,
      idleIntervalMs: 1,
      publishArtifacts: () => ({ status: "clean" }),
    })
    expect(result).toEqual({
      outcome: "done",
      reason: "PR closed",
      merged: false,
    })
  })

  test("a publishing push keeps it active; only clean announces", async () => {
    const snapshots: PrSnapshot[] = [base, base, { ...base, state: "MERGED" }]
    const sleeps: number[] = []
    let readyFired = 0
    let publishCalls = 0
    const result = await monitorPr({
      poll: async () => snapshots.shift() as PrSnapshot,
      act: async () => {},
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      activeIntervalMs: 45,
      idleIntervalMs: 180,
      publishArtifacts: () => {
        publishCalls++
        return publishCalls === 1
          ? ({ status: "pushed" } as PublishOutcome)
          : ({ status: "clean" } as PublishOutcome)
      },
      onReady: () => {
        readyFired++
      },
    })
    expect(result.outcome).toBe("done")
    // first ready: pushed → active sleep, no announce
    expect(sleeps[0]).toBe(45)
    // second ready: clean → announce once, idle sleep
    expect(sleeps[1]).toBe(180)
    expect(readyFired).toBe(1)
  })

  test("a transient failed publish never announces, self-heals on clean, no escalation", async () => {
    const snapshots: PrSnapshot[] = [base, base, { ...base, state: "MERGED" }]
    const sleeps: number[] = []
    let readyFired = 0
    let publishCalls = 0
    const result = await monitorPr({
      poll: async () => snapshots.shift() as PrSnapshot,
      act: async () => {},
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      activeIntervalMs: 45,
      idleIntervalMs: 180,
      maxPublishFailures: 10,
      publishArtifacts: () => {
        publishCalls++
        return publishCalls === 1
          ? ({ status: "failed", detail: "push rejected" } as PublishOutcome)
          : ({ status: "clean" } as PublishOutcome)
      },
      onReady: () => {
        readyFired++
      },
    })
    expect(result.outcome).toBe("done")
    expect(sleeps[0]).toBe(45) // failed → active
    expect(sleeps[1]).toBe(180) // clean → idle
    expect(readyFired).toBe(1)
  })

  test("repeated failed publishes give up with the failure detail", async () => {
    let readyFired = 0
    const sleeps: number[] = []
    const result = await monitorPr({
      poll: async () => base,
      act: async () => {},
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      activeIntervalMs: 45,
      idleIntervalMs: 180,
      maxPublishFailures: 3,
      publishArtifacts: () => ({
        status: "failed",
        detail: "credentials rejected",
      }),
      onReady: () => {
        readyFired++
      },
    })
    expect(result.outcome).toBe("gave-up")
    expect(result.reason).toContain("credentials rejected")
    expect(readyFired).toBe(0)
    expect(sleeps.every((ms) => ms === 45)).toBe(true)
  })

  test("a pushed between failures resets the publish-failure streak", async () => {
    const snapshots: PrSnapshot[] = [
      base,
      base,
      base,
      base,
      base,
      base,
      { ...base, state: "MERGED" },
    ]
    const outcomes: PublishOutcome[] = [
      { status: "failed", detail: "x" },
      { status: "failed", detail: "x" },
      { status: "pushed" },
      { status: "failed", detail: "x" },
      { status: "failed", detail: "x" },
      { status: "clean" },
    ]
    let readyFired = 0
    let i = 0
    const result = await monitorPr({
      poll: async () => snapshots.shift() as PrSnapshot,
      act: async () => {},
      sleep: async () => {},
      activeIntervalMs: 1,
      idleIntervalMs: 1,
      maxPublishFailures: 3,
      publishArtifacts: () => outcomes[i++] as PublishOutcome,
      onReady: () => {
        readyFired++
      },
    })
    expect(result.outcome).toBe("done")
    expect(readyFired).toBe(1)
  })

  test("ready is non-terminal, keeps polling at idle cadence", async () => {
    const snapshots: PrSnapshot[] = [
      base,
      base,
      base,
      { ...base, state: "MERGED" },
    ]
    const sleeps: number[] = []
    let readyFired = 0
    const result = await monitorPr({
      poll: async () => snapshots.shift() as PrSnapshot,
      act: async () => {},
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      activeIntervalMs: 45,
      idleIntervalMs: 180,
      publishArtifacts: () => ({ status: "clean" }),
      onReady: () => {
        readyFired++
      },
    })
    expect(result.outcome).toBe("done")
    expect(sleeps.slice(0, 3)).toEqual([180, 180, 180])
    expect(readyFired).toBe(1)
  })

  test("repeated idle-ready polls cause no repeated publish / no CI rerun", async () => {
    const snapshots: PrSnapshot[] = [
      base,
      base,
      base,
      base,
      base,
      { ...base, state: "MERGED" },
    ]
    const sleeps: number[] = []
    const publishResults: string[] = []
    let readyFired = 0
    let dirty = true
    await monitorPr({
      poll: async () => snapshots.shift() as PrSnapshot,
      act: async () => {},
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      activeIntervalMs: 45,
      idleIntervalMs: 180,
      publishArtifacts: () => {
        if (dirty) {
          dirty = false
          publishResults.push("pushed")
          return { status: "pushed" }
        }
        publishResults.push("clean")
        return { status: "clean" }
      },
      onReady: () => {
        readyFired++ // models the bell-only callback: writes nothing → no dirty
      },
    })
    expect(publishResults.filter((r) => r === "pushed").length).toBe(1)
    expect(publishResults.slice(1).every((r) => r === "clean")).toBe(true)
    expect(readyFired).toBe(1)
    // first ready was a "pushed" → active; all later ready polls idled
    expect(sleeps[0]).toBe(45)
    expect(sleeps.slice(1).every((ms) => ms === 180)).toBe(true)
  })

  test("convergence budget resets on ready, ignores rebase/wait/publish", async () => {
    // fix-ci, fix-ci, ready (reset), fix-ci, fix-ci, MERGED — never 3 in a row.
    const snapshots: PrSnapshot[] = [
      { ...base, mergeStateStatus: "BLOCKED", failingChecks: ["t"] },
      { ...base, mergeStateStatus: "BLOCKED", failingChecks: ["t"] },
      base, // ready resets
      { ...base, mergeStateStatus: "BLOCKED", failingChecks: ["t"] },
      { ...base, mergeStateStatus: "BLOCKED", failingChecks: ["t"] },
      { ...base, state: "MERGED" },
    ]
    let warned = 0
    const result = await monitorPr({
      poll: async () => snapshots.shift() as PrSnapshot,
      act: async () => {},
      sleep: async () => {},
      activeIntervalMs: 1,
      idleIntervalMs: 1,
      publishArtifacts: () => ({ status: "clean" }),
      softBudgetPasses: 3,
      onSoftBudget: () => {
        warned++
      },
    })
    expect(result.outcome).toBe("done")
    expect(warned).toBe(0)
  })

  test("gives up after maxConvergencePasses consecutive fix attempts", async () => {
    const result = await monitorPr({
      poll: async () => ({
        ...base,
        mergeStateStatus: "BLOCKED",
        failingChecks: ["test"],
      }),
      act: async () => {},
      sleep: async () => {},
      activeIntervalMs: 1,
      maxConvergencePasses: 3,
    })
    expect(result.outcome).toBe("gave-up")
    expect(result.reason).toContain("fix attempts")
  })

  test("soft budget fires on fix attempts, not idle-ready", async () => {
    const snapshots: PrSnapshot[] = [
      { ...base, mergeStateStatus: "BLOCKED", failingChecks: ["t"] },
      { ...base, mergeStateStatus: "BLOCKED", failingChecks: ["t"] },
      base, // ready
      { ...base, state: "MERGED" },
    ]
    let warned = 0
    await monitorPr({
      poll: async () => snapshots.shift() as PrSnapshot,
      act: async () => {},
      sleep: async () => {},
      activeIntervalMs: 1,
      idleIntervalMs: 1,
      publishArtifacts: () => ({ status: "clean" }),
      softBudgetPasses: 2,
      onSoftBudget: () => {
        warned++
      },
    })
    expect(warned).toBe(1)

    // idle-ready forever-until-merged: warns 0.
    const idleSnapshots: PrSnapshot[] = [
      base,
      base,
      base,
      { ...base, state: "MERGED" },
    ]
    let idleWarned = 0
    await monitorPr({
      poll: async () => idleSnapshots.shift() as PrSnapshot,
      act: async () => {},
      sleep: async () => {},
      activeIntervalMs: 1,
      idleIntervalMs: 1,
      publishArtifacts: () => ({ status: "clean" }),
      softBudgetPasses: 2,
      onSoftBudget: () => {
        idleWarned++
      },
    })
    expect(idleWarned).toBe(0)
  })

  test("onReady re-fires on re-entry into ready", async () => {
    const snapshots: PrSnapshot[] = [
      base, // ready (announce 1)
      { ...base, behindBase: true }, // rebase → leaves ready
      base, // ready (announce 2)
      { ...base, state: "MERGED" },
    ]
    let readyFired = 0
    const result = await monitorPr({
      poll: async () => snapshots.shift() as PrSnapshot,
      act: async () => {},
      sleep: async () => {},
      activeIntervalMs: 1,
      idleIntervalMs: 1,
      publishArtifacts: () => ({ status: "clean" }),
      onReady: () => {
        readyFired++
      },
    })
    expect(result.outcome).toBe("done")
    expect(readyFired).toBe(2)
  })
})
