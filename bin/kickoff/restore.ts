/**
 * Pure decisions + injected-IO orchestration for `kickoff --restore`.
 *
 * Restore walks the In-Progress tickets assigned to the current operator and
 * idempotently rebuilds each one's LOCAL environment: a git worktree on the
 * ticket's existing branch (recovering in-flight work), a herdr two-pane
 * workspace, and a running `/build <slug>` supervisor that RESUMES from the
 * committed `build/<slug>/` artifacts. It never claims or changes ticket state
 * and never aborts the whole pass because one ticket failed.
 *
 * The branch/slug/idempotency decisions are pure (unit-tested); all process
 * boundaries are injected via `RestoreDeps`, mirroring `KickoffDeps`.
 */

import {
  HERDR_LABEL_MAX,
  type HerdrWorkspace,
  parseHerdrWorkspaceList,
  truncateHerdrLabel,
} from "../build/cleanup"
import {
  gwtWorktreeDir,
  kickoffBranch,
  slugFromKickoffBranch,
  slugify,
} from "./branch"
import {
  parseWorktreeEntries,
  type WorktreeEntryWithBranch,
} from "./cleanup-mode"
import type { KickoffConfig } from "./config"
import { KICKOFF_BASE_REF } from "./kickoff-base"

// --- (a) Normalized branch model ---------------------------------------------

export type BranchRef = {
  /** Local name, NEVER `origin/`-prefixed. */
  branch: string
  localExists: boolean
  remoteExists: boolean
}

/**
 * Fold short refs (`git for-each-ref --format=%(refname:short) refs/heads
 * refs/remotes/origin`) into a name→BranchRef map: `origin/<name>` →
 * `{ remoteExists: true }`, `<name>` → `{ localExists: true }`. `origin/HEAD`
 * is ignored. (pure)
 */
export function indexBranches(shortRefs: string[]): Map<string, BranchRef> {
  const map = new Map<string, BranchRef>()
  const get = (name: string): BranchRef => {
    let ref = map.get(name)
    if (!ref) {
      ref = { branch: name, localExists: false, remoteExists: false }
      map.set(name, ref)
    }
    return ref
  }
  for (const raw of shortRefs) {
    const ref = raw.trim()
    if (ref === "") continue
    if (ref.startsWith("origin/")) {
      const name = ref.slice("origin/".length)
      if (name === "" || name === "HEAD") continue
      get(name).remoteExists = true
    } else {
      get(ref).localExists = true
    }
  }
  return map
}

/**
 * Defensively reduce an attached ref to a plain, checkoutable branch name: strip
 * an `owner:` PR-head prefix, strip a leading `origin/`, trim. Returns null when
 * the result isn't a plausible branch (empty, whitespace, leading `-`, or a
 * stray leading `/` from a URL remnant). (pure)
 */
export function normalizeAttachedBranch(raw: string | null): string | null {
  if (raw == null) return null
  let s = raw.trim()
  if (s === "") return null
  const colon = s.indexOf(":")
  if (colon >= 0) s = s.slice(colon + 1)
  if (s.startsWith("origin/")) s = s.slice("origin/".length)
  s = s.trim()
  if (s === "" || s.startsWith("-") || s.startsWith("/") || /\s/.test(s))
    return null
  return s
}

// --- (b) Branch resolution (spec precedence) ---------------------------------

export type ResolvedBranch = BranchRef & {
  source: "attached" | "existing" | "derived"
  /** Concrete ref to inspect/check-out: `<branch>` (local), `origin/<branch>`
   *  (remote), or null when nothing exists to recover (fresh scaffold). */
  sourceRef: string | null
}

/** The concrete inspectable ref for a BranchRef (local wins, else remote, else none). */
function refFor(b: BranchRef): string | null {
  if (b.localExists) return b.branch
  if (b.remoteExists) return `origin/${b.branch}`
  return null
}

/** Whether `branch` carries `id` as a `/`-delimited segment (`<id>` or `<id>-…`). */
function carriesId(branch: string, id: string): boolean {
  const lid = id.toLowerCase()
  return branch
    .toLowerCase()
    .split("/")
    .some((seg) => seg === lid || seg.startsWith(`${lid}-`))
}

/**
 * Resolve the branch to restore via the spec precedence (pure):
 *  1. an attached git branch ref (PR head OR a no-PR git-branch attachment),
 *     normalized — wins even when it does NOT carry the Linear id (the
 *     anti-desync guarantee for renamed/non-scheme branches);
 *  2. else an existing local/remote branch carrying the Linear id (sorted for
 *     determinism);
 *  3. else a freshly-derived `<id>-<slug>` name.
 */
