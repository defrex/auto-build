/**
 * Cleanup-phase decision logic + thin herdr IO.
 *
 * Mirrors the repo's "pure logic + thin glue" split (`monitor.ts` is pure,
 * `repo.ts` is IO): the parsers and the removal/match decisions here are pure
 * and fully unit-tested, while the two herdr CLI wrappers at the bottom are
 * injectable-`exec` glue (matching the `repo.ts` convention).
 *
 * The orchestrator's `cleanupPhase` composes these: it only ever tears down a
 * worktree that is (a) a linked, non-main `gwt`-style sibling checkout
 * (`<project>-<safe-branch>`, a sibling of the main worktree) AND (b) framed by
 * an unambiguous matching herdr workspace. See `orchestrator.ts` for the routing
 * + write-after-delete safety reasoning.
 */

import { basename, dirname } from "node:path"
import { type ShResult, sh } from "./repo"

/** Parsed worktree from `git worktree list --porcelain`; first entry is the main worktree. */
export type WorktreeEntry = { path: string }

/**
 * Parse `git worktree list --porcelain` into ordered entries (main worktree
 * first, then linked worktrees). Each record begins with a `worktree <path>`
 * line; everything else is ignored. Empty/garbage input → `[]`. (pure)
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = []
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      const path = line.slice("worktree ".length).trim()
      if (path) entries.push({ path })
    }
  }
  return entries
}

export type WorktreeRemovalPlan =
  | { kind: "remove"; fromMain: string; worktreePath: string }
  | { kind: "skip"; reason: string }

/**
 * Decide whether to remove the current checkout's worktree (pure). The gate
 * intentionally excludes everything that is NOT a `gwt`-created kickoff worktree:
 * - `currentPath` === first entry (the main checkout)   → skip "main checkout"
 * - `currentPath` not a linked entry in the list        → skip "not a linked worktree"
 * - `currentPath` is not a `<project>-…` sibling of the main checkout (a gwt
 *     worktree lives at `dirname(main)/basename(main)-<safe-branch>`; this
 *     excludes superset `~/.superset/...`, ad-hoc worktrees elsewhere, etc.)
 *                                                        → skip "not a kickoff worktree"
 * - else → `{ kind: "remove", fromMain: <first entry>, worktreePath: currentPath }`
 *
 * The herdr-workspace requirement is layered on top by `cleanupPhase`; this
 * function stays a pure, independently-testable worktree decision.
 */
export function decideWorktreeRemoval(
  porcelain: string,
  currentPath: string,
): WorktreeRemovalPlan {
  const entries = parseWorktreeList(porcelain)
  if (entries.length === 0)
    return { kind: "skip", reason: "no worktrees listed" }
  const main = entries[0] as WorktreeEntry
  if (main.path === currentPath)
    return { kind: "skip", reason: "main checkout" }
  const linked = entries.some((e) => e.path === currentPath)
  if (!linked) return { kind: "skip", reason: "not a linked worktree" }
  // gwt worktrees are siblings of the main checkout named `<project>-…`. Anything
  // not matching that layout (a different parent dir, or a non-prefixed name) is
  // not a kickoff/build worktree and must be left alone.
  if (
    dirname(currentPath) !== dirname(main.path) ||
    !basename(currentPath).startsWith(`${basename(main.path)}-`)
  )
    return { kind: "skip", reason: "not a kickoff worktree" }
  return { kind: "remove", fromMain: main.path, worktreePath: currentPath }
}

export type HerdrWorkspace = { workspaceId: string; label: string }

/**
 * Tolerant parse of `herdr workspace list` JSON → `result.workspaces[]`. Each
 * workspace contributes a `{ workspaceId, label }` only when both fields are
 * present strings. Bad JSON or an unexpected shape → `[]` (so a herdr CLI
 * contract drift degrades to "no match → no-op", not a crash). (pure)
 */
export function parseHerdrWorkspaceList(stdout: string): HerdrWorkspace[] {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: {
        workspaces?: Array<{ workspace_id?: unknown; label?: unknown }>
      }
    }
    const workspaces = parsed.result?.workspaces
    if (!Array.isArray(workspaces)) return []
    const out: HerdrWorkspace[] = []
    for (const w of workspaces) {
      if (typeof w?.workspace_id === "string" && typeof w?.label === "string")
        out.push({ workspaceId: w.workspace_id, label: w.label })
    }
    return out
  } catch {
    return []
  }
}

/** herdr truncates workspace labels to 50 chars (observed empirically). */
export const HERDR_LABEL_MAX = 50

/** The slug as herdr would store it as a label (truncated to {@link HERDR_LABEL_MAX}). */
export function truncateHerdrLabel(slug: string): string {
  return slug.slice(0, HERDR_LABEL_MAX)
}

/**
 * The single workspace id whose label matches `slug` (exact, or truncated to
 * 50 chars), or `null` on NO match OR an AMBIGUOUS (>1) match — skip rather
 * than risk closing the wrong workspace. A workspace matches when:
 *   w.label === slug
 *   || w.label === truncateHerdrLabel(slug)
 *   || (w.label.length === HERDR_LABEL_MAX && slug.startsWith(w.label))
 * (pure)
 */
