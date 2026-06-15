/**
 * Single-writer lock for the kickoff run. The fill loop's double-launch
 * protection rests on claims being strictly sequential, and a cron tick can
 * overlap a still-running kickoff run (e.g. a synchronous fallback build that
 * blocks for hours) — so each run takes a pid lockfile and a second kickoff run
 * exits 0 immediately while the holder is alive. A lock whose holder is dead
 * (crash, reboot) is stolen, so a stale file never wedges the cron.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** Lives in the gitignored per-run scratch dir next to select-result.json. */
export function kickoffLockPath(repoRoot: string): string {
  return join(repoRoot, "build", "kickoff", ".kickoff", "kickoff.pid")
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM = exists but owned by someone else — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * Try to take the kickoff run lock. Returns false when another kickoff run
 * holds it and is still running.
 */
export function acquireKickoffLock(
  repoRoot: string,
  opts: { pid?: number; isAlive?: (pid: number) => boolean } = {},
): boolean {
  const { pid = process.pid, isAlive = defaultIsAlive } = opts
  const lockPath = kickoffLockPath(repoRoot)
  mkdirSync(dirname(lockPath), { recursive: true })
  try {
    writeFileSync(lockPath, String(pid), { flag: "wx" })
    return true
  } catch {
    const holder = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10)
    if (Number.isInteger(holder) && isAlive(holder)) return false
    // Stale (holder dead or unreadable) — steal it.
    writeFileSync(lockPath, String(pid))
    return true
  }
}

/** Release the lock taken by `acquireKickoffLock`. */
export function releaseKickoffLock(repoRoot: string): void {
  rmSync(kickoffLockPath(repoRoot), { force: true })
}