export function resolveRestoreBranch(args: {
  issueId: string
  title: string
  attachedBranch: string | null
  branchIndex: Map<string, BranchRef>
}): ResolvedBranch {
  const { issueId, title, attachedBranch, branchIndex } = args
  const attached = normalizeAttachedBranch(attachedBranch)
  if (attached != null) {
    const ref = branchIndex.get(attached) ?? {
      branch: attached,
      localExists: false,
      remoteExists: false,
    }
    return { ...ref, source: "attached", sourceRef: refFor(ref) }
  }
  const existing = [...branchIndex.keys()]
    .sort()
    .find((name) => carriesId(name, issueId))
  if (existing != null) {
    const ref = branchIndex.get(existing) as BranchRef
    return { ...ref, source: "existing", sourceRef: refFor(ref) }
  }
  return {
    branch: kickoffBranch(issueId, slugify(title)),
    localExists: false,
    remoteExists: false,
    source: "derived",
    sourceRef: null,
  }
}

// --- (c) Slug resolution ------------------------------------------------------

/**
 * Resolve the slug (the `/build` arg + herdr label + worktree dir name, which
 * must agree so later teardown matches) (pure):
 *  1. parse it from an `<id>-<slug>` branch name (`<id>` = `<team>-<n>`; a legacy
 *     `kickoff/`-prefixed branch is still accepted);
 *  2. else the single committed `build/*` dir excluding the reserved `kickoff`
 *     scratch dir;
 *  3. else `slugify(title)`.
 */
export function resolveRestoreSlug(args: {
  branch: string
  title: string
  committedBuildDirs: string[]
}): string {
  const fromBranch = slugFromKickoffBranch(args.branch)
  if (fromBranch) return fromBranch
  const dirs = args.committedBuildDirs.filter((d) => d !== "kickoff")
  if (dirs.length === 1) return dirs[0] as string
  return slugify(args.title)
}

// --- (d) Worktree idempotency -------------------------------------------------

/** The path of the worktree checked out on `branch`, or null. (pure) */
export function findWorktreeForBranch(
  entries: WorktreeEntryWithBranch[],
  branch: string,
): string | null {
  return entries.find((e) => e.branch === branch)?.path ?? null
}

// --- (e) Workspace + supervisor idempotency ----------------------------------

export type HerdrPane = {
  paneId: string
  workspaceId: string
  /** "claude" on a live supervisor pane; null on the dashboard pane. */
  agent: string | null
}

/** Tolerant parse of `herdr pane list` → `result.panes[]` (bad JSON/shape → []). (pure) */
export function parseHerdrPaneList(stdout: string): HerdrPane[] {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: {
        panes?: Array<{
          pane_id?: unknown
          workspace_id?: unknown
          agent?: unknown
        }>
      }
    }
    const panes = parsed.result?.panes
    if (!Array.isArray(panes)) return []
    const out: HerdrPane[] = []
    for (const p of panes) {
      if (typeof p?.pane_id === "string" && typeof p?.workspace_id === "string")
        out.push({
          paneId: p.pane_id,
          workspaceId: p.workspace_id,
          agent: typeof p.agent === "string" ? p.agent : null,
        })
    }
    return out
  } catch {
    return []
  }
}

/** A live `/build` supervisor is present iff some pane in `workspaceId` has agent === "claude". (pure) */
export function supervisorPresent(
  panes: HerdrPane[],
  workspaceId: string,
): boolean {
  return panes.some(
    (p) => p.workspaceId === workspaceId && p.agent === "claude",
  )
}

/**
 * The single non-dashboard pane — the recovery target — or null when it can't be
 * identified unambiguously (0 or >1 candidates), so restore skips rather than
 * risk a second supervisor. (pure)
 */
export function identifySupervisorPane(args: {
  panes: HerdrPane[]
  isDashboard: (paneId: string) => boolean
}): string | null {
  const candidates = args.panes.filter((p) => !args.isDashboard(p.paneId))
  return candidates.length === 1 ? (candidates[0] as HerdrPane).paneId : null
}

/**
 * The ids of every herdr workspace whose label matches `slug` (same predicate as
 * `matchHerdrWorkspaceId`, but returns ALL matches so restore can detect both
 * "already open" (1) and "ambiguous" (>1)). (pure)
 */
export function herdrWorkspacesForSlug(
  workspaces: HerdrWorkspace[],
  slug: string,
): string[] {
  const truncated = truncateHerdrLabel(slug)
  return workspaces
    .filter(
      (w) =>
        w.label === slug ||
        w.label === truncated ||
        (w.label.length === HERDR_LABEL_MAX && slug.startsWith(w.label)),
    )
    .map((w) => w.workspaceId)
}

// --- Result validation --------------------------------------------------------

export type RestoreTicket = {
  issueId: string
  issueUuid: string
  title: string
  branch: string | null
}

