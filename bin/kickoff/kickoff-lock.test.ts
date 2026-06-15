import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  acquireKickoffLock,
  kickoffLockPath,
  releaseKickoffLock,
} from "./kickoff-lock"

function tempRepo(): string {
  return mkdtempSync(join(tmpdir(), "kickoff-lock-"))
}

describe("kickoff lock", () => {
  test("acquires when no lock exists, writes the pid, releases cleanly", () => {
    const repo = tempRepo()
    expect(acquireKickoffLock(repo, { pid: 1234, isAlive: () => true })).toBe(
      true,
    )
    expect(readFileSync(kickoffLockPath(repo), "utf-8")).toBe("1234")
    releaseKickoffLock(repo)
    expect(existsSync(kickoffLockPath(repo))).toBe(false)
  })

  test("refuses while the holder is still alive (cron overlap)", () => {
    const repo = tempRepo()
    expect(acquireKickoffLock(repo, { pid: 1, isAlive: () => true })).toBe(true)
    expect(acquireKickoffLock(repo, { pid: 2, isAlive: () => true })).toBe(
      false,
    )
  })

  test("steals a stale lock whose holder is dead", () => {
    const repo = tempRepo()
    expect(acquireKickoffLock(repo, { pid: 1, isAlive: () => true })).toBe(true)
    expect(acquireKickoffLock(repo, { pid: 2, isAlive: () => false })).toBe(
      true,
    )
    expect(readFileSync(kickoffLockPath(repo), "utf-8")).toBe("2")
  })
})
