/**
 * Pluggable worktree provisioning for the kickoff run. A provider owns where a
 * worktree lives (`pathFor`), how slug collisions are detected
 * (`slugInUse`), and how the worktree gets created (`create`), so the
 * orchestration in `kickoff.ts` stays tool-agnostic and a new worktree
 * manager is a new provider + a config value, nothing more.
 *
 * Providers:
 *  - `git` — plain `git worktree add` into a sibling `../.kickoff-worktrees/<slug>`
 *    dir (the original behavior).
 *  - `superset` — `superset workspaces create`, so launched builds show up as
 *    first-class workspaces in the Superset app. The CLI returns before the
 *    checkout exists (a "Workspace Setup" terminal does it async), so `create`
 *    polls until the worktree is git-ready, then verifies the checkout is based
 *    on a fresh `origin/<base>` (the superset host owns the clone, so unlike
 *    the git provider we can't fetch-before-branch — staleness is only
 *    detectable after the fact, and is logged as a warning). Worktrees land at
 *    `~/.superset/worktrees/<projectId>/<branch>` — keyed by BRANCH, not
 *    workspace name. Prune with `superset workspaces delete <workspace-id>`
 *    (the id is logged at create time), not `git worktree remove`.
 *
 * UI visibility (superset only): the app's sidebar renders only workspaces
 * that have been OPENED — a synced-but-unopened workspace is invisible — so
 * `surface` fires `superset workspaces open <id>` after create. The build
 * itself launches via `startVisibleBuild` inside a `superset terminals create`
 * session (a live terminal tab in the app) that OUTLIVES the kickoff run. The
 * terminal runs an interactive `claude "/build <slug>"` supervisor session —
 * /build launches `bin/build.ts` in the background and stays attached, so
 * when the build parks on a blocker (NEEDS-INPUT.md) the session escalates it
 * to the user in the terminal. Builds still shepherd themselves to a PR;
 * nobody waits on them.
 *
 * All process boundaries are injectable for unit tests, mirroring the
 * `KickoffDeps` pattern in `kickoff.ts`.
 */

import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { type ShResult, sh } from "../build/repo"

export type WorktreeProviderName = "git" | "superset"

export type WorktreePathArgs = {
  repoRoot: string
  slug: string
  branch: string
}

export type WorktreeCreateArgs = WorktreePathArgs & {
  /** Base branch name (e.g. "main") — providers anchor to its remote tip. */
  base: string
}

/**
 * Provider-specific reference to a created worktree, threaded from `create`
 * into the optional UI hooks (`surface`, `startVisibleBuild`).
 */
export type WorktreeHandle = {
  /** Superset workspace id — absent for the git provider or if unparseable. */
  workspaceId?: string
}

export type WorktreeProvider = {
  name: WorktreeProviderName
  /** Absolute path the worktree for this slug/branch lives at. */
  pathFor: (args: WorktreePathArgs) => string
  /**
   * Whether ANY live worktree already uses this slug — regardless of which
   * issue it belongs to. Two concurrent builds sharing a slug would both write
   * `build/<slug>/` and collide at merge, so collisions are keyed by slug
   * alone even where the provider's paths are branch-keyed.
   */
  slugInUse: (args: { repoRoot: string; slug: string }) => boolean
  /** Create the worktree; resolves once it is git-ready to build in. */
  create: (args: WorktreeCreateArgs) => Promise<WorktreeHandle>
  /**
   * Surface the worktree in the tool's UI (best-effort, never throws).
   * Undefined for providers with no UI.
   */
  surface?: (handle: WorktreeHandle) => void
  /**
   * Launch the build DETACHED inside the tool's UI (a visible, attachable
   * session that outlives the kickoff run) and return true. Returns false when
   * the visible launch isn't possible — the caller should fall back to a
   * synchronous headless build.
   */
  startVisibleBuild?: (args: {
    handle: WorktreeHandle
    worktreePath: string
    slug: string
  }) => Promise<boolean>
}

type GitProviderHooks = {
  run?: (cmd: string[], cwd: string) => ShResult
  exists?: (path: string) => boolean
}

/**
 * Original provisioning: a sibling `../.kickoff-worktrees/<slug>` worktree,
 * fetched + branched off `origin/<base>` (never the kickoff run's current HEAD,
 * which may be a stale `main`, a feature branch, or another worktree).
 */
