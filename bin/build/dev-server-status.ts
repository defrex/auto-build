/**
 * Dev-server control slice for the build monitor dashboard (PRO-577).
 *
 * The dashboard is otherwise a pure read-only observer of `state.json`. The
 * managed dev server, however, is owned by a live herdr pane — its status can
 * change outside the panel and start/stop/restart mutate it — so it cannot flow
 * through `state.json`. This module owns that sanctioned active-affordance
 * exception, mirroring `auto-merge.ts` exactly:
 *  - pure helpers (keystroke classification, view reducers) take no IO and are
 *    exhaustively tested;
 *  - the IO wrappers shell out to the `dev-server-control.ts` CLI through an
 *    injectable async exec (the same `spawnExec` the auto-merge slice uses);
 *  - the `DevServerCoordinator` owns the live view + read/action concurrency, so
 *    the dashboard runner stays thin.
 *
 * Keys are `s`/`x`/`r` (start/stop/restart) — disjoint from auto-merge's
 * `a`/`q`/ctrl-c, so the two coordinators share the dashboard's stdin with no
 * collision.
 */

import type { DevServerStatus } from "./dev-server-control"
import type { ShResult } from "./repo"

/** What a control keystroke maps to (given controls are available). */
export type DevServerAction = "start" | "stop" | "restart"

/**
 * The dev-server slice of the dashboard view. Lives only in coordinator memory,
 * sourced from the live control CLI — deliberately NOT persisted in `state.json`.
 */
export type DevServerView = {
  /** True only when stdin is a TTY AND this is a herdr-framed build (pane present). */
  controlsAvailable: boolean
  /** Live status; null = no read has completed yet (checking…). */
  status: DevServerStatus | null
  /** True only while an action (start/stop/restart) is in flight → "…" ack. */
  busy: boolean
  /** Transient one-line notice: "starting…" / a brief error. */
  notice: string | null
}

/** Notices that represent in-progress work (cleared once the work settles). */
const PROGRESS_NOTICES = new Set([
  "starting…",
  "stopping…",
  "restarting…",
  "checking dev server…",
])
const READ_NOTICE = "checking dev server…"

// --- Pure helpers ----------------------------------------------------------

/** Classify a raw keystroke. `s`→start, `x`→stop, `r`→restart, else none. (pure) */
export function decideDevServerKeystroke(
  key: string,
): DevServerAction | "none" {
  if (key === "s" || key === "S") return "start"
  if (key === "x" || key === "X") return "stop"
  if (key === "r" || key === "R") return "restart"
  return "none"
}

/** The progress notice for an in-flight action. (pure) */
function actionNotice(action: DevServerAction): string {
  if (action === "start") return "starting…"
  if (action === "stop") return "stopping…"
  return "restarting…"
}

/** `bun run <control> <action> <buildDir>` argv (the control CLI). (pure) */
export function devServerActionCommand(
  controlScriptPath: string,
  action: DevServerAction | "status",
  buildDir: string,
): string[] {
  return ["bun", "run", controlScriptPath, action, buildDir]
}

/**
 * Parse the control CLI's `status` stdout (`"<status> (<url>)"`) into a status
 * value. Unrecognized → `"unreachable"` (we couldn't read a real status). (pure)
 */
export function parseDevServerStatusOutput(stdout: string): DevServerStatus {
  const first = stdout.trim().split(/\s+/)[0]
  if (
    first === "running" ||
    first === "starting" ||
    first === "stopped" ||
    first === "unreachable"
  )
    return first
  return "unreachable"
}

/** Map a failed action's ShResult to a brief, honest, action-aware notice. (pure) */
function briefDetail(action: DevServerAction): string {
  return `couldn't ${action} dev server`
}

// --- Pure view reducers ----------------------------------------------------

/**
 * Apply a keystroke to the view, returning the next view + the effect the runner
 * should run. The immediate-ack path: `busy` is set synchronously here, before
 * the async action begins. No-op when controls are unavailable or an action is
 * already in flight (overlap guard). (pure)
 */
export function applyDevServerKeystroke(
  view: DevServerView,
  key: string,
): { next: DevServerView; effect: DevServerAction | "none" } {
  const action = decideDevServerKeystroke(key)
  if (action === "none") return { next: view, effect: "none" }
  if (!view.controlsAvailable) return { next: view, effect: "none" }
  if (view.busy) return { next: view, effect: "none" } // overlap guard
  return {
    next: { ...view, busy: true, notice: actionNotice(action) },
    effect: action,
  }
}