export function matchHerdrWorkspaceId(
  workspaces: HerdrWorkspace[],
  slug: string,
): string | null {
  const truncated = truncateHerdrLabel(slug)
  const matches = workspaces.filter(
    (w) =>
      w.label === slug ||
      w.label === truncated ||
      (w.label.length === HERDR_LABEL_MAX && slug.startsWith(w.label)),
  )
  return matches.length === 1
    ? (matches[0] as HerdrWorkspace).workspaceId
    : null
}

// --- Shared teardown (gate + remove + close-last), reused by both the --------
//     orchestrator's cleanupPhase and the standalone `kickoff --cleanup`. ------

/** IO surface a teardown needs, injected so the decision logic stays testable. */
export type TeardownIO = {
  worktreeListPorcelain: (cwd: string) => string
  herdrWorkspaceListRaw: (cwd: string) => string
  removeWorktree: (fromMain: string, worktreePath: string) => ShResult
  forceRemoveWorktreeDir: (fromMain: string, worktreePath: string) => ShResult
  closeHerdrWorkspace: (cwd: string, workspaceId: string) => ShResult
}

/** The result of a {@link teardownWorkspace} attempt. */
export type TeardownOutcome =
  | { kind: "noop"; reason: string }
  | {
      kind: "torn-down"
      /** stderr when the worktree dir could not be fully removed (leftover litter — tolerated). null = clean removal. */
      worktreeRemoveError: string | null
      /** stderr when `herdr workspace close` failed. null = closed. */
      workspaceCloseFailed: string | null
    }

/**
 * Tear down a single herdr-framed kickoff worktree: gate it, remove the git
 * worktree, then close its framing herdr workspace LAST (cwd = the main
 * worktree, since the worktree path is gone after removal). Behavior mirrors the
 * orchestrator's historic `cleanupPhase` steps exactly so the two callers stay
 * byte-for-byte equivalent.
 *
 * The gate intentionally requires BOTH a `gwt`-style sibling worktree
 * (`<project>-<safe-branch>`, a sibling of the main checkout) AND an
 * unambiguous matching herdr workspace before removing anything — when no
 * matching workspace is found the worktree is left intact (`noop`), never
 * removed (it can't be proven herdr-framed). `onBeforeRemove` runs only after
 * the gate passes and before removal (the orchestrator uses it for the
 * dashboard frame + sleep); it never runs on a `noop`.
 *
 * Once the gate passes the close is ALWAYS attempted: a failed `removeWorktree`
 * is escalated (force-remove the dir + prune), and whether or not that fully
 * cleans the worktree, the herdr workspace is closed regardless. Leftover litter
 * on disk is a tolerated outcome (surfaced via `worktreeRemoveError` for
 * logging), never a reason to skip the close — the merge is the source of truth.
 */
export async function teardownWorkspace(args: {
  /** The checkout being cleaned (the gate's `currentPath`). */
  targetPath: string
  /** Herdr label to match (the build slug). */
  slug: string
  io: TeardownIO
  /** Frame hook run only after the gate passes, before removal. */
  onBeforeRemove?: () => Promise<void>
}): Promise<TeardownOutcome> {
  const { targetPath, slug, io, onBeforeRemove } = args
  const plan = decideWorktreeRemoval(
    io.worktreeListPorcelain(targetPath),
    targetPath,
  )
  const herdrId = matchHerdrWorkspaceId(
    parseHerdrWorkspaceList(io.herdrWorkspaceListRaw(targetPath)),
    slug,
  )
  if (plan.kind !== "remove" || herdrId == null) {
    return { kind: "noop", reason: "not a herdr-framed kickoff build" }
  }
  await onBeforeRemove?.()
  let worktreeRemoveError: string | null = null
  const removed = io.removeWorktree(plan.fromMain, plan.worktreePath)
  if (removed.code !== 0) {
    // Try harder: force-remove the leftover dir + prune git's bookkeeping.
    const escalated = io.forceRemoveWorktreeDir(
      plan.fromMain,
      plan.worktreePath,
    )
    if (escalated.code !== 0) {
      // Even the forced removal couldn't fully clean — leftover litter is
      // tolerated; we still close the local space below.
      worktreeRemoveError = escalated.stderr || removed.stderr
    }
  }
  // Close the herdr workspace REGARDLESS of removal outcome — the merge is the
  // source of truth in the PR; whatever remains on disk doesn't gate the close.
  // Run from fromMain (the main worktree), which always exists.
  const closed = io.closeHerdrWorkspace(plan.fromMain, herdrId)
  return {
    kind: "torn-down",
    worktreeRemoveError,
    workspaceCloseFailed: closed.code === 0 ? null : closed.stderr,
  }
}

// --- herdr IO glue (thin, injectable `exec`; not heavily unit-tested) -------

/** `herdr workspace list` stdout ("" on failure). */
export function herdrWorkspaceListRaw(
  cwd: string,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): string {
  const r = exec(["herdr", "workspace", "list"], cwd)
  return r.code === 0 ? r.stdout : ""
}

/** `herdr workspace close <id>` from `cwd`; returns the ShResult (best-effort caller). */
export function closeHerdrWorkspace(
  cwd: string,
  workspaceId: string,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): ShResult {
  return exec(["herdr", "workspace", "close", workspaceId], cwd)
}
