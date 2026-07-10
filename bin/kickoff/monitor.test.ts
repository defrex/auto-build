import { describe, expect, test } from "bun:test"
import {
  DEFAULT_MONITOR_INTERVAL_SECONDS,
  describePassOutcome,
  isMonitorMode,
  type MonitorDeps,
  monitorLoop,
  type PassOutcome,
  resolveMonitorIntervalMs,
} from "./monitor"

describe("isMonitorMode", () => {
  test("--watch enables monitor mode", () => {
    expect(isMonitorMode(["bun", "kickoff.ts", "--watch"])).toBe(true)
  })
  test("--monitor alias enables monitor mode", () => {
    expect(isMonitorMode(["bun", "kickoff.ts", "--monitor"])).toBe(true)
  })
  test("no flag → one-shot", () => {
    expect(isMonitorMode(["bun", "kickoff.ts"])).toBe(false)
  })
})

describe("resolveMonitorIntervalMs", () => {
  test("default when unset", () => {
    expect(resolveMonitorIntervalMs({})).toBe(
      DEFAULT_MONITOR_INTERVAL_SECONDS * 1000,
    )
    expect(resolveMonitorIntervalMs({})).toBe(300_000)
  })
  test("honors a valid override", () => {
    expect(
      resolveMonitorIntervalMs({ KICKOFF_MONITOR_INTERVAL_SECONDS: "60" }),
    ).toBe(60_000)
  })
  test("empty string falls back to default", () => {
    expect(
      resolveMonitorIntervalMs({ KICKOFF_MONITOR_INTERVAL_SECONDS: "" }),
    ).toBe(300_000)
  })
  test("invalid / non-positive values fall back to default", () => {
    for (const v of ["abc", "0", "-5"]) {
      expect(
        resolveMonitorIntervalMs({ KICKOFF_MONITOR_INTERVAL_SECONDS: v }),
      ).toBe(300_000)
    }
  })
})

describe("describePassOutcome", () => {
  test("skip mentions lock / skipping", () => {
    const s = describePassOutcome({ skipped: true })
    expect(s.toLowerCase()).toContain("lock")
    expect(s.toLowerCase()).toContain("skip")
  })
  test("code 0 mentions the code", () => {
    expect(describePassOutcome({ code: 0 })).toContain("0")
  })
  test("code 1 mentions stranded / bounce", () => {
    expect(describePassOutcome({ code: 1 }).toLowerCase()).toMatch(
      /strand|bounce/,
    )
  })
  test("code 2 mentions sync build failure", () => {
    expect(describePassOutcome({ code: 2 }).toLowerCase()).toContain("build")
  })
  test("code 3 mentions the select agent / retry", () => {
    expect(describePassOutcome({ code: 3 }).toLowerCase()).toMatch(
      /select|retry/,
    )
  })
  test("an unexpected code falls through to the generic arm", () => {
    expect(describePassOutcome({ code: 42 })).toContain("42")
  })
})

// --- monitorLoop --------------------------------------------------------

/** A controllable harness over MonitorDeps for the loop tests. */
function makeController(opts: {
  outcomes?: PassOutcome[]
  /** stop once `passCount >= stopAfterPasses` (checked by shouldStop). */
  stopAfterPasses?: number
  /** stop once `sleepCount >= stopAfterSleeps` (checked by shouldStop). */
  stopAfterSleeps?: number
  /** custom runPass overriding the queue. */
  runPass?: () => Promise<PassOutcome>
  /** called on each sleep with the running sleep count. */
  onSleep?: (sleepCount: number) => void
  now?: Date
  intervalMs?: number
}): {
  deps: MonitorDeps
  log: string[]
  passCount: () => number
  sleepCount: () => number
} {
  const queue = [...(opts.outcomes ?? [])]
  const log: string[] = []
  let passes = 0
  let sleeps = 0
  let stop = false

  const runPass =
    opts.runPass ??
    (async () => {
      passes++
      const next = queue.shift()
      if (!next) throw new Error("runPass called more than expected")
      return next
    })

  const deps: MonitorDeps = {
    runPass: async () => {
      if (opts.runPass) {
        passes++
        return opts.runPass()
      }
      return runPass()
    },
    sleep: async (_ms) => {
      sleeps++
      opts.onSleep?.(sleeps)
      if (opts.stopAfterSleeps && sleeps >= opts.stopAfterSleeps) stop = true
    },
    shouldStop: () => {
      if (stop) return true
      if (opts.stopAfterPasses && passes >= opts.stopAfterPasses) return true
      return false
    },
    now: () => opts.now ?? new Date("2026-06-19T00:00:00.000Z"),
    intervalMs: opts.intervalMs ?? 300_000,
    log: (m) => log.push(m),
  }
  // Expose a setter for stop via runPass side effects (test case 5).
  ;(deps as unknown as { __setStop: () => void }).__setStop = () => {
    stop = true
  }
  return { deps, log, passCount: () => passes, sleepCount: () => sleeps }
}

