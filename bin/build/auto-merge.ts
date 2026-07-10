/**
 * GitHub native auto-merge support for the build monitor panel.
 *
 * The panel (`dashboard.ts`) is otherwise a pure read-only observer of
 * `state.json`. Auto-merge state, however, is owned by GitHub — it can change
 * outside the panel and toggling it mutates GitHub — so it cannot flow through
 * `state.json`. This module owns that one sanctioned exception: live `gh` reads
 * and toggles, kept self-contained and unit-testable.
 *
 * The split mirrors the repo's "pure logic + thin glue" convention:
 *  - pure helpers (parsing, command builders, decisions, view reducers) take no
 *    IO and are exhaustively tested;
 *  - the IO wrappers take an *injectable async* exec so tests never spawn `gh`
 *    (production callers get the default `spawn`-based runner);
 *  - the `AutoMergeCoordinator` owns the live `AutoMergeView` plus the read /
 *    toggle concurrency (request tokens), so the runner stays thin.
 *
 * Unlike `repo.ts`'s synchronous `sh`-based wrappers, these are async: a ~1s
 * `gh` call must never block the panel's 1s render loop.
 */

import { spawn } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import type { ShResult } from "./repo"

/** Live auto-merge truth for the PR. `unknown` = a read failed (never a false off). */
export type AutoMergeState = "on" | "off" | "unknown"

/** What a toggle keystroke should do given the *known* current state. */
export type ToggleAction = "enable" | "disable" | "read-first"

/** An injectable async command runner. Must resolve (never reject) to a ShResult. */
export type AsyncExec = (cmd: string[], cwd: string) => Promise<ShResult>

/**
 * The auto-merge slice of the dashboard view. Lives only in coordinator memory,
 * sourced from live `gh` — deliberately NOT persisted in `state.json`.
 */
export type AutoMergeView = {
  /** True once a PR exists (`state.prNumber` known) → toggle is applicable. */
  prKnown: boolean
  /** Live gh-read state; null = no read has completed yet (checking…). */
  state: AutoMergeState | null
  /**
   * True only while a *toggle* (its read-first, mutate, and confirm-read steps)
   * is in flight → render an immediate "…" ack. NOT set by the silent background
   * cadence read.
   */
  toggleBusy: boolean
  /** Transient one-line notice: "auto-merge armed" / "enabling…" / a brief error. */
  notice: string | null
  /** True only when stdin is a TTY AND a PR exists → advertise the `a` hint. */
  toggleAvailable: boolean
  /**
   * Armed pre-PR intent (PRO-660): auto-merge will be enabled by the build as
   * soon as the PR exists. Sourced from the durable `.build/` marker each poll,
   * NEVER from an unshared in-memory value — the build-side actor consumes it.
   * Drives the distinct cyan "Pending" indicator.
   */
  pending: boolean
  /**
   * True when stdin is a TTY → the arm/disarm affordance is live. Distinct from
   * `toggleAvailable` (`isTty && prKnown`) so the arm hint shows PRE-PR.
   */
  armAvailable: boolean
  /**
   * Brief detail of the most recent FAILED build-side apply, reconciled from the
   * apply-error file each poll (display TTL-resolved). Rendered as a red notice
   * on the Pending line. `null` = no recent apply failure.
   */
  applyError: string | null
}

/** Notices that represent in-progress work (cleared once the work settles). */
const PROGRESS_NOTICES = new Set([
  "enabling…",
  "disabling…",
  "checking auto-merge…",
])
/** The subset of progress notices owned by a routine read (vs a toggle). */
const READ_NOTICE = "checking auto-merge…"

/**
 * How long a transient arm/disarm confirmation notice stays visible before it
 * self-clears. Long enough to survive several ~1s render ticks (so a watcher
 * actually sees the brief feedback the spec requires), short enough that it never
 * sticks on screen. (The Pending *indicator* itself persists via `view.pending`;
 * only the confirmation *notice* self-clears.)
 */
export const TRANSIENT_NOTICE_TTL_MS = 3_000

/**
 * How long a failed-apply notice stays visible in the panel after the applier
 * last wrote it. MUST exceed the orchestrator's `IDLE_POLL_MS` (180_000) so the
 * notice does not flicker between idle-cadence retries; the applier rewrites
 * `atMs` on every failed retry, so the file stays fresh well inside the TTL while
 * retries continue, and self-clears only if the orchestrator dies mid-failure.
 * (Do NOT import `IDLE_POLL_MS` from `orchestrator.ts` — naming it here avoids a
 * cross-module coupling.)
 */
