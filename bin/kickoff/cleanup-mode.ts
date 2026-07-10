/**
 * Standalone `kickoff --cleanup` mode: tear down a single herdr-framed kickoff
 * worktree, reusing the orchestrator's shared `teardownWorkspace`
 * (`bin/build/cleanup.ts`). The orchestrator only ever cleans up AFTER merge (a
 * guaranteed-clean tree), so this standalone path adds a dirty/unpushed safety
 * guard the post-merge path doesn't need.
 *
 * The pure decisions (worktree parsing, target resolution, the safety guard) are
 * unit-tested; the thin git IO is injected (default `sh` from `bin/build/repo.ts`).
 */

import { basename } from "node:path"
import {
  closeHerdrWorkspace,
  herdrWorkspaceListRaw,
  type TeardownOutcome,
  teardownWorkspace,
} from "../build/cleanup"
import {
  forceRemoveWorktreeDir,
  removeWorktree,
  type ShResult,
  sh,
  worktreeListPorcelain as worktreeListPorcelainIo,
} from "../build/repo"
import type { CleanupArgs } from "./args"
import { slugFromKickoffBranch } from "./branch"

/** A worktree entry that also carries its checked-out branch (short name). */
export type WorktreeEntryWithBranch = { path: string; branch: string | null }

/**
 * Parse `git worktree list --porcelain` into entries that ALSO capture the
 * `branch refs/heads/<name>` line (normalized to the short name). A `detached`
 * worktree (or one with no branch line) → `branch: null`. The main worktree is
 * first. This is a new, branch-aware parser kept separate from `cleanup.ts`'s
 * `parseWorktreeList` (whose tests assert the exact `{ path }` shape). (pure)
 */
export function parseWorktreeEntries(
  porcelain: string,
): WorktreeEntryWithBranch[] {
  const entries: WorktreeEntryWithBranch[] = []
  let current: WorktreeEntryWithBranch | null = null
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      const path = line.slice("worktree ".length).trim()
      if (path) {
        current = { path, branch: null }
        entries.push(current)
      } else {
        current = null
      }
    } else if (line.startsWith("branch ") && current) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//, "")
    }
  }
  return entries
}

export type CleanupTarget =
  | { kind: "target"; path: string; slug: string }
  | { kind: "no-target"; reason: string }
  | { kind: "error"; reason: string }

/**
 * Resolve which worktree to clean (pure). Precedence: `--slug`/`--branch`
 * conflict → error; `--branch` → the worktree on that branch; `--slug` → the gwt
 * worktree whose dir name ends in `-<slug>`; neither → the current worktree
 * (unless it is the main checkout).
 *
 * The resolved `slug` MUST be the bare build slug (the herdr label
 * `teardownWorkspace` matches), NOT the gwt worktree dir name
 * (`<project>-<safe-branch>`). It is recovered from the kickoff branch name
 * (`slugFromKickoffBranch`); `--slug` already carries the bare slug, so it passes
 * straight through. For a non-scheme / detached branch we fall back to
 * `basename(path)` (a deterministic, if non-matching, label — teardown then
 * no-ops safely). Misses are idempotent no-ops (safe to double-clean).
 */
export function resolveCleanupTarget(args: {
  entries: WorktreeEntryWithBranch[]
  mainPath: string | undefined
  currentPath: string
  slug: string | null
  branch: string | null
}): CleanupTarget {
  const { entries, mainPath, currentPath, slug, branch } = args
  if (slug != null && branch != null) {
    return { kind: "error", reason: "pass at most one of --slug / --branch" }
  }
  if (branch != null) {
    const hit = entries.find((e) => e.branch === branch)
    return hit
      ? {
          kind: "target",
          path: hit.path,
          slug: slugFromKickoffBranch(hit.branch ?? "") ?? basename(hit.path),
        }
      : {
          kind: "no-target",
          reason: `no worktree checked out on ${branch} — nothing to clean`,
        }
  }
  if (slug != null) {
    const hit = entries.find((e) => basename(e.path).endsWith(`-${slug}`))
    return hit
      ? { kind: "target", path: hit.path, slug }
      : {
          kind: "no-target",
          reason: `no worktree for slug ${slug} — nothing to clean`,
        }
  }
  if (mainPath != null && currentPath === mainPath) {
    return {
      kind: "no-target",
      reason: "run from inside the worktree to clean, or pass --slug/--branch",
    }
  }
  const entry = entries.find((e) => e.path === currentPath)
  const slugForCurrent =
    (entry?.branch != null ? slugFromKickoffBranch(entry.branch) : null) ??
    basename(currentPath)
  return { kind: "target", path: currentPath, slug: slugForCurrent }
}

/**
 * The standalone safety guard the post-merge orchestrator path doesn't need
 * (pure). `--force` bypasses everything. Uncommitted changes are refused even
 * under `--merged` (unsaved edits are unrecoverable and merge says nothing about
 * the working tree). Unpushed work (no upstream, or ahead of it) is refused
 * unless `--merged` — a merged branch's commits are recoverable from base, and
 * `origin/<branch>` is typically auto-deleted on merge (the `!hasUpstream`
 * false-positive `--merged` clears).
 */