describe("monitorLoop", () => {
  test("repeats pass → sleep until stop, with exact counts and ordering", async () => {
    const N = 3
    const order: string[] = []
    const ctl = makeController({
      outcomes: [{ code: 0 }, { code: 0 }, { code: 0 }],
      stopAfterSleeps: N,
      onSleep: () => order.push("sleep"),
    })
    const origRunPass = ctl.deps.runPass
    ctl.deps.runPass = async () => {
      order.push("pass")
      return origRunPass()
    }
    await monitorLoop(ctl.deps)
    expect(ctl.passCount()).toBe(N)
    expect(ctl.sleepCount()).toBe(N)
    expect(order).toEqual(["pass", "sleep", "pass", "sleep", "pass", "sleep"])
  })

  test("continues on every exit code", async () => {
    const ctl = makeController({
      outcomes: [{ code: 0 }, { code: 1 }, { code: 2 }, { code: 3 }],
      stopAfterSleeps: 4,
    })
    await monitorLoop(ctl.deps)
    expect(ctl.passCount()).toBe(4)
    expect(ctl.sleepCount()).toBe(4)
  })

  test("skip on lock contention still logs a heartbeat and sleeps", async () => {
    const ctl = makeController({
      outcomes: [{ skipped: true }],
      stopAfterSleeps: 1,
    })
    await monitorLoop(ctl.deps)
    expect(ctl.passCount()).toBe(1)
    expect(ctl.sleepCount()).toBe(1)
    expect(ctl.log.some((l) => l.toLowerCase().includes("lock"))).toBe(true)
  })

  test("stop during sleep → exactly one pass, no extra pass", async () => {
    const ctl = makeController({
      outcomes: [{ code: 0 }, { code: 0 }],
      stopAfterSleeps: 1,
    })
    await monitorLoop(ctl.deps)
    expect(ctl.passCount()).toBe(1)
    expect(ctl.sleepCount()).toBe(1)
  })

  test("stop mid-pass → in-flight pass finishes, no trailing sleep", async () => {
    // The 2nd pass flips the stop flag BEFORE resolving — simulating a signal
    // that arrives mid-pass. The loop must let that pass finish (passCount 2),
    // then exit at CHECK B without sleeping again (sleepCount 1). The
    // `setStop.fn` indirection lets runPass reach the controller's stop setter,
    // which is created after the deps object exists.
    let passes = 0
    const setStop = { fn: () => {} }
    const ctl = makeController({
      runPass: async () => {
        passes++
        if (passes === 2) setStop.fn() // flip stop before resolving the 2nd pass
        return { code: 0 }
      },
    })
    setStop.fn = (ctl.deps as unknown as { __setStop: () => void }).__setStop
    await monitorLoop(ctl.deps)
    expect(ctl.passCount()).toBe(2)
    expect(ctl.sleepCount()).toBe(1)
    expect(ctl.log.some((l) => l.toLowerCase().includes("shutting down"))).toBe(
      true,
    )
  })

  test("runPass throws → loop logs and continues", async () => {
    let passes = 0
    const ctl = makeController({
      runPass: async () => {
        passes++
        if (passes === 1) throw new Error("transient boom")
        return { code: 0 }
      },
      stopAfterSleeps: 2,
    })
    await monitorLoop(ctl.deps)
    expect(ctl.passCount()).toBe(2)
    expect(ctl.log.some((l) => l.toLowerCase().includes("boom"))).toBe(true)
  })

  test("heartbeat includes the next wake time", async () => {
    const now = new Date("2026-06-19T00:00:00.000Z")
    const ctl = makeController({
      outcomes: [{ code: 0 }],
      stopAfterSleeps: 1,
      now,
      intervalMs: 300_000,
    })
    await monitorLoop(ctl.deps)
    const nextWake = new Date(now.getTime() + 300_000).toISOString()
    expect(ctl.log.some((l) => l.includes(nextWake))).toBe(true)
  })

  test("shutdown requested before first pass → exits without a pass", async () => {
    const ctl = makeController({ outcomes: [], stopAfterPasses: 0 })
    // Force stop true from the start.
    ;(ctl.deps as unknown as { __setStop: () => void }).__setStop()
    await monitorLoop(ctl.deps)
    expect(ctl.passCount()).toBe(0)
    expect(ctl.sleepCount()).toBe(0)
  })
})
