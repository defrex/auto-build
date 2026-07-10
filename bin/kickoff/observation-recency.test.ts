import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { latestObservationTimes, parseGitLogTimes } from "./observation-recency"

describe("parseGitLogTimes", () => {
  test("maps each path to its FIRST (newest) commit timestamp, in ms", () => {
    // `git log --format=%ct --name-only` is newest-first: a bare-digits line
    // starts each commit, followed by the paths it touched.
    const output = [
      "1700000300",
      "",
      "build/newer/observations.md",
      "",
      "1700000200",
      "",
      "build/newer/observations.md",
      "build/older/observations.md",
      "",
    ].join("\n")
    const times = parseGitLogTimes(output)
    expect(times.get("build/newer/observations.md")).toBe(1_700_000_300_000)
    expect(times.get("build/older/observations.md")).toBe(1_700_000_200_000)
  })

  test("empty output yields an empty map", () => {
    expect(parseGitLogTimes("").size).toBe(0)
  })
})

describe("latestObservationTimes", () => {
  test("git commit times win over misleading file mtimes", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kickoff-recency-git-"))
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repoRoot, encoding: "utf-8" })
    git("init", "-q")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "test")

    const commitObservation = (dir: string, isoDate: string) => {
      mkdirSync(join(repoRoot, "build", dir), { recursive: true })
      const path = `build/${dir}/observations.md`
      writeFileSync(join(repoRoot, path), `## ${dir}\n`)
      git("add", path)
      execFileSync("git", ["commit", "-q", "-m", dir], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: isoDate,
          GIT_COMMITTER_DATE: isoDate,
        },
      })
      return path
    }
    const older = commitObservation("older", "2026-01-01T00:00:00Z")
    const newer = commitObservation("newer", "2026-06-01T00:00:00Z")

    // Misleading mtimes: checkout-style "all files stamped now", with the
    // git-older file even carrying the NEWER mtime.
    const now = new Date()
    utimesSync(join(repoRoot, older), now, now)
    utimesSync(
      join(repoRoot, newer),
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() - 60_000),
    )

    const times = latestObservationTimes(repoRoot, [older, newer])
    expect(times.get(older)).toBe(Date.parse("2026-01-01T00:00:00Z"))
    expect(times.get(newer)).toBe(Date.parse("2026-06-01T00:00:00Z"))
  })

  test("falls back to file mtime outside a git repo", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "kickoff-recency-"))
    const dir = join(repoRoot, "build", "feat")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, "observations.md")
    writeFileSync(file, "## x\n")
    const stamp = new Date("2026-01-02T03:04:05Z")
    utimesSync(file, stamp, stamp)

    const times = latestObservationTimes(repoRoot, [
      "build/feat/observations.md",
      "build/missing/observations.md",
    ])
    expect(times.get("build/feat/observations.md")).toBe(stamp.getTime())
    expect(times.has("build/missing/observations.md")).toBe(false)
  })
})
