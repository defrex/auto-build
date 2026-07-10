/**
 * Thin git/gh shell wrappers for the PR + monitor phases.
 *
 * Kept separate from the orchestrator so the pure decision logic in
 * `monitor.ts` stays testable; these are integration glue around the local
 * `git` and `gh` binaries.
 */

import { spawnSync } from "node:child_process"
import { type PrSnapshot, parsePrSnapshot } from "./monitor"

export type ShResult = { code: number; stdout: string; stderr: string }

/** Run a command synchronously, capturing stdout/stderr. */
export function sh(cmd: string[], cwd: string): ShResult {
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf-8" })
  return {
    code: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  }
}

/** Absolute path to the repo root, or throw if not in a git repo. */
export function detectRepoRoot(cwd: string = process.cwd()): string {
  const r = sh(["git", "rev-parse", "--show-toplevel"], cwd)
  if (r.code !== 0) throw new Error("build must run inside a git repository")
  return r.stdout.trim()
}

/** Current branch name. */
export function detectBranch(repoRoot: string): string {
  return sh(
    ["git", "rev-parse", "--abbrev-ref", "HEAD"],
    repoRoot,
  ).stdout.trim()
}

/** Current HEAD commit SHA (full 40-char), or "" on failure. */
export function detectHeadSha(repoRoot: string): string {
  return sh(["git", "rev-parse", "HEAD"], repoRoot).stdout.trim()
}

/** The PR number for the current branch, or null if none exists yet. */
export function detectPrNumber(repoRoot: string): number | null {
  const r = sh(
    ["gh", "pr", "view", "--json", "number", "-q", ".number"],
    repoRoot,
  )
  if (r.code !== 0) return null
  const n = Number.parseInt(r.stdout.trim(), 10)
  return Number.isNaN(n) ? null : n
}

/**
 * Full URL of the PR numbered `prNumber`, or null if it can't be resolved.
 * Uses the explicit number (not the current-branch form) because after a merge
 * the branch may be deleted.
 *
 * `exec` is injectable for testing; production callers use the default `sh`.
 */
export function detectPrUrl(
  repoRoot: string,
  prNumber: number,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): string | null {
  const r = exec(
    ["gh", "pr", "view", String(prNumber), "--json", "url", "-q", ".url"],
    repoRoot,
  )
  if (r.code !== 0) return null
  const url = r.stdout.trim()
  return url === "" ? null : url
}

/**
 * Read the live PR state string for `prNumber` ("OPEN"/"MERGED"/"CLOSED"/…),
 * keyed on the explicit number so it survives a deleted branch. Returns
 * `"UNKNOWN"` on any non-zero exit (fail-safe: callers treat a non-terminal read
 * as "not merged/closed" rather than silently recovering).
 *
 * `exec` is injectable for testing; production callers use the default `sh`.
 */
export function fetchPrState(
  repoRoot: string,
  prNumber: number,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): string {
  const r = exec(
    ["gh", "pr", "view", String(prNumber), "--json", "state", "-q", ".state"],
    repoRoot,
  )
  return r.code === 0 ? r.stdout.trim() : "UNKNOWN"
}

/**
 * Whether `prNumber` is MERGED (used for cleanup's idempotent re-check). Keys on
 * the explicit number so it survives a deleted branch. `false` on any non-zero
 * exit or non-MERGED state.
 *
 * `exec` is injectable for testing; production callers use the default `sh`.
 */
export function isPrMerged(
  repoRoot: string,
  prNumber: number,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): boolean {
  return fetchPrState(repoRoot, prNumber, exec) === "MERGED"
}

/**
 * `git worktree list --porcelain` stdout, or "" on failure (parsed by
 * `cleanup.ts`'s `parseWorktreeList`). The main worktree is listed first.
 *
 * `exec` is injectable for testing; production callers use the default `sh`.
 */
export function worktreeListPorcelain(
  repoRoot: string,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): string {
  const r = exec(["git", "worktree", "list", "--porcelain"], repoRoot)
  return r.code === 0 ? r.stdout : ""
}