export const APPLY_ERROR_TTL_MS = 300_000

// --- Pure helpers ----------------------------------------------------------

/**
 * Classify a parsed `gh pr view --json autoMergeRequest` payload. This is the
 * lowest parsing layer and owns the absent-key rule: a non-null object →
 * `"on"`; the key present and explicitly `null` → `"off"`; the key absent (or a
 * non-object input) → `"unknown"`, NEVER a false `"off"` (gh always includes the
 * key, so its absence means a malformed/partial read). (pure)
 */
export function parseAutoMergeState(viewJson: unknown): AutoMergeState {
  if (typeof viewJson !== "object" || viewJson === null) return "unknown"
  if (!("autoMergeRequest" in viewJson)) return "unknown"
  const req = (viewJson as { autoMergeRequest: unknown }).autoMergeRequest
  if (req === null) return "off"
  if (typeof req === "object") return "on"
  return "unknown"
}

/** `gh pr view <n> --json autoMergeRequest` argv. (pure) */
export function autoMergeReadCommand(prNumber: number): string[] {
  return ["gh", "pr", "view", String(prNumber), "--json", "autoMergeRequest"]
}

/** `gh pr merge <n> --auto --squash` argv (squash matches the repo convention). (pure) */
export function autoMergeEnableCommand(prNumber: number): string[] {
  return ["gh", "pr", "merge", String(prNumber), "--auto", "--squash"]
}

/** `gh pr merge <n> --disable-auto` argv. (pure) */
export function autoMergeDisableCommand(prNumber: number): string[] {
  return ["gh", "pr", "merge", String(prNumber), "--disable-auto"]
}

/**
 * Decide a toggle action from the *known* current state. Never acts on an
 * unknown state — `"unknown"`/`null` defers to a fresh read rather than guessing,
 * so the toggle can never enable when GitHub auto-merge might already be on. (pure)
 */
export function decideToggleAction(state: AutoMergeState | null): ToggleAction {
  if (state === "on") return "disable"
  if (state === "off") return "enable"
  return "read-first"
}

/** Classify a raw keystroke. `a`/`A` → toggle; ctrl-c/`q` → quit; else none. (pure) */
export function decideKeystroke(key: string): "toggle" | "quit" | "none" {
  if (key === "a" || key === "A") return "toggle"
  if (key === "\x03" || key === "q") return "quit"
  return "none"
}

/**
 * Map a failed toggle's ShResult to a brief, honest, action-aware notice.
 * Common forbidden / not-mergeable / auth failures read as a branch-protection
 * hint; everything else falls back to a generic message naming the action. (pure)
 */
function briefDetail(action: "enable" | "disable", res: ShResult): string {
  const text = `${res.stderr} ${res.stdout}`.toLowerCase()
  if (
    text.includes("protect") ||
    text.includes("not mergeable") ||
    text.includes("not in the correct state") ||
    text.includes("clean status") ||
    text.includes("auth") ||
    text.includes("permission")
  )
    return `couldn't ${action} (branch protection?)`
  return `couldn't ${action} auto-merge`
}

// --- Pending marker: pure helpers + sync fs IO (PRO-660) -------------------

/**
 * Absolute path to the durable pending-intent marker under the build dir's
 * gitignored `.build/` scratch dir. Presence with `pending:true` = armed. (pure)
 */
export function pendingIntentPath(buildDir: string): string {
  return join(buildDir, ".build", "auto-merge-pending.json")
}

/**
 * Tolerant parse of the marker payload: a JSON object with `pending === true` →
 * `true`; anything else (unparseable, missing key, `false`, garbage) → `false`.
 * Never throws — a torn/half-written read reads as not-armed and is corrected on
 * the next poll pass. (pure)
 */
export function parsePendingIntent(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw)
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { pending?: unknown }).pending === true
    )
  } catch {
    return false
  }
}

/** Serialize the marker payload (trailing newline, mirrors `.build/` files). (pure) */
export function serializePendingIntent(pending: boolean): string {
  return `${JSON.stringify({ pending }, null, 2)}\n`
}

/**
 * Read the armed intent from disk: `existsSync` + `readFileSync` +
 * `parsePendingIntent`. A missing/unreadable marker → `false`. Never throws.
 */