export function decideCleanupSafety(args: {
  statusPorcelain: string
  aheadOfOrigin: boolean
  hasUpstream: boolean
  force: boolean
  merged: boolean
}): { ok: true } | { ok: false; reason: string } {
  const { statusPorcelain, aheadOfOrigin, hasUpstream, force, merged } = args
  if (force) return { ok: true }
  if (statusPorcelain.trim() !== "") {
    return {
      ok: false,
      reason:
        "refusing: the worktree has uncommitted changes (unrecoverable) — commit/stash them, or pass --force",
    }
  }
  if (!hasUpstream || aheadOfOrigin) {
    if (!merged) {
      return {
        ok: false,
        reason:
          "refusing: the branch has unpushed commits (or no upstream) — push them, or pass --merged (PR merged) / --force",
      }
    }
  }
  return { ok: true }
}

/** Thin IO surface for cleanup mode (default `sh`-backed wiring below). */
export type CleanupModeDeps = {
  worktreeListPorcelain: (cwd: string) => string
  statusPorcelain: (path: string) => string
  /** `git rev-parse --abbrev-ref --symbolic-full-name @{u}` — code≠0 ⇒ no upstream. */
  upstreamRef: (path: string) => ShResult
  /** `git rev-list --count @{u}..HEAD`. */
  aheadCount: (path: string) => ShResult
  teardown: (a: {
    targetPath: string
    slug: string
  }) => Promise<TeardownOutcome>
  log: (message: string) => void
}

/** Production wiring for cleanup mode. */
export function defaultCleanupDeps(
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): CleanupModeDeps {
  return {
    worktreeListPorcelain: (cwd) => worktreeListPorcelainIo(cwd, exec),
    statusPorcelain: (path) =>
      exec(["git", "-C", path, "status", "--porcelain"], path).stdout,
    upstreamRef: (path) =>
      exec(
        [
          "git",
          "-C",
          path,
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{u}",
        ],
        path,
      ),
    aheadCount: (path) =>
      exec(["git", "-C", path, "rev-list", "--count", "@{u}..HEAD"], path),
    teardown: ({ targetPath, slug }) =>
      teardownWorkspace({
        targetPath,
        slug,
        io: {
          worktreeListPorcelain: (cwd) => worktreeListPorcelainIo(cwd, exec),
          herdrWorkspaceListRaw: (cwd) => herdrWorkspaceListRaw(cwd, exec),
          removeWorktree: (fromMain, worktreePath) =>
            removeWorktree(fromMain, worktreePath, exec),
          forceRemoveWorktreeDir: (fromMain, worktreePath) =>
            forceRemoveWorktreeDir(fromMain, worktreePath, exec),
          closeHerdrWorkspace: (cwd, workspaceId) =>
            closeHerdrWorkspace(cwd, workspaceId, exec),
        },
      }),
    log: (message) => process.stdout.write(`[kickoff] ${message}\n`),
  }
}

/**
 * Orchestrate a standalone cleanup: resolve the target → run the safety guard →
 * tear down. Returns a process exit code: `0` for a clean teardown or an
 * idempotent no-op, `1` for a usage error / guard refusal / failed removal.
 * Never takes the kickoff pid lock — it targets a single, typically-idle
 * worktree and must stay runnable alongside a `--watch` monitor.
 */
export async function runCleanup(
  repoRoot: string,
  args: CleanupArgs,
  deps: CleanupModeDeps,
): Promise<number> {
  const entries = parseWorktreeEntries(deps.worktreeListPorcelain(repoRoot))
  const mainPath = entries[0]?.path
  const target = resolveCleanupTarget({
    entries,
    mainPath,
    currentPath: repoRoot,
    slug: args.slug,
    branch: args.branch,
  })
  if (target.kind === "error") {
    deps.log(`cleanup: ${target.reason}`)
    return 1
  }
  if (target.kind === "no-target") {
    deps.log(`cleanup: ${target.reason}`)
    return 0
  }

  const upstream = deps.upstreamRef(target.path)
  const hasUpstream = upstream.code === 0
  const ahead = deps.aheadCount(target.path)
  const aheadOfOrigin =
    hasUpstream &&
    ahead.code === 0 &&
    Number.parseInt(ahead.stdout.trim(), 10) > 0
  const safety = decideCleanupSafety({
    statusPorcelain: deps.statusPorcelain(target.path),
    aheadOfOrigin,
    hasUpstream,
    force: args.force,
    merged: args.merged,
  })
  if (!safety.ok) {
    deps.log(`cleanup: ${safety.reason}`)
    return 1
  }

  const outcome = await deps.teardown({
    targetPath: target.path,
    slug: target.slug,
  })
  if (outcome.kind === "noop") {
    deps.log(
      `cleanup: nothing herdr-framed to tear down at ${target.path} — left in place`,
    )
    return 0
  }
  // torn-down: the close was attempted regardless of removal outcome.
  if (outcome.worktreeRemoveError != null) {
    deps.log(
      `cleanup: worktree not fully removed (${outcome.worktreeRemoveError.trim()}); leftover files tolerated`,
    )
  }
  if (outcome.workspaceCloseFailed != null) {
    // The local space is still open — the one thing the user wanted closed.
    deps.log(
      `cleanup: herdr workspace close failed (${outcome.workspaceCloseFailed.trim()}); close manually`,
    )
    return 1
  }
  deps.log(`cleanup: closed the herdr workspace for ${target.path}`)
  return 0
}
