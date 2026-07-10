/**
 * Shared control surface for the externalized e2e dev server (PRO-577).
 *
 * The dev server no longer runs as an invisible in-process child. It lives in a
 * dedicated herdr pane (the build workspace's bottom-right pane), and this module
 * is the single mechanism that starts / stops / restarts / inspects it. Two
 * consumers share one implementation:
 *  - the e2e agent (programmatically, via the orchestrator's `withDevServer`
 *    seam), and
 *  - the dashboard (keyboard affordances → the CLI below).
 *
 * The split mirrors `auto-merge.ts`'s "pure logic + thin glue" convention:
 *  - pure helpers (path builders, serialize/parse, command builders, decisions,
 *    status summary) take no IO and are exhaustively unit-tested;
 *  - the IO actions take injectable seams (`run`/`reachable`/`wait`/`writeFile`/
 *    kill) so tests never spawn a real server;
 *  - the launcher's spawn/signal wiring is the only untested glue, kept thin and
 *    delegating the handle-write + group-kill to tested helpers.
 *
 * Two ephemeral files under `build/<slug>/.build/` (gitignored, local-only):
 *  - `dev-server-pane.json` — `{ paneId, workspaceId, worktreePath }`, written by
 *    the herdr provider at workspace-creation time. Its PRESENCE is the
 *    "herdr-framed build" signal.
 *  - `dev-server-handle.json` — `{ pid, pgid, devUrl, startedAt }`, written by the
 *    launcher process for itself; the killable handle.
 *
 * This module must NOT import `orchestrator.ts` (would cycle): the block/never-
 * reachable → `EscalateError` translation stays in `makeE2e`. Decisions here are
 * pure data the orchestrator interprets.
 */

import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { deriveDevUrl, reachable, waitUntilReachable } from "./dev-server"
import { type ShResult, sh } from "./repo"

/** Reference to the pre-created dev-server pane, recorded by the herdr provider. */
export type PaneRef = {
  paneId: string
  workspaceId?: string
  worktreePath?: string
}

/** The killable handle the launcher writes for itself. `pgid` kills the whole tree. */
export type DevServerHandle = {
  pid: number
  pgid: number
  devUrl: string
  startedAt: string
}

/** One-line dashboard status for the managed server. */
export type DevServerStatus = "running" | "starting" | "stopped" | "unreachable"

// --- Pure path helpers -----------------------------------------------------

/** Absolute path to the pane-ref file under the build dir's gitignored `.build/`. */
export function paneFilePath(buildDir: string): string {
  return join(buildDir, ".build", "dev-server-pane.json")
}

/** Absolute path to the killable-handle file under the build dir's `.build/`. */
export function handleFilePath(buildDir: string): string {
  return join(buildDir, ".build", "dev-server-handle.json")
}

// --- Pure serialize / parse (tolerant) -------------------------------------

/** Serialize a handle as pretty JSON with a trailing newline. (pure) */
export function serializeHandle(h: DevServerHandle): string {
  return `${JSON.stringify(h, null, 2)}\n`
}

/**
 * Parse a serialized handle. Tolerant: returns `null` on unparseable JSON or a
 * missing/non-numeric `pid`/`pgid` (a half-written or corrupt handle is "no
 * handle", never a crash). (pure)
 */
export function parseHandle(raw: string): DevServerHandle | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.pid !== "number" || typeof obj.pgid !== "number") return null
  if (typeof obj.devUrl !== "string" || obj.devUrl.length === 0) return null
  const startedAt = typeof obj.startedAt === "string" ? obj.startedAt : ""
  return { pid: obj.pid, pgid: obj.pgid, devUrl: obj.devUrl, startedAt }
}

/**
 * Parse a serialized pane ref. Tolerant: returns `null` on unparseable JSON or a
 * missing/empty `paneId` (the rest is optional metadata). (pure)
 */
export function parsePaneRef(raw: string): PaneRef | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const obj = parsed as Record<string, unknown>
  if (typeof obj.paneId !== "string" || obj.paneId.length === 0) return null
  return {
    paneId: obj.paneId,
    workspaceId:
      typeof obj.workspaceId === "string" ? obj.workspaceId : undefined,
    worktreePath:
      typeof obj.worktreePath === "string" ? obj.worktreePath : undefined,
  }
}

// --- Pure command / decision helpers ---------------------------------------

/**
 * The `herdr pane run <paneId> "bun run <control> run <buildDir>"` argv that
 * launches the long-lived launcher process inside the pre-created pane. (pure)
 */
export function paneRunCommand(
  paneRef: PaneRef,
  controlScriptPath: string,
  buildDir: string,
): string[] {
  return [
    "herdr",
    "pane",
    "run",
    paneRef.paneId,
    `bun run ${controlScriptPath} run ${buildDir}`,
  ]
}