/**
 * `git -C <fromMain> worktree remove --force <worktreePath>`; returns the
 * ShResult verbatim (the caller treats a non-zero code as a recoverable
 * leftover). Driven from the MAIN worktree because git refuses to remove the
 * worktree you are currently inside.
 *
 * `exec` is injectable for testing; production callers use the default `sh`.
 */
export function removeWorktree(
  fromMain: string,
  worktreePath: string,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): ShResult {
  return exec(
    ["git", "-C", fromMain, "worktree", "remove", "--force", worktreePath],
    fromMain,
  )
}

/**
 * Best-effort escalation when `git worktree remove --force` fails: blow away
 * the leftover worktree directory with `rm -rf`, then (only if that cleared the
 * directory) `git worktree prune` so git's worktree bookkeeping forgets the
 * now-removed checkout. Returns a non-zero ShResult when EITHER step fails, so
 * the caller can detect (and log) that litter remains — a successful prune must
 * never mask a failed `rm -rf`. Driven from the MAIN worktree, like
 * removeWorktree.
 *
 * `exec` is injectable for testing; production callers use the default `sh`.
 */
export function forceRemoveWorktreeDir(
  fromMain: string,
  worktreePath: string,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): ShResult {
  const removed = exec(["rm", "-rf", worktreePath], fromMain)
  // `rm -rf` failed → the directory still (partly) exists; `git worktree prune`
  // only deregisters worktrees whose dir is GONE, so it would no-op while
  // wrongly reporting success. Surface the removal failure instead.
  if (removed.code !== 0) return removed
  return exec(["git", "-C", fromMain, "worktree", "prune"], fromMain)
}