export function gitWorktreeProvider(
  hooks: GitProviderHooks = {},
): WorktreeProvider {
  const run = hooks.run ?? sh
  const exists = hooks.exists ?? existsSync
  const dirFor = (repoRoot: string, slug: string) =>
    join(dirname(repoRoot), ".kickoff-worktrees", slug)
  return {
    name: "git",
    pathFor: ({ repoRoot, slug }) => dirFor(repoRoot, slug),
    slugInUse: ({ repoRoot, slug }) => exists(dirFor(repoRoot, slug)),
    create: async ({ repoRoot, slug, branch, base }) => {
      const fetched = run(["git", "fetch", "origin", base], repoRoot)
      if (fetched.code !== 0) {
        throw new Error(
          `git fetch origin ${base} failed: ${fetched.stderr || fetched.stdout}`,
        )
      }
      const r = run(
        [
          "git",
          "worktree",
          "add",
          dirFor(repoRoot, slug),
          "-b",
          branch,
          `origin/${base}`,
        ],
        repoRoot,
      )
      if (r.code !== 0) {
        throw new Error(`git worktree add failed: ${r.stderr || r.stdout}`)
      }
      return {}
    },
  }
}

type SupersetProviderOpts = {
  /** Superset project UUID this repo maps to (`superset projects list --json`). */
  projectId: string
  log?: (message: string) => void
  run?: (cmd: string[], cwd: string) => ShResult
  isGitReady?: (path: string) => boolean
  listDir?: (path: string) => string[]
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  pollIntervalMs?: number
  homeDir?: string
}

const SUPERSET_READY_TIMEOUT_MS = 180_000
const SUPERSET_POLL_INTERVAL_MS = 2_000

/**
 * Provision via the Superset CLI. Requires an authenticated CLI
 * (`superset auth login`) and the host service running on this machine.
 */
export function supersetWorktreeProvider(
  opts: SupersetProviderOpts,
): WorktreeProvider {
  const {
    projectId,
    log = () => {},
    run = sh,
    isGitReady = defaultIsGitReady,
    listDir = defaultListDir,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs = SUPERSET_READY_TIMEOUT_MS,
    pollIntervalMs = SUPERSET_POLL_INTERVAL_MS,
    homeDir = homedir(),
  } = opts

  const worktreesRoot = join(homeDir, ".superset", "worktrees", projectId)

  const pathFor = ({ branch }: WorktreePathArgs) =>
    // Superset keys worktree dirs by branch name; slashes become subdirs.
    join(worktreesRoot, ...branch.split("/"))

  return {
    name: "superset",
    pathFor,
    // Branch dirs are `<issue-id>-<slug>` under the branch prefix
    // (`kickoffBranch` always uses "kickoff/"), so a suffix match
    // catches any issue already building this slug. Over-matching (a longer
    // slug ending in `-<slug>`) only costs a harmless `-2` bump.
    slugInUse: ({ slug }) =>
      listDir(join(worktreesRoot, "kickoff")).some((entry) =>
        entry.endsWith(`-${slug}`),
      ),
    create: async (args) => {
      const { repoRoot, slug, branch, base } = args
      const r = run(
        [
          "superset",
          "workspaces",
          "create",
          "--local",
          "--project",
          projectId,
          "--name",
          slug,
          "--branch",
          branch,
          "--base-branch",
          base,
          "--json",
        ],
        repoRoot,
      )
      if (r.code !== 0) {
        throw new Error(
          `superset workspaces create failed: ${r.stderr || r.stdout}`,
        )
      }
      const workspaceId = parseWorkspaceId(r.stdout)
      if (workspaceId) {
        log(
          `superset workspace ${workspaceId} created for ${branch} — prune later with \`superset workspaces delete ${workspaceId}\``,
        )
      } else {
        // Without the id the operator loses the prune handle — surface the
        // raw output so it can be recovered from the log.
        log(
          `superset workspace created for ${branch}, but its id could not be parsed from: ${r.stdout.slice(0, 200)}`,
        )
      }

      // The CLI returns before the checkout exists; wait for the async setup.
      const path = pathFor(args)
      const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs))
      for (let i = 0; ; i++) {
        if (isGitReady(path)) break
        if (i + 1 >= attempts) {
          throw new Error(
            `superset workspace ${workspaceId ?? branch} not ready after ${timeoutMs}ms (expected a git checkout at ${path})`,
          )
        }
        await sleep(pollIntervalMs)
      }

      warnIfStaleBase({ run, log, path, branch, base })
      return { workspaceId }
    },

    surface: (handle) => {
      if (!handle.workspaceId) return
      const r = run(
        ["superset", "workspaces", "open", handle.workspaceId],
        homeDir,
      )
      if (r.code !== 0) {
        log(
          `warning: could not open workspace ${handle.workspaceId} in the Superset app: ${r.stderr || r.stdout}`,
        )
      }
    },

    startVisibleBuild: async ({ handle, worktreePath, slug }) => {
      if (!handle.workspaceId) {
        log(
          "no superset workspace id on the handle — falling back to a headless build",
        )
        return false
      }
      // The terminal command depends on the claude CLI, which (unlike bun)
      // nothing else in the kickoff run proves present. A terminal whose
      // command dies on launch still reports detached success, stranding the
      // claimed issue with no build — so preflight here and fall back instead.
      const claudeCheck = run(["claude", "--version"], worktreePath)
      if (claudeCheck.code !== 0) {
        log(
          `claude CLI not runnable (${claudeCheck.stderr || claudeCheck.stdout}) — falling back to a headless build`,
        )
        return false
      }
      const r = run(
        [
          "superset",
          "terminals",
          "create",
          "--workspace",
          handle.workspaceId,
          "--cwd",
          worktreePath,
          "--command",
          // A supervising interactive session, not the bare script: /build
          // launches bin/build.ts in the background and stays attached, so
          // blockers (NEEDS-INPUT.md) get escalated to the user in the
          // terminal instead of parking silently.
          `claude "/build ${slug}"`,
          "--json",
        ],
        worktreePath,
      )
      if (r.code !== 0) {
        log(
          `warning: could not create a superset terminal (${r.stderr || r.stdout}) — falling back to a headless build`,
        )
        return false
      }
      log(
        `supervised /build session launched in superset terminal ${parseTerminalId(r.stdout) ?? "(unknown id)"} — watch it in workspace ${handle.workspaceId}`,
      )
      return true
    },
  }
}

