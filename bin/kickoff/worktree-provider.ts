/**
 * Pluggable worktree provisioning for the kickoff run. A provider owns where a
 * worktree lives (`pathFor`), how slug collisions are detected
 * (`slugInUse`), and how the worktree gets created (`create`), so the
 * orchestration in `kickoff.ts` stays tool-agnostic and a new worktree
 * manager is a new provider + a config value, nothing more.
 *
 * Providers:
 *  - `git` — `gwt add <branch>` (the user's git-worktree CLI), which creates a
 *    sibling `<project>-<safe-branch>` worktree AND runs full project setup
 *    (`worktree-init.sh`: env symlinks, `bun install`, Convex/Vercel config). The
 *    created path is read back from gwt's stdout, so the build always runs in a
 *    fully-provisioned worktree.
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

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { type ShResult, sh } from "../build/repo"
import { gwtWorktreeDir } from "./branch"

export type WorktreeProviderName = "git" | "superset" | "herdr"

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
  /**
   * Absolute path the provider actually created the worktree at. The git/herdr
   * provider sets this from `gwt add`'s stdout (gwt prints the path it created),
   * making it authoritative over the `pathFor` prediction. Absent for the
   * superset provider (its checkout path is computed, not reported).
   */
  path?: string
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
  listDir?: (path: string) => string[]
}

/**
 * Provision via `gwt add <branch>` (the user's git-worktree CLI). gwt creates a
 * sibling `<project>-<safe-branch>` worktree, auto-detecting local-branch /
 * remote-only / new-branch (the three modes the old hand-rolled git path
 * implemented), branches new ones off a freshly-fetched `origin/<default>`, and
 * runs `worktree-init.sh` for full project setup. `create` reads the created
 * path back from gwt's stdout (gwt sends informational output to stderr and only
 * the path to stdout), so the build path is always authoritative even though
 * `pathFor` can predict it.
 *
 * This assumes kickoff runs from (or anywhere inside) the repo whose MAIN
 * checkout is the worktree gwt anchors to — `pathFor`/`slugInUse` derive the
 * sibling layout from `repoRoot`, matching gwt's own `dirname(main)` anchoring.
 */
