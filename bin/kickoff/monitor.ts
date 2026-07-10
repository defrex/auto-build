/**
 * Pure, dependency-free loop infrastructure for kickoff's monitor mode.
 *
 * This module imports NOTHING from `kickoff.ts` (one-way dependency:
 * `kickoff.ts → monitor.ts`), so the loop stays trivially unit-testable and
 * there is no import cycle. The production wiring (signals, real timers, the
 * lock + pass lifecycle) lives in `kickoff.ts`; everything here is injectable.
 */

/** The result of one monitor pass: a skipped tick (lock contention) or the
 * `kickoff()` exit code. */
export type PassOutcome = { skipped: true } | { code: number }

/** Everything `monitorLoop` needs, injected so the loop touches no real timer,
 * signal, lock, or `kickoff()` — making it unit-testable. */
export type MonitorDeps = {
  /** Run exactly one kickoff pass (acquire lock → kickoff → release). */
  runPass: () => Promise<PassOutcome>
  /** Sleep for `ms`; in production this is interruptible by a signal. */
  sleep: (ms: number) => Promise<void>
  /** Whether a shutdown signal has been requested. */
  shouldStop: () => boolean
  /** Current time (injected so tests can pin a fixed clock). */
  now: () => Date
  /** Interval between passes, in milliseconds. */
  intervalMs: number
  /** Heartbeat sink (stdout in production). */
  log: (message: string) => void
}

/** Default monitor interval when `KICKOFF_MONITOR_INTERVAL_SECONDS` is unset. */
export const DEFAULT_MONITOR_INTERVAL_SECONDS = 300

/** `--watch` / `--monitor` enables the long-running daemon. */
export function isMonitorMode(argv: string[]): boolean {
  return argv.includes("--watch") || argv.includes("--monitor")
}

/**
 * Resolve the monitor interval from the environment. Falls back to the default
 * for unset/empty/invalid/non-positive values (a bad env var must not wedge the
 * daemon into a zero or negative sleep).
 */
export function resolveMonitorIntervalMs(
  env: Record<string, string | undefined>,
): number {
  const raw = env.KICKOFF_MONITOR_INTERVAL_SECONDS
  const seconds = raw === undefined || raw === "" ? Number.NaN : Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  return DEFAULT_MONITOR_INTERVAL_SECONDS * 1000
}

/** Heartbeat text describing one pass outcome (logged each wake). */
export function describePassOutcome(outcome: PassOutcome): string {
  if ("skipped" in outcome) {
    return "another pass holds the lock — skipping this tick"
  }
  switch (outcome.code) {
    case 0:
      return "pass exited 0 (filled what it could / nothing ready)"
    case 1:
      return "pass exited 1 (an issue was claimed but its build never launched — stranded In-Progress, bounce it back to Triage by hand)"
    case 2:
      return "pass exited 2 (a synchronous fallback build failed)"
    case 3:
      return "pass exited 3 (the select agent failed — nothing new claimed; next tick may retry)"
    default:
      return `pass exited ${outcome.code}`
  }
}

/**
 * The monitor loop: run one pass, then sleep, indefinitely, until a shutdown
 * signal is requested. Continues on every outcome (skip or any exit code) and
 * on a thrown pass — a transient failure must not kill the daemon.
 *
 * Both `shouldStop()` checks are load-bearing:
 *  - CHECK B (post-pass) catches a signal that arrived mid-pass: the in-flight
 *    pass finishes, then we exit WITHOUT sleeping.
 *  - CHECK A (top-of-loop) catches a signal that arrived during sleep: the
 *    interruptible `sleep` resolves early and we exit before another pass.
 */
export async function monitorLoop(deps: MonitorDeps): Promise<void> {
  const { runPass, sleep, shouldStop, now, intervalMs, log } = deps
  while (!shouldStop()) {
    // CHECK A
    let summary: string
    try {
      summary = describePassOutcome(await runPass())
    } catch (err) {
      summary = `pass threw — continuing: ${(err as Error).message}`
    }
    if (shouldStop()) {
      // CHECK B
      log(`${summary}; shutting down`)
      return
    }
    const nextWake = new Date(now().getTime() + intervalMs)
    log(`${summary}; next wake ${nextWake.toISOString()}`)
    await sleep(intervalMs)
  }
  log("shutdown requested before first pass — exiting")
}