/**
 * Validate the restore select agent's JSON-array result. Rejects a non-array or
 * any malformed item, mirroring `parseSelectResult`'s strictness.
 */
export function parseRestoreResult(
  value: unknown,
  source: string,
): RestoreTicket[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `restore select agent wrote a non-array result at ${source}: ${JSON.stringify(value)?.slice(0, 200)}`,
    )
  }
  return value.map((item, i) => {
    const obj = item as Record<string, unknown> | null
    const valid =
      obj !== null &&
      typeof obj === "object" &&
      typeof obj.issueId === "string" &&
      obj.issueId.trim() !== "" &&
      typeof obj.issueUuid === "string" &&
      typeof obj.title === "string" &&
      obj.title.trim() !== "" &&
      (obj.branch === null || typeof obj.branch === "string")
    if (!valid) {
      throw new Error(
        `restore select agent wrote an invalid item [${i}] at ${source}: ${JSON.stringify(item)?.slice(0, 200)}`,
      )
    }
    return {
      issueId: obj.issueId as string,
      issueUuid: obj.issueUuid as string,
      title: obj.title as string,
      branch: (obj.branch as string | null) ?? null,
    }
  })
}

// --- Orchestration ------------------------------------------------------------

export type RestoreDeps = {
  runRestoreSelect: () => Promise<RestoreTicket[]>
  /** Short names: local refs + `origin/<name>` remote refs. */
  listAllBranches: () => string[]
  /** `git ls-remote --exit-code --heads origin <branch>` (code 0 ⇒ exists). */
  remoteBranchExists: (branch: string) => boolean
  /**
   * Best-effort `git fetch origin <branch>` so `origin/<branch>` is present in
   * THIS clone before we inspect it. `remoteBranchExists` (git ls-remote) only
   * proves the branch exists on the remote — it does not fetch — so without this
   * the slug-driving `lsTreeBuildDirs(origin/<branch>)` reads a missing ref and
   * returns []. Must not throw: the authoritative fetch (with error handling)
   * happens in `createWorktree`'s remote path; this is a pre-inspection priming.
   */
  fetchRemoteBranch: (branch: string) => void
  worktreeListPorcelain: () => string
  /** Whether a path already exists on disk (clobber guard). */
  pathExists: (path: string) => boolean
  /** Committed `build/*` dir names for `sourceRef` ([] if none/error). */
  lsTreeBuildDirs: (sourceRef: string) => string[]
  /** Light per-branch merged guard (gh); false on any error. */
  prMerged: (sourceRef: string) => boolean
  createWorktree: (a: {
    path: string
    branch: string
    mode: "local" | "remote" | "fresh"
    base: string
  }) => void
  herdrWorkspaceListRaw: () => string
  herdrPaneListRaw: (workspaceId: string) => string
  /** process-info → foreground cmdline contains `dashboard.ts`. */
  paneIsDashboard: (paneId: string) => boolean
  /** `startVisibleBuild` — two-pane workspace + `/build <slug>` supervisor. */
  startWorkspace: (a: {
    worktreePath: string
    slug: string
  }) => Promise<boolean>
  /** Re-run `claude "/build <slug>"` in an existing supervisor pane (code 0 ⇒ true). */
  runInPane: (a: { paneId: string; slug: string }) => boolean
  log: (m: string) => void
}

export type RestoreItemOutcome =
  | {
      issueId: string
      status: "created" | "already-present" | "started" | "recovered"
    }
  | { issueId: string; status: "skipped"; reason: string }

type RestoreContext = {
  branchIndex: Map<string, BranchRef>
  entries: WorktreeEntryWithBranch[]
  /** The MAIN checkout path (first worktree entry); gwt's sibling anchor. */
  mainPath: string
  deps: RestoreDeps
}