export function readPendingIntent(buildDir: string): boolean {
  const path = pendingIntentPath(buildDir)
  if (!existsSync(path)) return false
  try {
    return parsePendingIntent(readFileSync(path, "utf-8"))
  } catch {
    return false
  }
}

/**
 * Persist (or clear) the armed intent. `true` → create `.build/` + write the
 * marker; `false` → force-remove the marker file. MAY THROW (the caller catches
 * → honest failure). Mirrors `dev-server-control.ts`'s `.build/` file pattern.
 */
export function writePendingIntent(buildDir: string, pending: boolean): void {
  const path = pendingIntentPath(buildDir)
  if (pending) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, serializePendingIntent(true))
  } else {
    rmSync(path, { force: true })
  }
}

// --- Apply-error file: pure helpers + sync fs IO (PRO-660) ------------------

/** A recorded failed build-side apply: a brief detail + the epoch-ms stamp. */
export type ApplyError = { detail: string; atMs: number }

/** Absolute path to the apply-error file under the build dir's `.build/`. (pure) */
export function applyErrorPath(buildDir: string): string {
  return join(buildDir, ".build", "auto-merge-apply-error.json")
}

/**
 * Tolerant parse of the apply-error payload: a JSON object with a string
 * `detail` and a finite-number `atMs` → the object; anything else → `null`.
 * Never throws. (pure)
 */
export function parseApplyError(raw: string): ApplyError | null {
  try {
    const parsed = JSON.parse(raw)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { detail?: unknown }).detail === "string" &&
      typeof (parsed as { atMs?: unknown }).atMs === "number" &&
      Number.isFinite((parsed as { atMs: number }).atMs)
    ) {
      const { detail, atMs } = parsed as ApplyError
      return { detail, atMs }
    }
    return null
  } catch {
    return null
  }
}

/** Serialize the apply-error payload (trailing newline). (pure) */
export function serializeApplyError(detail: string, atMs: number): string {
  return `${JSON.stringify({ detail, atMs }, null, 2)}\n`
}

/**
 * Pure display-TTL resolution: return the detail only while it is fresher than
 * `APPLY_ERROR_TTL_MS`, else `null`. This is the "TTL expiry clears the notice"
 * path — the renderer shows nothing once the failure ages out. (pure)
 */
export function resolveApplyError(
  raw: ApplyError | null,
  nowMs: number,
): string | null {
  return raw && nowMs - raw.atMs < APPLY_ERROR_TTL_MS ? raw.detail : null
}

/**
 * Read the recorded apply-error from disk. A missing/unreadable file → `null`.
 * Never throws.
 */
export function readApplyError(buildDir: string): ApplyError | null {
  const path = applyErrorPath(buildDir)
  if (!existsSync(path)) return null
  try {
    return parseApplyError(readFileSync(path, "utf-8"))
  } catch {
    return null
  }
}

/**
 * Record a failed build-side apply. Creates `.build/` + writes the file. MAY
 * THROW (the build-side default dep catches — a notice write must never break the
 * retry loop).
 */
export function writeApplyError(
  buildDir: string,
  detail: string,
  atMs: number,
): void {
  const path = applyErrorPath(buildDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeApplyError(detail, atMs))
}

/** Force-remove the apply-error file; never throws on a missing file. */
export function clearApplyError(buildDir: string): void {
  rmSync(applyErrorPath(buildDir), { force: true })
}

// --- Build-side applier (pure over injected deps, PRO-660) -----------------

/** Outcome of a single {@link applyPendingAutoMerge} pass. */
export type PendingApplyResult = "not-pending" | "applied" | "failed"

/**
 * Injected IO seam for {@link applyPendingAutoMerge}. The `Ctx`-bound production
 * wiring lives in `orchestrator.ts` (`defaultPendingApplyDeps`) to avoid a cycle;
 * tests inject spies. All methods are synchronous (the build side uses `sh`).
 */