/**
 * The superset host owns the clone the worktree was branched from, so we can't
 * fetch-before-branch the way the git provider does. Best effort after the
 * fact: fetch the base and check the checkout sits at-or-ahead of its tip.
 * Warn-only — the base may legitimately advance during the async setup, so a
 * hard failure here would abort fresh launches spuriously.
 */
function warnIfStaleBase(args: {
  run: (cmd: string[], cwd: string) => ShResult
  log: (message: string) => void
  path: string
  branch: string
  base: string
}): void {
  const { run, log, path, branch, base } = args
  const fetched = run(["git", "fetch", "origin", base], path)
  if (fetched.code !== 0) {
    log(
      `warning: could not verify ${branch} is based on a fresh origin/${base} (fetch failed: ${fetched.stderr || fetched.stdout})`,
    )
    return
  }
  const ancestor = run(
    ["git", "merge-base", "--is-ancestor", `origin/${base}`, "HEAD"],
    path,
  )
  if (ancestor.code !== 0) {
    log(
      `warning: ${branch} appears to be based on a stale ${base} (origin/${base} is not an ancestor of its HEAD) — the superset host's clone may need a fetch`,
    )
  }
}

function parseWorkspaceId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { workspace?: { id?: string } }
    return parsed.workspace?.id
  } catch {
    return undefined
  }
}

function parseTerminalId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as { terminalId?: string }
    return parsed.terminalId
  } catch {
    return undefined
  }
}

function defaultIsGitReady(path: string): boolean {
  return (
    existsSync(join(path, ".git")) &&
    sh(["git", "rev-parse", "--verify", "HEAD"], path).code === 0 &&
    // Mid-checkout, tracked files show as deleted; untracked setup artifacts
    // (e.g. a copied .env) won't block readiness thanks to -uno.
    sh(["git", "status", "--porcelain", "-uno"], path).stdout.trim() === ""
  )
}

function defaultListDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

export type MakeWorktreeProviderArgs = {
  provider: WorktreeProviderName
  supersetProjectId?: string
  log?: (message: string) => void
}

/**
 * Resolve the configured provider. This is the single swap point: kickoff
 * wiring calls this with `config.worktree` values and never names a provider.
 */
export function makeWorktreeProvider(
  args: MakeWorktreeProviderArgs,
): WorktreeProvider {
  if (args.provider === "superset") {
    if (!args.supersetProjectId?.trim()) {
      throw new Error(
        "worktree provider 'superset' requires supersetProjectId — pin it in build/kickoff/config.json (superset projects list --json)",
      )
    }
    return supersetWorktreeProvider({
      projectId: args.supersetProjectId,
      log: args.log,
    })
  }
  return gitWorktreeProvider()
}