/** Restore a single ticket; returns its outcome (never throws — see `restore`). */
async function restoreOne(
  ticket: RestoreTicket,
  ctx: RestoreContext,
): Promise<RestoreItemOutcome> {
  const { branchIndex, entries, mainPath, deps } = ctx
  const { issueId, title } = ticket
  const skip = (reason: string): RestoreItemOutcome => ({
    issueId,
    status: "skipped",
    reason,
  })

  // (a) branch + (b) create mode / sourceRef.
  const resolved = resolveRestoreBranch({
    issueId,
    title,
    attachedBranch: ticket.branch,
    branchIndex,
  })
  let mode: "local" | "remote" | "fresh"
  let sourceRef: string | null
  if (resolved.localExists) {
    mode = "local"
    sourceRef = resolved.branch
  } else if (
    resolved.remoteExists ||
    deps.remoteBranchExists(resolved.branch)
  ) {
    mode = "remote"
    sourceRef = `origin/${resolved.branch}`
    // Prime origin/<branch> locally BEFORE the slug inspection below. A
    // remote-only attached branch (proven by git ls-remote, not yet fetched
    // into this clone) would otherwise make lsTreeBuildDirs(origin/<branch>)
    // return [], wrongly falling the slug back to slugify(title) for a
    // non-`<id>-<slug>` branch and breaking restore's resume contract.
    deps.fetchRemoteBranch(resolved.branch)
  } else {
    mode = "fresh"
    sourceRef = null
  }

  // (c) slug + worktree path.
  const slug = resolveRestoreSlug({
    branch: resolved.branch,
    title,
    committedBuildDirs: sourceRef ? deps.lsTreeBuildDirs(sourceRef) : [],
  })
  // gwt names the worktree off the BRANCH (not the slug): a sibling of the main
  // checkout. This must match where `gwt add <branch>` (in createWorktree) lands.
  const worktreePath = gwtWorktreeDir(mainPath, resolved.branch)

  // (d) already-merged guard — a merged PR should be Done, not resumed (resuming
  //     would just self-cleanup the workspace it rebuilt).
  if (sourceRef && deps.prMerged(sourceRef)) {
    return skip("PR already merged — should be Done, not restored")
  }

  // (e) worktree.
  const existing = findWorktreeForBranch(entries, resolved.branch)
  const effectiveWorktreePath = existing ?? worktreePath
  if (existing == null) {
    if (deps.pathExists(worktreePath)) {
      return skip(
        "worktree path occupied but not a registered worktree — inspect manually",
      )
    }
    if (mode === "fresh") {
      deps.log(
        `${issueId}: no existing branch found — scaffolding a fresh worktree; any work never pushed is unrecoverable`,
      )
    }
    deps.createWorktree({
      path: worktreePath,
      branch: resolved.branch,
      mode,
      base: KICKOFF_BASE_REF,
    })
  }

  // (f) workspace + supervisor.
  const wsIds = herdrWorkspacesForSlug(
    parseHerdrWorkspaceList(deps.herdrWorkspaceListRaw()),
    slug,
  )
  if (wsIds.length === 0) {
    let started: boolean
    try {
      started = await deps.startWorkspace({
        worktreePath: effectiveWorktreePath,
        slug,
      })
    } catch {
      // The supervisor `pane run` may have started (keystroke delivery isn't
      // provably atomic) — never risk a second supervisor; skip and let a human
      // inspect.
      return skip(
        "workspace created; /build supervisor state unknown — inspect & retry manually",
      )
    }
    return started
      ? { issueId, status: "started" }
      : skip(
          "herdr workspace could not be started; worktree left in place (re-run --restore to retry)",
        )
  }
  if (wsIds.length > 1) {
    return skip("multiple herdr workspaces match this slug — resolve manually")
  }
  const wsId = wsIds[0] as string
  const panes = parseHerdrPaneList(deps.herdrPaneListRaw(wsId))
  if (supervisorPresent(panes, wsId)) {
    return { issueId, status: "already-present" }
  }
  const paneId = identifySupervisorPane({
    panes,
    isDashboard: deps.paneIsDashboard,
  })
  if (paneId == null) {
    return skip(
      "workspace open but the supervisor pane could not be identified — inspect manually",
    )
  }
  return deps.runInPane({ paneId, slug })
    ? { issueId, status: "recovered" }
    : skip("could not re-run /build in the supervisor pane — inspect manually")
}

/**
 * Restore every in-scope ticket, best-effort: a single ticket's failure is
 * recorded as skip-with-reason and the pass continues. Returns 0 (restore never
 * fails the whole pass for one ticket).
 */
export async function restore(
  _repoRoot: string,
  _config: KickoffConfig,
  deps: RestoreDeps,
): Promise<number> {
  const tickets = await deps.runRestoreSelect()
  const branchIndex = indexBranches(deps.listAllBranches())
  const entries = parseWorktreeEntries(deps.worktreeListPorcelain())
  const mainPath = entries[0]?.path
  if (mainPath == null) {
    deps.log("restore: no worktrees listed — aborting")
    return 0
  }

  const outcomes: RestoreItemOutcome[] = []
  for (const ticket of tickets) {
    try {
      outcomes.push(
        await restoreOne(ticket, { branchIndex, entries, mainPath, deps }),
      )
    } catch (err) {
      outcomes.push({
        issueId: ticket.issueId,
        status: "skipped",
        reason: `unexpected error: ${(err as Error).message}`,
      })
    }
  }

  for (const o of outcomes) {
    deps.log(
      o.status === "skipped"
        ? `${o.issueId}: skipped — ${o.reason}`
        : `${o.issueId}: ${o.status}`,
    )
  }
  deps.log(`restore: processed ${outcomes.length} ticket(s)`)
  return 0
}