export type PendingApplyDeps = {
  /** Is the pre-PR intent armed? (real: `readPendingIntent(ctx.buildDir)`) */
  readPending: () => boolean
  /** Consume the intent on a successful enable (real: `writePendingIntent(dir, false)`). */
  clearPending: () => void
  /** Enable GitHub auto-merge (real: `sh(autoMergeEnableCommand(prNumber), repoRoot)`). */
  enable: () => ShResult
  /** Forced confirm read of live auto-merge truth (real: gh read → parseAutoMergeState). */
  confirmState: () => AutoMergeState
  /** Record a panel-visible failure notice (real: `writeApplyError(dir, detail, Date.now())`). */
  recordApplyError: (detail: string) => void
  /** Clear any recorded failure notice (real: `clearApplyError(dir)`). */
  clearApplyError: () => void
  /** Append an honest log line (real: `appendLog(ctx.logPath, …)`). */
  log: (message: string) => void
}

/**
 * Apply an armed pre-PR auto-merge intent to the now-existing PR. Best-effort +
 * idempotent + honest:
 *
 *  - Not armed → no-op apart from clearing any stale apply-error notice; no gh call.
 *  - Enable rejected (non-zero exit) → KEEP the marker (retried next pass), record
 *    a brief panel notice, log an honest warning.
 *  - Enable accepted (exit 0) → forced confirm read, consume the marker + clear the
 *    notice, and log truthfully: "enabled" only when the confirm reads `"on"`; an
 *    instant-merge (`"off"`) and an inconclusive confirm (`"unknown"`) are logged
 *    as such, never overstated. (pure over injected deps)
 */
export function applyPendingAutoMerge(
  deps: PendingApplyDeps,
): PendingApplyResult {
  if (!deps.readPending()) {
    deps.clearApplyError() // not armed → no stale failure notice
    return "not-pending"
  }
  const res = deps.enable()
  if (res.code !== 0) {
    const detail = briefDetail("enable", res)
    deps.recordApplyError(detail) // surface to the panel (honest failure)
    deps.log(`⚠ auto-merge: ${detail} on the PR — will retry`)
    return "failed" // marker stays armed → retried next pass
  }
  const confirmed = deps.confirmState() // forced confirm read (honesty)
  deps.clearPending() // intent consumed on a successful enable
  deps.clearApplyError() // success clears any prior failure notice
  if (confirmed === "on")
    deps.log("auto-merge: enabled on the PR (pending intent applied)")
  else if (confirmed === "off")
    deps.log(
      "auto-merge: enable accepted; GitHub reports no pending auto-merge (PR may have merged instantly)",
    )
  else
    deps.log(
      "auto-merge: enable accepted; confirm read was inconclusive (auto-merge state unknown)",
    )
  return "applied"
}

// --- IO wrappers (injectable async exec) -----------------------------------

/**
 * Read live auto-merge state for `prNumber`. Returns `"unknown"` on non-zero
 * exit, unparseable stdout, an absent key, OR a rejected exec (the exec promise
 * is `.catch`-guarded, so a `gh` ENOENT / spawn throw resolves to `"unknown"`,
 * never an unhandled rejection). Never throws.
 */
export async function readAutoMergeState(
  prNumber: number,
  cwd: string,
  exec: AsyncExec,
): Promise<AutoMergeState> {
  let res: ShResult
  try {
    res = await exec(autoMergeReadCommand(prNumber), cwd)
  } catch {
    return "unknown"
  }
  if (res.code !== 0) return "unknown"
  try {
    return parseAutoMergeState(JSON.parse(res.stdout))
  } catch {
    return "unknown"
  }
}

/**
 * Run the enable/disable toggle for `prNumber`, returning the exec's ShResult
 * verbatim (code preserved) so callers refuse to flip the indicator on a
 * non-zero exit. Only ever called with a concrete (`"enable"`/`"disable"`) action.
 */
export async function applyAutoMergeToggle(
  action: "enable" | "disable",
  prNumber: number,
  cwd: string,
  exec: AsyncExec,
): Promise<ShResult> {
  const cmd =
    action === "enable"
      ? autoMergeEnableCommand(prNumber)
      : autoMergeDisableCommand(prNumber)
  return exec(cmd, cwd)
}

/**
 * Default production async exec: a thin `spawn` wrapper that always sets `cwd`
 * explicitly and resolves (never rejects) to a ShResult — even on spawn error —
 * so the panel can never crash on a missing `gh`.
 */
