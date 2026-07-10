/**
 * Liveness heartbeat for the build orchestrator.
 *
 * `state.json.updatedAt` only advances at phase boundaries, so it goes stale for
 * minutes during the monitor phase's long idle sleep (`IDLE_POLL_MS = 180_000`).
 * That makes time-of-death un-recoverable and can't tell a live-but-idle run from
 * a dead one. This heartbeat rewrites `heartbeat.json` on a fast (15 s) interval —
 * well under the idle poll — so a relaunch can (a) recover the approximate time
 * of death and (b) distinguish a genuinely-dead prior run from a live concurrent
 * one via `isHeartbeatStale`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** Heartbeat tick cadence — well under the monitor's `IDLE_POLL_MS = 180_000`. */
export const HEARTBEAT_INTERVAL_MS = 15_000

/**
 * A heartbeat older than this (or missing) means the writer is dead. 4 intervals
 * (60 s) tolerates one or two missed ticks from GC pauses / scheduler jitter
 * without false-positive "dead" calls on a live run.
 */
export const HEARTBEAT_STALE_MS = 4 * HEARTBEAT_INTERVAL_MS

/** One heartbeat record: the writer's ISO timestamp and pid. */
export type Heartbeat = { ts: string; pid: number }

/**
 * Absolute path to a build dir's `heartbeat.json`, under the gitignored
 * `.build/` scratch dir. Transient timer state must not be git-visible: the
 * monitor's publish-before-ready pass stages `build/<feature>`, so a tracked
 * heartbeat rewritten every 15 s made the tree perpetually dirty and produced a
 * commit + push (+ CI run) every idle pass (PRO-667). `.build/` is gitignored,
 * so `git add build/<feature>` never stages it and idle passes are no-ops.
 */
export function heartbeatPath(buildDir: string): string {
  return join(buildDir, ".build", "heartbeat.json")
}

/**
 * The pre-PRO-667 tracked location (`build/<feature>/heartbeat.json`). Retained
 * only for the transitional autopsy fallback (so a build that was mid-run when
 * the move shipped still yields an accurate time-of-death) and the one-time
 * convergence removal that untracks it. New writes go through `heartbeatPath`.
 */
export function legacyHeartbeatPath(buildDir: string): string {
  return join(buildDir, "heartbeat.json")
}

/**
 * Write a heartbeat record to `path`, creating the dir if needed. Best-effort:
 * a write failure never throws (liveness recording must never take the run down).
 */
export function writeHeartbeat(path: string, hb: Heartbeat): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(hb)}\n`)
  } catch {
    // Best-effort liveness; never throw.
  }
}

/** Read + parse `heartbeat.json`, or `null` when missing / corrupt. */
export function readHeartbeat(path: string): Heartbeat | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    if (
      parsed &&
      typeof parsed.ts === "string" &&
      typeof parsed.pid === "number"
    ) {
      return { ts: parsed.ts, pid: parsed.pid }
    }
    return null
  } catch {
    return null
  }
}

/** Handle returned by `startHeartbeat` — `stop()` is idempotent. */
export type HeartbeatHandle = { stop(): void }

/**
 * Start writing a heartbeat immediately, then rewrite `{ ts: now(), pid }` every
 * `intervalMs`. The interval is deliberately NOT `.unref()`ed — it must keep the
 * process alive and ticking through the monitor's long idle `await sleep`. Since
 * `run()` is called directly by unit tests, callers MUST `stop()` (via a
 * `finally` / pre-return) or the live interval would hang the test runner.
 */
export function startHeartbeat(args: {
  path: string
  now: () => string
  pid?: number
  intervalMs?: number
}): HeartbeatHandle {
  const pid = args.pid ?? process.pid
  const intervalMs = args.intervalMs ?? HEARTBEAT_INTERVAL_MS
  writeHeartbeat(args.path, { ts: args.now(), pid })
  const timer = setInterval(() => {
    writeHeartbeat(args.path, { ts: args.now(), pid })
  }, intervalMs)
  let stopped = false
  return {
    stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
    },
  }
}

/**
 * The relaunch freshness gate. Returns `true` (writer is dead ⇒ run the autopsy)
 * when the heartbeat is missing, has an unparseable `ts`, or is older than
 * `staleMs`. Returns `false` (fresh ⇒ a concurrent run is apparently alive) only
 * for a present heartbeat within the window. The boundary is inclusive: exactly
 * `staleMs` old is still fresh; one ms older is stale.
 */
export function isHeartbeatStale(args: {
  heartbeat: Heartbeat | null
  nowMs: number
  staleMs?: number
}): boolean {
  const staleMs = args.staleMs ?? HEARTBEAT_STALE_MS
  if (args.heartbeat == null) return true
  const tsMs = Date.parse(args.heartbeat.ts)
  if (Number.isNaN(tsMs)) return true
  return args.nowMs - tsMs > staleMs
}