/**
 * SIGTERM a detached process GROUP (negative pgid), best-effort. `bun run dev`
 * spawns a tree (next, dev:convex, portless) in its own group; signalling the
 * group tears the whole tree down, never orphaning children into a stale server.
 * Injectable `killImpl` for tests; swallows ESRCH/EPERM (group already gone).
 *
 * No-ops on `pgid <= 1`: a spawn-failed handle carries `pgid: 0`, and
 * `kill(-0, …)` signals the CALLER's own process group (and `kill(-1, …)` every
 * process the user owns) — a foot-gun a stale/corrupt handle must never trigger.
 */
export function killGroup(
  pgid: number,
  signal: NodeJS.Signals = "SIGTERM",
  killImpl: (pid: number, signal: NodeJS.Signals) => void = process.kill,
): void {
  if (pgid <= 1) return
  try {
    killImpl(-pgid, signal)
  } catch {
    // Group already gone / unsupported — best-effort.
  }
}

/** Is `pid` (the group leader) alive? `kill(pid, 0)` probes without signalling. (pure-ish) */
export function pidAlive(
  pid: number,
  killImpl: (pid: number, signal: number) => void = process.kill,
): boolean {
  try {
    killImpl(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Decision for the NON-kickoff (`/build` outside the herd) context: a reachable
 * URL means a human server is already up → use it read-only; nothing reachable
 * and e2e is needed → block for a human. (pure)
 */
export function decideExternalServer(
  isReachable: boolean,
): { kind: "use" } | { kind: "block"; reason: string } {
  if (isReachable) return { kind: "use" }
  return {
    kind: "block",
    reason:
      "no dev server reachable at the portless dev URL. Start your dev server " +
      '(or force e2e off via optionalStepOverrides.e2e="off" / BUILD_SKIP_E2E=1) and re-run',
  }
}

/**
 * Summarize the managed server's status for the dashboard line. (pure)
 *  - reachable          → running
 *  - launched, not yet  → starting   (handle + live pid, not answering)
 *  - handle but pid gone → unreachable (crashed; handle is stale)
 *  - no handle          → stopped
 */
export function summarizeStatus({
  handlePresent,
  pidAlive: alive,
  reachable: isReachable,
}: {
  handlePresent: boolean
  pidAlive: boolean
  reachable: boolean
}): DevServerStatus {
  if (isReachable) return "running"
  if (!handlePresent) return "stopped"
  return alive ? "starting" : "unreachable"
}

// --- Reads -----------------------------------------------------------------

/** Read + parse the pane ref, or `null` if absent/unparseable. */
export function readDevServerPane(buildDir: string): PaneRef | null {
  const path = paneFilePath(buildDir)
  if (!existsSync(path)) return null
  try {
    return parsePaneRef(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

/** Read + parse the killable handle, or `null` if absent/unparseable. */
export function readDevServerHandle(buildDir: string): DevServerHandle | null {
  const path = handleFilePath(buildDir)
  if (!existsSync(path)) return null
  try {
    return parseHandle(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

/**
 * The authoritative dev URL for this build dir: the persisted `state.json`
 * `devUrl` (set once by the orchestrator), falling back to deriving it from the
 * env + repo root when absent (old states / standalone runs).
 */
export function resolveDevUrl(
  buildDir: string,
  env: NodeJS.ProcessEnv,
): string {
  const repoRoot = dirname(dirname(buildDir))
  try {
    const parsed = JSON.parse(
      readFileSync(join(buildDir, "state.json"), "utf-8"),
    ) as { devUrl?: unknown }
    if (typeof parsed.devUrl === "string" && parsed.devUrl.length > 0)
      return parsed.devUrl
  } catch {
    // No/unreadable state.json — derive below.
  }
  return deriveDevUrl(env, repoRoot)
}

/** Write the killable handle (creates `.build/`). Injectable for tests. */
export function writeDevServerHandle(
  buildDir: string,
  handle: DevServerHandle,
  writeImpl: (path: string, contents: string) => void = defaultWriteFile,
): void {
  writeImpl(handleFilePath(buildDir), serializeHandle(handle))
}

function defaultWriteFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

// --- IO actions (injectable seams) -----------------------------------------

export type EnsureStartedDeps = {
  buildDir: string
  paneRef: PaneRef
  devUrl: string
  /** Absolute path to THIS control script (passed into the pane-run command). */
  controlScriptPath: string
  run?: (cmd: string[], cwd: string) => ShResult
  reachableImpl?: (url: string) => Promise<boolean>
  waitImpl?: (url: string) => Promise<boolean>
  /**
   * Skip the warm-reuse reachability no-op and always (re)launch. Used by
   * `restartDevServer`, where the server we just killed can still be answering
   * transiently during graceful SIGTERM shutdown — treating that as warm reuse
   * would return "up" without relaunching and leave no server once it exits.
   */
  force?: boolean
}

/**
 * Ensure the pane-managed dev server is up and serving `devUrl`. If it's already
 * reachable, no-op (warm reuse — repeated build↔validate revisits share one
 * server). Otherwise launch the launcher into the pane and wait for reachability.
 * Returns whether the server came up. Shared by the e2e closure and the dashboard
 * `start`/`restart`. Pass `force` to bypass warm reuse and always relaunch.
 */
export async function ensureDevServerStarted(
  deps: EnsureStartedDeps,
): Promise<boolean> {
  const {
    buildDir,
    paneRef,
    devUrl,
    controlScriptPath,
    run = sh,
    reachableImpl = (u: string) => reachable(u),
    waitImpl = (u: string) => waitUntilReachable(u),
    force = false,
  } = deps
  if (!force && (await reachableImpl(devUrl))) return true // warm reuse, no-op
  const cwd = paneRef.worktreePath ?? dirname(dirname(buildDir))
  run(paneRunCommand(paneRef, controlScriptPath, buildDir), cwd)
  return await waitImpl(devUrl)
}

export type StopDeps = {
  readHandle?: (buildDir: string) => DevServerHandle | null
  killImpl?: (pid: number, signal: NodeJS.Signals) => void
  unlink?: (path: string) => void
}

/**
 * Stop the managed server: read its handle, SIGTERM the whole process group, and
 * remove the handle file. No-op (returns false) when no handle is present.
 */
export function stopDevServer(buildDir: string, deps: StopDeps = {}): boolean {
  const {
    readHandle = readDevServerHandle,
    killImpl,
    unlink = (p: string) => rmSync(p, { force: true }),
  } = deps
  const handle = readHandle(buildDir)
  if (!handle) return false
  killGroup(handle.pgid, "SIGTERM", killImpl)
  unlink(handleFilePath(buildDir))
  return true
}

export type RestartDeps = EnsureStartedDeps &
  StopDeps & {
    /** Probe whether the killed group leader is still alive (defaults to real `pidAlive`). */
    pidAliveImpl?: (pid: number) => boolean
    /** Sleep between liveness polls while draining the killed group. */
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    /** Bound on waiting for the killed group to exit before force-relaunching. */
    drainTimeoutMs?: number
    drainIntervalMs?: number
  }

const defaultSleep = (ms: number) =>
  new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms))

/**
 * Restart: kill-via-handle, WAIT for the killed group to actually exit, then
 * force-relaunch in the pane. Never Ctrl-C / keystrokes.
 *
 * The wait + `force` are load-bearing. `bun run dev` (and its tree) keeps
 * answering the dev URL for a beat during graceful SIGTERM shutdown, so a naive
 * `stop(); ensureStarted()` would see that transiently-reachable dying server,
 * treat it as warm reuse, and return "up" WITHOUT relaunching — leaving no
 * server and no handle once the old process finally exits. So we capture the
 * handle first, kill, poll the old group leader's liveness until it's gone
 * (bounded by `drainTimeoutMs`), then start with `force: true` so a fresh
 * launcher always replaces the one we just killed regardless of transient
 * reachability.
 */
export async function restartDevServer(deps: RestartDeps): Promise<boolean> {
  const {
    readHandle = readDevServerHandle,
    pidAliveImpl = (pid: number) => pidAlive(pid),
    sleep = defaultSleep,
    now = () => Date.now(),
    drainTimeoutMs = 10_000,
    drainIntervalMs = 250,
  } = deps
  const handle = readHandle(deps.buildDir)
  stopDevServer(deps.buildDir, deps)
  if (handle && handle.pid > 1) {
    const deadline = now() + drainTimeoutMs
    while (now() < deadline && pidAliveImpl(handle.pid)) {
      await sleep(drainIntervalMs)
    }
  }
  return ensureDevServerStarted({ ...deps, force: true })
}

export type StatusDeps = {
  buildDir: string
  devUrl: string
  readHandle?: (buildDir: string) => DevServerHandle | null
  reachableImpl?: (url: string) => Promise<boolean>
  pidAliveImpl?: (pid: number) => boolean
}

/** Compute the managed server's status from handle presence + pid + reachability. */
export async function devServerStatus(
  deps: StatusDeps,
): Promise<DevServerStatus> {
  const {
    buildDir,
    devUrl,
    readHandle = readDevServerHandle,
    reachableImpl = (u: string) => reachable(u),
    pidAliveImpl = (pid: number) => pidAlive(pid),
  } = deps
  const handle = readHandle(buildDir)
  const isReachable = await reachableImpl(devUrl)
  return summarizeStatus({
    handlePresent: handle !== null,
    pidAlive: handle !== null && pidAliveImpl(handle.pgid),
    reachable: isReachable,
  })
}

// --- Launcher (thin spawn/signal glue; the long-lived pane process) ---------

/**
 * Env-var the build launcher sets so next.config hides the dev-tools indicator
 * for screenshot capture only. Mirror of SCREENSHOT_CAPTURE_ENV_VAR in
 * apps/web/src/lib/screenshot-capture-mode.ts (kept in sync by hand — the two
 * packages can't share a module).
 */
export const SCREENSHOT_CAPTURE_ENV_VAR = "BUILD_SCREENSHOT_CAPTURE"

/**
 * Build the child env for the capture dev server: the base env plus the
 * capture-mode flag. Pure + injectable so the launcher's spawn stays the only
 * untested glue. (pure)
 */
export function screenshotCaptureEnv(
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return { ...base, [SCREENSHOT_CAPTURE_ENV_VAR]: "1" }
}

/**
 * The long-lived process that owns the dev server, run inside the herdr pane via
 * `bun run <this> run <buildDir>`. Spawns the top-level `bun run dev` detached
 * (its own process group, so a later group-kill tears the whole tree down),
 * writes its killable handle, kills the group + removes the handle on
 * SIGINT/SIGTERM, and awaits the child's exit. `stdio: "inherit"` so the dev
 * server's output shows in the pane (the visibility this feature exists for).
 */
export async function runDevServerLauncher(
  buildDir: string,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const repoRoot = dirname(dirname(buildDir))
  const devUrl = resolveDevUrl(buildDir, env)
  const child = spawn("bun", ["run", "dev"], {
    cwd: repoRoot,
    stdio: "inherit",
    detached: true,
    env: screenshotCaptureEnv(env),
  })
  const pid = child.pid ?? 0
  writeDevServerHandle(buildDir, {
    pid,
    pgid: pid,
    devUrl,
    startedAt: new Date().toISOString(),
  })
  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    if (pid) killGroup(pid, "SIGTERM")
    rmSync(handleFilePath(buildDir), { force: true })
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      cleanup()
      process.exit(0)
    })
  }
  return await new Promise<number>((resolveExit) => {
    child.on("exit", (code) => {
      cleanup()
      resolveExit(code ?? 0)
    })
  })
}

// --- CLI (import.meta.main) -------------------------------------------------

/**
 * Dispatch `argv[2]` ∈ `run | start | stop | restart | status` over
 * `argv[3] = buildDir`. `run` is the launcher (the pane's long-lived process);
 * the others are the agent/dashboard control verbs. Resolves to a process exit
 * code. The control script path is `__filename` (resolved) so the pane command
 * always points back at this exact file.
 */
async function cliMain(argv: string[]): Promise<number> {
  const action = argv[2]
  const buildDirArg = argv[3]
  if (!buildDirArg) {
    process.stderr.write(
      "usage: dev-server-control <run|start|stop|restart|status> <buildDir>\n",
    )
    return 2
  }
  const buildDir = resolve(buildDirArg)
  const controlScriptPath = resolve(import.meta.path ?? process.argv[1] ?? "")
  const devUrl = resolveDevUrl(buildDir, process.env)

  switch (action) {
    case "run":
      return runDevServerLauncher(buildDir, process.env)
    case "start": {
      const paneRef = readDevServerPane(buildDir)
      if (!paneRef) {
        process.stderr.write(
          "dev-server start: not a herdr-framed build (no dev-server-pane.json)\n",
        )
        return 1
      }
      const up = await ensureDevServerStarted({
        buildDir,
        paneRef,
        devUrl,
        controlScriptPath,
      })
      return up ? 0 : 1
    }
    case "stop":
      return stopDevServer(buildDir) ? 0 : 1
    case "restart": {
      const paneRef = readDevServerPane(buildDir)
      if (!paneRef) {
        process.stderr.write(
          "dev-server restart: not a herdr-framed build (no dev-server-pane.json)\n",
        )
        return 1
      }
      const up = await restartDevServer({
        buildDir,
        paneRef,
        devUrl,
        controlScriptPath,
      })
      return up ? 0 : 1
    }
    case "status": {
      const status = await devServerStatus({ buildDir, devUrl })
      process.stdout.write(`${status} (${devUrl})\n`)
      return status === "running" ? 0 : 1
    }
    default:
      process.stderr.write(
        "usage: dev-server-control <run|start|stop|restart|status> <buildDir>\n",
      )
      return 2
  }
}

if (import.meta.main) {
  void cliMain(process.argv).then((code) => process.exit(code))
}