export function spawnExec(cmd: string[], cwd: string): Promise<ShResult> {
  return new Promise((resolve) => {
    const [bin, ...rest] = cmd
    if (!bin) {
      resolve({ code: 1, stdout: "", stderr: "empty command" })
      return
    }
    try {
      const child = spawn(bin, rest, { cwd })
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (d) => {
        stdout += d.toString()
      })
      child.stderr?.on("data", (d) => {
        stderr += d.toString()
      })
      child.on("error", (err) => {
        resolve({ code: 1, stdout, stderr: stderr || String(err) })
      })
      child.on("close", (code) => {
        resolve({ code: code ?? 1, stdout, stderr })
      })
    } catch (err) {
      resolve({ code: 1, stdout: "", stderr: String(err) })
    }
  })
}

// --- Pure view reducers ----------------------------------------------------

/**
 * Apply a keystroke to the view, returning the next view and the side-effect
 * the runner should run. The keystroke is the *immediate ack* path: `toggleBusy`
 * is set synchronously here, before the async toggle begins. (pure)
 */
export function applyKeystrokeToView(
  view: AutoMergeView,
  key: string,
): {
  next: AutoMergeView
  effect: "toggle" | "quit" | "arm" | "disarm" | "none"
} {
  const k = decideKeystroke(key)
  if (k === "quit") return { next: view, effect: "quit" }
  if (k === "none") return { next: view, effect: "none" }
  // k === "toggle"
  if (view.toggleBusy) return { next: view, effect: "none" } // overlap guard
  // Pending → disarm (PRO-660). Precedence over `prKnown` so disarm works both
  // pre-PR and during a post-PR pending window before the build applies it.
  if (view.pending)
    return {
      next: { ...view, pending: false, notice: "auto-merge disarmed" },
      effect: "disarm",
    }
  // No PR yet, not pending → arm the pre-PR intent (PRO-660).
  if (!view.prKnown)
    return {
      next: { ...view, pending: true, notice: "auto-merge armed" },
      effect: "arm",
    }
  const action = decideToggleAction(view.state)
  const notice =
    action === "enable"
      ? "enabling…"
      : action === "disable"
        ? "disabling…"
        : "checking auto-merge…"
  return { next: { ...view, toggleBusy: true, notice }, effect: "toggle" }
}

/**
 * Apply a completed read. Sets `state` to the read result (trusting live truth);
 * clears only the transient *checking* notice; never touches `toggleBusy` (a read
 * can be the read-first/confirm step inside a live toggle). (pure)
 */
export function onReadComplete(
  view: AutoMergeView,
  result: AutoMergeState,
): AutoMergeView {
  const notice = view.notice === READ_NOTICE ? null : view.notice
  return { ...view, state: result, notice }
}

/** Begin a concrete toggle: set `toggleBusy` + the matching progress notice. (pure) */
export function onToggleStart(
  view: AutoMergeView,
  action: "enable" | "disable",
): AutoMergeView {
  return {
    ...view,
    toggleBusy: true,
    notice: action === "enable" ? "enabling…" : "disabling…",
  }
}

/**
 * Record a toggle failure: set a brief error notice; leave `state` UNCHANGED
 * (never flip the indicator to the requested state) and `toggleBusy` untouched
 * (the confirm read + `endToggle` finalize). (pure)
 */
export function onToggleFailed(
  view: AutoMergeView,
  detail: string,
): AutoMergeView {
  return { ...view, notice: detail }
}

/**
 * Finalize a toggle: clear `toggleBusy`, and clear the notice only if it is still
 * a progress notice (preserving any error notice set by `onToggleFailed`). (pure)
 */
export function endToggle(view: AutoMergeView): AutoMergeView {
  const notice =
    view.notice && PROGRESS_NOTICES.has(view.notice) ? null : view.notice
  return { ...view, toggleBusy: false, notice }
}

/** Transient confirmation notices that self-clear after `TRANSIENT_NOTICE_TTL_MS`. */
const TRANSIENT_NOTICES = new Set(["auto-merge armed", "auto-merge disarmed"])

/**
 * Sync the per-tick inputs (`prKnown`/`toggleAvailable`). Clears a stale
 * transient arm/disarm confirmation notice ONLY when `clearTransientNotice` is
 * set — the coordinator gates that on a brief TTL so the notice survives at least
 * one rendered frame before it self-clears, instead of being clobbered the very
 * next tick. Without that gate the spec-required feedback never reaches a frame,
 * because `sync` runs immediately before `renderDashboard` each tick. The error
 * notice `"couldn't save auto-merge intent"` is NOT transient, so it persists
 * like other error notices. (pure)
 */