export function gitWorktreeProvider(
  hooks: GitProviderHooks = {},
): WorktreeProvider {
  const run = hooks.run ?? sh
  const listDir = hooks.listDir ?? defaultListDir
  return {
    name: "git",
    pathFor: ({ repoRoot, branch }) => gwtWorktreeDir(repoRoot, branch),
    // gwt names worktrees `<project>-<safe-branch>`; a kickoff branch always
    // ends in `-<slug>` (`kickoffBranch`), so a sibling dir of the main checkout
    // named `<project>-…-<slug>` means this slug is already building. Over-match
    // (a longer slug ending in `-<slug>`) only costs a harmless `-2` bump.
    slugInUse: ({ repoRoot, slug }) => {
      const prefix = `${basename(repoRoot)}-`
      return listDir(dirname(repoRoot)).some(
        (name) => name.startsWith(prefix) && name.endsWith(`-${slug}`),
      )
    },
    create: async ({ repoRoot, branch }) => {
      // Preflight: prove gwt is on PATH so a missing CLI is diagnosable and
      // distinct from a gwt run that fails (a stranded ticket otherwise looks
      // identical to a real worktree error).
      if (run(["gwt", "--version"], repoRoot).code !== 0) {
        throw new Error(
          "gwt not found on PATH — kickoff worktree creation requires the gwt CLI (it runs worktree-init.sh for full project setup). Install it and retry.",
        )
      }
      const r = run(["gwt", "add", branch], repoRoot)
      if (r.code !== 0) {
        throw new Error(`gwt add ${branch} failed: ${r.stderr || r.stdout}`)
      }
      // gwt prints ONLY the created path to stdout (info goes to stderr).
      const path = r.stdout.trim()
      return path ? { path } : {}
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
    // Branch dirs are `<issue-id>-<slug>` directly under `worktreesRoot`
    // (`kickoffBranch` is prefix-free, so there's no `kickoff/` subdir), so a
    // suffix match catches any issue already building this slug. Over-matching
    // (a longer slug ending in `-<slug>`) only costs a harmless `-2` bump.
    // Transition note: legacy worktrees created under the old `kickoff/` subdir
    // aren't scanned here; a same-slug re-kickoff mid-transition could double-
    // build until those drain. Acceptable (rare, self-resolving).
    slugInUse: ({ slug }) =>
      listDir(worktreesRoot).some((entry) => entry.endsWith(`-${slug}`)),
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

type HerdrProviderOpts = {
  log?: (message: string) => void
  /** Injectable process boundary for the herdr/claude CLIs (default `sh`). */
  run?: (cmd: string[], cwd: string) => ShResult
  /** Forwarded to the composed git provider for worktree mechanics. */
  gitHooks?: GitProviderHooks
  /**
   * Injectable file write for the dev-server pane-id record (default
   * `writeFileSync` + `mkdirSync`). Records `dev-server-pane.json` under the
   * build dir's gitignored `.build/` so the build process can find the pane.
   */
  writeFile?: (path: string, contents: string) => void
}

/**
 * Provision via `gwt` (reusing `gitWorktreeProvider` verbatim) and frame the
 * build inside a herdr workspace. herdr owns only the *visible build* surface —
 * worktree mechanics are the git provider's — so `pathFor`/`slugInUse`/`create`
 * delegate to the composed git provider, and only `startVisibleBuild` is
 * herdr-specific.
 *
 * `startVisibleBuild` opens one workspace (`--cwd` worktree, `--label` slug) with
 * THREE panes (PRO-577): the **left** runs the `claude "/build <slug>"`
 * supervisor (the same session the superset path launches today); a first split
 * (right) makes the **top-right** read-only monitor dashboard
 * (`bin/build/dashboard.ts`); a second split (down, off the monitor pane) makes
 * the **bottom-right** dev-server pane. The dev pane is created but NOT run — the
 * build launches the dev server into it lazily, only when e2e is needed. Its pane
 * id is recorded to `build/<slug>/.build/dev-server-pane.json` so the build
 * process can find it.
 *
 * The ordering makes the supervisor `pane run` the SINGLE commit point, so the
 * three `runBuildWithProvider` exits map deliberately onto the double-build guard:
 *  - `return true` ONLY after the supervisor command is delivered (exit 0);
 *  - `return false` for every provably-pre-supervisor failure (availability,
 *    claude preflight, workspace create, BOTH pane splits, the dev-pane record,
 *    and the REQUIRED monitor `pane run`) — no supervisor command was sent, so a
 *    headless fallback can't double-build;
 *  - `throw` ONLY when the supervisor `pane run` itself returns non-zero — herdr
 *    gives no atomic "nothing executed" guarantee for keystroke delivery into a
 *    live shell, so that result is *possibly-started* and must route through
 *    "propagate WITHOUT headless" rather than risk a second build.
 */
export function herdrWorktreeProvider(
  opts: HerdrProviderOpts = {},
): WorktreeProvider {
  const { log = () => {}, run = sh, writeFile = defaultWriteFile } = opts
  const git = gitWorktreeProvider(opts.gitHooks)

  return {
    name: "herdr",
    pathFor: git.pathFor,
    slugInUse: git.slugInUse,
    create: git.create,
    // No `surface`: unlike superset there is no pre-created workspace to open;
    // the workspace is created at launch time inside startVisibleBuild.
    startVisibleBuild: async ({ worktreePath, slug }) => {
      // 1. Availability preflight (covers daemon-down AND a missing CLI).
      if (run(["herdr", "workspace", "list"], worktreePath).code !== 0) {
        log(
          "herdr unavailable (CLI or daemon) — falling back to a headless build",
        )
        return false
      }

      // 2. claude preflight — pane 1 runs claude; a claude that dies on launch
      //    still reports detached success, so preflight here (mirrors superset).
      const claudeCheck = run(["claude", "--version"], worktreePath)
      if (claudeCheck.code !== 0) {
        log(
          `claude CLI not runnable (${claudeCheck.stderr || claudeCheck.stdout}) — falling back to a headless build`,
        )
        return false
      }

      // 3. Create the workspace.
      const created = run(
        [
          "herdr",
          "workspace",
          "create",
          "--cwd",
          worktreePath,
          "--label",
          slug,
          "--no-focus",
        ],
        worktreePath,
      )
      if (created.code !== 0) {
        log(
          `could not create a herdr workspace (${created.stderr || created.stdout}) — falling back to a headless build`,
        )
        return false
      }
      const { workspaceId, rootPaneId } = parseHerdrCreate(created.stdout)
      if (!workspaceId || !rootPaneId) {
        log(
          `could not parse the herdr workspace from: ${created.stdout.slice(0, 200)} — falling back to a headless build`,
        )
        return false
      }

      // 4. Split for the monitor pane.
      const split = run(
        [
          "herdr",
          "pane",
          "split",
          rootPaneId,
          "--direction",
          "right",
          "--cwd",
          worktreePath,
          "--no-focus",
        ],
        worktreePath,
      )
      const monitorPaneId = parseHerdrPaneId(split.stdout)
      if (split.code !== 0 || !monitorPaneId) {
        log(
          `could not split a herdr monitor pane (${split.stderr || split.stdout}) — falling back to a headless build`,
        )
        closeHerdrWorkspace(run, worktreePath, workspaceId)
        return false
      }

      // 5. Second split (down, off the monitor pane) for the dev-server pane —
      //    the bottom-right pane the build launches the dev server into lazily.
      const devSplit = run(
        [
          "herdr",
          "pane",
          "split",
          monitorPaneId,
          "--direction",
          "down",
          "--cwd",
          worktreePath,
          "--no-focus",
        ],
        worktreePath,
      )
      const devPaneId = parseHerdrPaneId(devSplit.stdout)
      if (devSplit.code !== 0 || !devPaneId) {
        log(
          `could not split a herdr dev-server pane (${devSplit.stderr || devSplit.stdout}) — falling back to a headless build`,
        )
        closeHerdrWorkspace(run, worktreePath, workspaceId)
        return false
      }

      // 6. Record the dev-server pane id where the build process reads it.
      //    Pre-supervisor, so a write failure → headless fallback (no command
      //    sent yet, double-build-safe). The build dir already exists (kickoff
      //    wrote spec.md into it before launch); `defaultWriteFile` mkdirs `.build/`.
      try {
        writeFile(
          join(worktreePath, "build", slug, ".build", "dev-server-pane.json"),
          `${JSON.stringify({ paneId: devPaneId, workspaceId, worktreePath }, null, 2)}\n`,
        )
      } catch (err) {
        log(
          `could not record the dev-server pane id (${(err as Error).message}) — falling back to a headless build`,
        )
        closeHerdrWorkspace(run, worktreePath, workspaceId)
        return false
      }

      // 7. Launch the monitor dashboard in the top-right pane (REQUIRED pane). Use
      //    the absolute script path AND pass the absolute build dir as the
      //    argument (the dashboard's path form) so the pane's cwd/git state is
      //    irrelevant — it watches that exact directory, no detectRepoRoot().
      const dashboardCmd = `bun run ${join(worktreePath, "bin/build/dashboard.ts")} ${join(worktreePath, "build", slug)}`
      const monitor = run(
        ["herdr", "pane", "run", monitorPaneId, dashboardCmd],
        worktreePath,
      )
      if (monitor.code !== 0) {
        // The spec mandates a two-pane workspace; the supervisor command has NOT
        // been sent yet, so this is unambiguously pre-start and double-build-safe.
        log(
          `could not launch the herdr monitor pane (${monitor.stderr || monitor.stdout}) — falling back to a headless build`,
        )
        closeHerdrWorkspace(run, worktreePath, workspaceId)
        return false
      }

      // 8. Launch the supervisor in the left pane — THE commit point. A non-zero
      //    exit here is ambiguous (keystroke delivery isn't provably atomic), so
      //    THROW to route through "propagate WITHOUT headless" — never return
      //    false (which could double-build) and never close the (maybe-live)
      //    workspace.
      const supervisor = run(
        ["herdr", "pane", "run", rootPaneId, `claude "/build ${slug}"`],
        worktreePath,
      )
      if (supervisor.code !== 0) {
        throw new Error(
          `herdr supervisor launch returned non-zero in workspace ${workspaceId}; the /build session may have started — inspect and clean up manually. stderr: ${supervisor.stderr || supervisor.stdout}`,
        )
      }
      log(
        `supervised /build session launched in herdr workspace ${workspaceId}`,
      )
      return true
    },
  }
}

/** Default dev-server pane record write: ensure `.build/` exists, then write. */
function defaultWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

/** Best-effort teardown of an orphaned (supervisor-less) workspace; never throws. */
function closeHerdrWorkspace(
  run: (cmd: string[], cwd: string) => ShResult,
  cwd: string,
  workspaceId: string,
): void {
  run(["herdr", "workspace", "close", workspaceId], cwd)
}

/** Parse `workspace_id` + the root (left) `pane_id` from `herdr workspace create`. */
function parseHerdrCreate(stdout: string): {
  workspaceId?: string
  rootPaneId?: string
} {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: {
        workspace?: { workspace_id?: string }
        root_pane?: { pane_id?: string }
      }
    }
    return {
      workspaceId: parsed.result?.workspace?.workspace_id,
      rootPaneId: parsed.result?.root_pane?.pane_id,
    }
  } catch {
    return {}
  }
}

/** Parse the new (right) `pane_id` from `herdr pane split`. */
function parseHerdrPaneId(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout) as {
      result?: { pane?: { pane_id?: string } }
    }
    return parsed.result?.pane?.pane_id
  } catch {
    return undefined
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
  if (args.provider === "herdr") {
    // herdr needs no project id — it uses a local gwt worktree + local daemon.
    return herdrWorktreeProvider({ log: args.log })
  }
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