// first: 100 caps the count — a PR with >100 review threads under-reports
// unresolved threads. That's far beyond any realistic Dispatch PR; revisit only
// if monitor declares "done" while threads remain open.
const UNRESOLVED_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { nodes { isResolved } }
    }
  }
}`

/** Result of comparing the local branch against freshly-fetched origin/<base>. */
export type BehindBaseResult =
  | { fetchOk: true; behind: boolean }
  | { fetchOk: false }

/**
 * Determine whether origin/<base> has commits the local branch lacks, by
 * fetching the base first and comparing directly — independent of branch
 * protection (unlike GitHub's mergeStateStatus). On fetch failure returns
 * { fetchOk: false } so the caller can decline to certify "current" rather than
 * mistaking a stale ref for up-to-date; the next poll re-fetches and self-corrects.
 *
 * `exec` is injectable for testing; production callers use the default `sh`.
 */
export function isBranchBehindBase(
  repoRoot: string,
  baseBranch: string,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): BehindBaseResult {
  const fetched = exec(["git", "fetch", "origin", baseBranch], repoRoot)
  if (fetched.code !== 0) return { fetchOk: false }
  const r = exec(
    ["git", "rev-list", "--count", `HEAD..origin/${baseBranch}`],
    repoRoot,
  )
  // A non-zero rev-list (or unparseable count) means the direct comparison
  // against origin/<base> did NOT succeed — the fetch landing is not enough.
  // Report it as a comparison failure (fetchOk: false) so the caller declines
  // to certify "current"/announce `ready` on an uncertified branch, rather than
  // letting empty/NaN stdout collapse to behind:false. The next poll retries.
  const n = Number.parseInt(r.stdout.trim(), 10)
  if (r.code !== 0 || !Number.isFinite(n)) return { fetchOk: false }
  return { fetchOk: true, behind: n > 0 }
}

/** Poll the live PR state into a snapshot (gh pr view + unresolved-thread count + behind-base). */
export function fetchPrSnapshot(
  repoRoot: string,
  prNumber: number,
  baseBranch: string,
): PrSnapshot {
  // Defense-in-depth against the monitor merge race: run the base-fetch FIRST so
  // the `gh pr view` `state` read below is the freshest terminal signal in each
  // poll. This shrinks (but does not close) the window in which a merge landing
  // mid-poll yields `OPEN + behind`; the post-failure re-check in the monitor
  // phase's `act` handler is the real recovery.
  const behind = isBranchBehindBase(repoRoot, baseBranch)

  const nameWithOwner = sh(
    ["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    repoRoot,
  ).stdout.trim()
  const [owner, name] = nameWithOwner.split("/")
  const graph = sh(
    [
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${UNRESOLVED_THREADS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `number=${prNumber}`,
      "--jq",
      "[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length",
    ],
    repoRoot,
  )
  const unresolved = Number.parseInt(graph.stdout.trim() || "0", 10) || 0

  const view = sh(
    [
      "gh",
      "pr",
      "view",
      "--json",
      "state,mergeable,mergeStateStatus,statusCheckRollup",
    ],
    repoRoot,
  )
  const json = view.code === 0 ? JSON.parse(view.stdout || "{}") : {}
  return parsePrSnapshot(
    json,
    unresolved,
    behind.fetchOk ? behind.behind : false, // behindBase (false when fetch failed → won't rebase)
    behind.fetchOk, // baseFetchOk (gates `ready`)
  )
}

/** Explicit result of a publish attempt against the still-open PR branch. */
export type PublishResult =
  | { status: "pushed" }
  | { status: "clean" }
  | { status: "failed"; detail: string }

/**
 * Stage build/<feature> and commit it if dirty. No push. Returns the commit
 * ShResult, or the no-op sentinel {code:0,stdout:"",stderr:""} when nothing
 * changed. Used to clean the worktree before a merge (the merge's push then
 * carries the commit) and to capture trailing local bookkeeping after a
 * terminal merged/closed (which can't be pushed). Scoped to `build/<feature>`
 * (the transient `.build/` scratch dir is gitignored).
 *
 * The `git add` result is checked FIRST: a failed stage (index lock, bad path,
 * fs/permission error) would otherwise leave nothing staged, the cached-diff
 * probe would exit 0, and we'd return the no-op sentinel — which publishArtifacts
 * would mistake for "clean" and falsely announce ready with the artifacts never
 * committed/pushed. On a non-zero `git add` we return that failing result
 * immediately and run NO diff/commit, so the caller sees the failure.
 *
 * `exec` is injectable for testing; production callers use the default `sh`.
 */
export function commitArtifacts(
  repoRoot: string,
  feature: string,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): ShResult {
  const dir = `build/${feature}`
  const added = exec(["git", "add", "--", dir], repoRoot)
  if (added.code !== 0) return added // do NOT fall through to diff/commit
  // `git diff --cached --quiet` exits 0 when nothing is staged → nothing to do.
  const staged = exec(
    ["git", "diff", "--cached", "--quiet", "--", dir],
    repoRoot,
  )
  // Self-describing no-op result (don't surface the diff probe's output).
  if (staged.code === 0) return { code: 0, stdout: "", stderr: "" }
  return exec(
    [
      "git",
      "commit",
      "-m",
      `build(${feature}): capture pipeline artifacts`,
      "--",
      dir,
    ],
    repoRoot,
  )
}

/**
 * One-time PRO-667 convergence: if a build dir still has the pre-move,
 * git-tracked `build/<feature>/heartbeat.json`, remove it from git (index +
 * working tree). The heartbeat now lives in the gitignored `.build/` scratch
 * dir, so the tracked copy would otherwise sit stale forever (and the monitor's
 * publish pass would re-commit it every idle tick). The staged deletion is a
 * meaningful, one-time change picked up by the next `commitArtifacts`
 * (reconcile/publish). No-op (and no `git rm`) when the file is not tracked.
 *
 * `exec` is injectable for testing; production callers use the default `sh`.
 */
export function untrackLegacyHeartbeat(
  repoRoot: string,
  feature: string,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): ShResult {
  const path = `build/${feature}/heartbeat.json`
  const listed = exec(["git", "ls-files", "--", path], repoRoot)
  if (listed.code !== 0 || listed.stdout.trim() === "")
    return { code: 0, stdout: "", stderr: "" } // not tracked → no-op sentinel
  return exec(["git", "rm", "-f", "--", path], repoRoot)
}

/**
 * Publish artifacts to the still-open PR branch with an explicit outcome.
 *  1. commitArtifacts (commit-only) — failure ⇒ { status: "failed" }.
 *  2. Plain push whenever the local branch is AHEAD of its upstream. This covers
 *     (a) the commit we just made and (b) a PRIOR commit whose push failed (tree
 *     is clean now but the commit never reached the remote) — keying off "ahead",
 *     not "dirty", is what closes that edge case.
 *  3. nothing committed AND provably in sync (`@{u}..HEAD` == 0) ⇒ { status: "clean" }.
 * A plain (non-force) push is safe because the resident loop reconciles via
 * `git merge` (see reconcileWithBase), which only ever appends to the branch and
 * never rewrites history — so every push is a fast-forward. The monitor is the
 * effective sole writer; if the remote ever legitimately moved ahead (another
 * writer), a plain push rejecting non-fast-forward is the correct, safe outcome
 * (better than force-clobbering someone else's commit). A "failed" status NEVER
 * reads as "clean": the caller must not announce ready on it.
 *
 * `exec` is injectable for testing; production callers use the default `sh`.
 */
export function publishArtifacts(
  repoRoot: string,
  feature: string,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): PublishResult {
  const committed = commitArtifacts(repoRoot, feature, exec)
  if (committed.code !== 0)
    return {
      status: "failed",
      detail: committed.stderr.trim() || "artifact commit failed",
    }
  const madeCommit = !(committed.stdout === "" && committed.stderr === "")
  const ahead = exec(["git", "rev-list", "--count", "@{u}..HEAD"], repoRoot)
  const inSync =
    ahead.code === 0 && Number.parseInt(ahead.stdout.trim(), 10) === 0
  if (!madeCommit && inSync) return { status: "clean" }
  const pushed = exec(["git", "push"], repoRoot)
  if (pushed.code !== 0)
    return {
      status: "failed",
      detail: pushed.stderr.trim() || "artifact push failed",
    }
  return { status: "pushed" }
}

/**
 * Reconcile the branch with its base by MERGING `origin/<base>` into it and
 * pushing plainly (no force). Dispatch's repo is squash-merge only, so the
 * branch's history is discarded on land — a merge commit costs nothing and a
 * linear branch buys us nothing. A merge reconciles only the *new* upstream
 * commits once (no full-series replay of a rebase), needs no history rewrite,
 * and squash-merge flattens the merge commit away on land — so the plain push is
 * always a fast-forward.
 *
 * The build dir is committed FIRST (commit-only, no push): a dirty tracked
 * `build/<feature>` (the build.log line appended immediately before this call)
 * would otherwise abort the merge with "you have unstaged changes". If that
 * commit fails, the failure is returned before any fetch/merge — a dirty-tree
 * commit failure must not masquerade as a merge conflict. The artifact commit
 * rides along on the branch via the push. On conflict the merge is aborted (so
 * the worktree is never left mid-merge, and the caller's PRO-588 recovery can
 * re-read PR state on a clean tree) and the failed result is returned for the
 * caller to escalate — an unattended pipeline can't resolve conflicts itself.
 *
 * `exec` is injectable for testing; production callers use the default `sh`.
 */
export function reconcileWithBase(
  repoRoot: string,
  baseBranch: string,
  feature: string,
  exec: (cmd: string[], cwd: string) => ShResult = sh,
): ShResult {
  const committed = commitArtifacts(repoRoot, feature, exec)
  if (committed.code !== 0) return committed
  // The merge MUST be against a fresh origin/<base>. A failed fetch would leave a
  // stale local ref, and merging+pushing onto stale data is worse than doing
  // nothing — the spec says failed fetches stay unknown/active rather than acting
  // on stale state. Return the fetch failure before touching `git merge`.
  const fetched = exec(["git", "fetch", "origin", baseBranch], repoRoot)
  if (fetched.code !== 0) return fetched
  const merge = exec(
    ["git", "merge", `origin/${baseBranch}`, "--no-edit"],
    repoRoot,
  )
  if (merge.code !== 0) {
    exec(["git", "merge", "--abort"], repoRoot)
    return merge
  }
  return exec(["git", "push"], repoRoot)
}