export function tickView(
  view: AutoMergeView,
  {
    prKnown,
    toggleAvailable,
    clearTransientNotice,
  }: {
    prKnown: boolean
    toggleAvailable: boolean
    clearTransientNotice: boolean
  },
): AutoMergeView {
  const notice =
    view.notice && TRANSIENT_NOTICES.has(view.notice) && clearTransientNotice
      ? null
      : view.notice
  return { ...view, prKnown, toggleAvailable, notice }
}

// --- Async coordinator -----------------------------------------------------

/** IO seam for the coordinator (real or faked). */
export type AutoMergeIo = {
  read: (prNumber: number, cwd: string) => Promise<AutoMergeState>
  toggle: (
    action: "enable" | "disable",
    prNumber: number,
    cwd: string,
  ) => Promise<ShResult>
  /**
   * Persist the armed pre-PR intent (PRO-660). Optional so existing coordinator
   * tests without it still typecheck; the runner wires it to
   * `(pending) => writePendingIntent(dir, pending)`. MAY THROW — `persistPending`
   * catches → an honest save-failure notice. (The apply-error file is NOT here:
   * the dashboard never writes it; the build-side actor owns it.)
   */
  savePending?: (pending: boolean) => void
}

/** The live, runner-facing coordinator returned by `createAutoMergeCoordinator`. */
export type AutoMergeCoordinator = {
  getView: () => AutoMergeView
  sync: (o: {
    prKnown: boolean
    toggleAvailable: boolean
    armAvailable?: boolean
    pending?: boolean
    applyError?: string | null
  }) => void
  dueForRefresh: (intervalMs: number) => boolean
  refresh: (prNumber: number, cwd: string) => Promise<void>
  keystroke: (key: string) => "toggle" | "quit" | "arm" | "disarm" | "none"
  handleToggle: (prNumber: number, cwd: string) => Promise<void>
  /** Persist the optimistic `view.pending` (PRO-660); reverts + notices on throw. */
  persistPending: () => void
}

/**
 * Create the auto-merge coordinator. It owns the `AutoMergeView` plus all
 * read/toggle concurrency bookkeeping (kept off the view), implementing the
 * non-skippable post-toggle confirmation via a monotonic request-token model:
 *
 *  - `seq` increments on every read launch; the captured value is that read's token.
 *  - `invalidatedThrough` is bumped to the current `seq` at the start of every
 *    toggle, so every background read already in flight is discarded on
 *    completion (`token <= invalidatedThrough`), even if it finishes after the
 *    toggle's own confirm read.
 *  - `ghInFlight` guards only background cadence reads against pile-ups; forced
 *    reads (read-first, confirm) bypass it and always apply.
 *
 * All IO is `.catch`-guarded, so `refresh`/`handleToggle` never reject.
 */
