/**
 * Best-effort helpers for `/build` analytics — pure/IO-light functions feeding
 * the `build_completed` rollup and per-event properties. Every IO helper degrades
 * to a safe default (0/0/0, {}, 0) on failure; none throw into the pipeline.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { buildDir } from "./state"

/**
 * Count the findings in a review round file. The reviewer tags each finding
 * `[blocking]`, `[nit]`, or `[question]` (the `reviewPrompt` contract), so the
 * count is the number of such tags — one per finding. Count only, never the
 * finding text (payload policy). Missing/unreadable file or zero matches → 0.
 */
export function countReviewFindings(md: string): number {
  const matches = md.match(/\[(blocking|nit|question)\]/gi)
  return matches ? matches.length : 0
}

/** Read a review round file and count its findings (0 on absence). */
export function countReviewFindingsAt(roundFile: string): number {
  if (!existsSync(roundFile)) return 0
  try {
    return countReviewFindings(readFileSync(roundFile, "utf-8"))
  } catch {
    return 0
  }
}

export type DiffStat = {
  filesChanged: number
  linesAdded: number
  linesRemoved: number
}

/**
 * Diff stats for `<base>...HEAD` via `git diff --numstat`, summed. Best-effort:
 * `0/0/0` on any failure. Binary files (numstat `-`) count toward `filesChanged`
 * but contribute no line counts.
 */
export function diffStat(repoRoot: string, baseBranch: string): DiffStat {
  const empty: DiffStat = { filesChanged: 0, linesAdded: 0, linesRemoved: 0 }
  try {
    const r = spawnSync("git", ["diff", "--numstat", `${baseBranch}...HEAD`], {
      cwd: repoRoot,
      encoding: "utf-8",
      timeout: 10_000,
    })
    if (r.status !== 0) return empty
    let filesChanged = 0
    let linesAdded = 0
    let linesRemoved = 0
    for (const line of (r.stdout ?? "").split("\n")) {
      const trimmed = line.trim()
      if (trimmed === "") continue
      filesChanged++
      const [addedRaw, removedRaw] = trimmed.split("\t")
      const added = Number.parseInt(addedRaw, 10)
      const removed = Number.parseInt(removedRaw, 10)
      if (!Number.isNaN(added)) linesAdded += added
      if (!Number.isNaN(removed)) linesRemoved += removed
    }
    return { filesChanged, linesAdded, linesRemoved }
  } catch {
    return empty
  }
}

export type KickoffIdentity = { issueId?: string; issueUuid?: string }

/** Absolute path to the kickoff identity sidecar for a feature. */
export function kickoffIdentityPath(repoRoot: string, feature: string): string {
  return join(buildDir(repoRoot, feature), ".kickoff-identity.json")
}

/**
 * Read the kickoff identity sidecar (`build/<feature>/.kickoff-identity.json`),
 * written by kickoff at launch so the build can seed its join key. Best-effort:
 * missing/malformed → `{}`, never throws. Only the two IDs are read.
 */
export function readKickoffIdentity(
  repoRoot: string,
  feature: string,
): KickoffIdentity {
  const path = kickoffIdentityPath(repoRoot, feature)
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as KickoffIdentity
    const out: KickoffIdentity = {}
    if (typeof parsed.issueId === "string" && parsed.issueId.trim() !== "")
      out.issueId = parsed.issueId
    if (typeof parsed.issueUuid === "string" && parsed.issueUuid.trim() !== "")
      out.issueUuid = parsed.issueUuid
    return out
  } catch {
    return {}
  }
}
