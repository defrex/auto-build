/**
 * Latest-change timestamps for `build/<dir>/observations.md` files, used to
 * order harvest candidates newest-first ("yesterday first, backlog fills the
 * remainder").
 *
 * Git last-commit time is the primary source — it's deterministic across
 * clones/worktrees, unlike file mtime (which checkout resets). Files with no
 * git history yet (an in-flight build's uncommitted observations) fall back to
 * mtime, which naturally ranks them as recent.
 */

import { execFileSync } from "node:child_process"
import { statSync } from "node:fs"
import { join } from "node:path"

/**
 * Parse `git log --format=%ct --name-only` output into path → newest commit
 * time (epoch ms). The max timestamp mentioning a path wins, so the result
 * holds even under commit-date clock skew. Timestamp lines are bare digits;
 * path lines always contain more.
 */
export function parseGitLogTimes(output: string): Map<string, number> {
  const times = new Map<string, number>()
  let current: number | null = null
  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim()
    if (line === "") continue
    if (/^\d+$/.test(line)) {
      current = Number(line) * 1000
    } else if (current !== null && current > (times.get(line) ?? -1)) {
      times.set(line, current)
    }
  }
  return times
}

/**
 * Resolve a recency timestamp (epoch ms) for each given repo-relative
 * observation path: git commit time first, file mtime as fallback. Paths with
 * neither (deleted mid-run) are simply absent from the map.
 */
export function latestObservationTimes(
  repoRoot: string,
  sourcePaths: string[],
): Map<string, number> {
  let gitTimes = new Map<string, number>()
  try {
    const output = execFileSync(
      "git",
      ["log", "--format=%ct", "--name-only", "--", "build/*/observations.md"],
      { cwd: repoRoot, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
    )
    gitTimes = parseGitLogTimes(output)
  } catch (error) {
    // Not a git repo / git unavailable — mtime fallback still orders sanely.
    process.stderr.write(
      `[observation-recency] git recency unavailable, using mtimes: ${String(error)}\n`,
    )
  }

  const times = new Map<string, number>()
  for (const sourcePath of sourcePaths) {
    const fromGit = gitTimes.get(sourcePath)
    if (fromGit !== undefined) {
      times.set(sourcePath, fromGit)
      continue
    }
    try {
      times.set(sourcePath, statSync(join(repoRoot, sourcePath)).mtimeMs)
    } catch {
      // File vanished between scan and stat — leave undated; it sorts last.
    }
  }
  return times
}