export function createAutoMergeCoordinator(
  io: AutoMergeIo,
  opts: { now?: () => number; initialPending?: boolean } = {},
): AutoMergeCoordinator {
  const now = opts.now ?? Date.now
  let view: AutoMergeView = {
    prKnown: false,
    state: null,
    toggleBusy: false,
    notice: null,
    toggleAvailable: false,
    pending: opts.initialPending ?? false,
    armAvailable: false,
    applyError: null,
  }
  let seq = 0
  let invalidatedThrough = 0
  let ghInFlight = false
  let lastReadMs = 0
  // When the transient arm/disarm confirmation notice was last set, so `sync` can
  // keep it visible for TRANSIENT_NOTICE_TTL_MS before clearing it (otherwise the
  // next tick's sync would clobber it before any frame renders it).
  let transientNoticeSetMs = Number.NEGATIVE_INFINITY

  async function safeRead(
    prNumber: number,
    cwd: string,
  ): Promise<AutoMergeState> {
    try {
      return await io.read(prNumber, cwd)
    } catch {
      return "unknown"
    }
  }

  function getView(): AutoMergeView {
    return view
  }

  function sync(o: {
    prKnown: boolean
    toggleAvailable: boolean
    armAvailable?: boolean
    pending?: boolean
    applyError?: string | null
  }): void {
    // Drop a transient arm/disarm confirmation after its brief TTL — but keep it
    // through the next tick so a frame renders it (pure TTL transient now).
    const clearTransientNotice =
      now() - transientNoticeSetMs >= TRANSIENT_NOTICE_TTL_MS
    view = tickView(view, {
      prKnown: o.prKnown,
      toggleAvailable: o.toggleAvailable,
      clearTransientNotice,
    })
    // Reconcile the PRO-660 display fields from the runner's per-tick inputs.
    // `pending` is driven by the on-disk marker (reflects build-side consumption
    // + disarm); `applyError` by the TTL-resolved apply-error file. Both keys are
    // optional so old call sites `sync({ prKnown, toggleAvailable })` are inert.
    view = { ...view, armAvailable: o.armAvailable ?? false }
    if (o.pending !== undefined) view = { ...view, pending: o.pending }
    if ("applyError" in o) view = { ...view, applyError: o.applyError ?? null }
  }

  function dueForRefresh(intervalMs: number): boolean {
    return (
      view.prKnown &&
      !ghInFlight &&
      !view.toggleBusy &&
      now() - lastReadMs >= intervalMs
    )
  }

  async function refresh(prNumber: number, cwd: string): Promise<void> {
    // Background cadence read — never read mid-toggle or while one is in flight.
    if (ghInFlight || view.toggleBusy) return
    ghInFlight = true
    const token = ++seq
    try {
      const result = await safeRead(prNumber, cwd)
      // Discard a read invalidated by a toggle that started while it was in flight.
      if (token > invalidatedThrough) {
        view = onReadComplete(view, result)
        lastReadMs = now()
      }
    } finally {
      ghInFlight = false
    }
  }

  function keystroke(
    key: string,
  ): "toggle" | "quit" | "arm" | "disarm" | "none" {
    const { next, effect } = applyKeystrokeToView(view, key)
    view = next
    // Stamp the transient-notice TTL whenever an arm/disarm confirmation was set,
    // so `sync` keeps it visible for its TTL instead of clearing it the next tick.
    if (effect === "arm" || effect === "disarm") transientNoticeSetMs = now()
    return effect
  }

  function persistPending(): void {
    if (!io.savePending) return
    const desired = view.pending // optimistic value set by the reducer
    try {
      io.savePending(desired)
    } catch {
      // Write failed → the marker on disk is UNCHANGED, so undo the optimistic
      // flip and surface an honest error. The next poll's `sync` reconciliation
      // from the marker is a belt-and-suspenders backstop.
      view = {
        ...view,
        pending: !desired,
        notice: "couldn't save auto-merge intent",
      }
    }
  }

  async function handleToggle(prNumber: number, cwd: string): Promise<void> {
    // The keystroke reducer already set `toggleBusy` (immediate ack) and the
    // overlap guard prevented re-entry; set it defensively if somehow unset.
    if (!view.toggleBusy) view = { ...view, toggleBusy: true }
    // Invalidate every background read already in flight (rule 2). Forced reads
    // below do `++seq`, so their tokens are strictly > invalidatedThrough.
    invalidatedThrough = seq
    try {
      let action = decideToggleAction(view.state)
      if (action === "read-first") {
        seq++ // forced read token, always applied
        const fresh = await safeRead(prNumber, cwd)
        view = onReadComplete(view, fresh)
        lastReadMs = now()
        action = decideToggleAction(fresh)
        if (action === "read-first") {
          view = onToggleFailed(view, "auto-merge state unknown; try again")
          return
        }
      }
      view = onToggleStart(view, action)
      let res: ShResult
      try {
        res = await io.toggle(action, prNumber, cwd)
      } catch (err) {
        res = { code: 1, stdout: "", stderr: String(err) }
      }
      if (res.code !== 0) view = onToggleFailed(view, briefDetail(action, res))
      // Forced confirm read — bypasses ghInFlight and always applies (success
      // OR failure), so the indicator reflects real GitHub truth either way.
      // Note: a *successful* enable can still confirm as "off" — if checks were
      // already green, GitHub may merge the PR immediately, and a merged PR has
      // no pending autoMergeRequest (gh returns null → "off"). That is truthful
      // (no auto-merge is pending anymore), not a confirm bug.
      seq++
      const confirm = await safeRead(prNumber, cwd)
      view = onReadComplete(view, confirm)
      lastReadMs = now()
    } finally {
      view = endToggle(view)
    }
  }

  return {
    getView,
    sync,
    dueForRefresh,
    refresh,
    keystroke,
    handleToggle,
    persistPending,
  }
}