/**
 * Apply a completed status read. Sets `status` to the read result; clears only
 * the transient *checking* notice; never touches `busy` (a read can be the
 * confirm step inside a live action). (pure)
 */
export function onDevServerStatusComplete(
  view: DevServerView,
  status: DevServerStatus,
): DevServerView {
  const notice = view.notice === READ_NOTICE ? null : view.notice
  return { ...view, status, notice }
}

/** Record an action failure: set a brief error notice; leave `busy` for `endAction`. (pure) */
export function onDevServerActionFailed(
  view: DevServerView,
  detail: string,
): DevServerView {
  return { ...view, notice: detail }
}

/**
 * Finalize an action: clear `busy`, and clear the notice only if it's still a
 * progress notice (preserving any error notice set by `onDevServerActionFailed`). (pure)
 */
export function endDevServerAction(view: DevServerView): DevServerView {
  const notice =
    view.notice && PROGRESS_NOTICES.has(view.notice) ? null : view.notice
  return { ...view, busy: false, notice }
}

/** Sync the per-tick input (`controlsAvailable`). (pure) */
export function tickDevServerView(
  view: DevServerView,
  { controlsAvailable }: { controlsAvailable: boolean },
): DevServerView {
  return { ...view, controlsAvailable }
}

// --- Async coordinator -----------------------------------------------------

/** IO seam for the coordinator (real or faked). Both bind buildDir/cwd in `main`. */
export type DevServerIo = {
  status: () => Promise<DevServerStatus>
  action: (action: DevServerAction) => Promise<ShResult>
}

/** The live, runner-facing coordinator returned by `createDevServerCoordinator`. */
export type DevServerCoordinator = {
  getView: () => DevServerView
  sync: (o: { controlsAvailable: boolean }) => void
  dueForRefresh: (intervalMs: number) => boolean
  refresh: () => Promise<void>
  keystroke: (key: string) => DevServerAction | "none"
  handleAction: (action: DevServerAction) => Promise<void>
}

/**
 * Create the dev-server coordinator. Owns the `DevServerView` plus the
 * status/action concurrency bookkeeping (kept off the view): `inFlight` guards
 * background cadence reads against pile-ups; an in-flight action suppresses
 * background reads (the action runs its own confirm read). All IO is
 * `.catch`-guarded, so `refresh`/`handleAction` never reject.
 */
export function createDevServerCoordinator(
  io: DevServerIo,
  opts: { now?: () => number } = {},
): DevServerCoordinator {
  const now = opts.now ?? Date.now
  let view: DevServerView = {
    controlsAvailable: false,
    status: null,
    busy: false,
    notice: null,
  }
  let inFlight = false
  let lastReadMs = 0

  async function safeStatus(): Promise<DevServerStatus> {
    try {
      return await io.status()
    } catch {
      return "unreachable"
    }
  }

  function getView(): DevServerView {
    return view
  }

  function sync(o: { controlsAvailable: boolean }): void {
    view = tickDevServerView(view, o)
  }

  function dueForRefresh(intervalMs: number): boolean {
    return !inFlight && !view.busy && now() - lastReadMs >= intervalMs
  }

  async function refresh(): Promise<void> {
    if (inFlight || view.busy) return
    inFlight = true
    try {
      const status = await safeStatus()
      view = onDevServerStatusComplete(view, status)
      lastReadMs = now()
    } finally {
      inFlight = false
    }
  }

  function keystroke(key: string): DevServerAction | "none" {
    const { next, effect } = applyDevServerKeystroke(view, key)
    view = next
    return effect
  }

  async function handleAction(action: DevServerAction): Promise<void> {
    // The keystroke reducer already set `busy` (immediate ack) + the overlap
    // guard prevented re-entry; set it defensively if somehow unset.
    if (!view.busy) view = { ...view, busy: true }
    try {
      let res: ShResult
      try {
        res = await io.action(action)
      } catch (err) {
        res = { code: 1, stdout: "", stderr: String(err) }
      }
      if (res.code !== 0)
        view = onDevServerActionFailed(view, briefDetail(action))
      // Forced confirm read so the status reflects real truth either way.
      const status = await safeStatus()
      view = onDevServerStatusComplete(view, status)
      lastReadMs = now()
    } finally {
      view = endDevServerAction(view)
    }
  }

  return { getView, sync, dueForRefresh, refresh, keystroke, handleAction }
}
