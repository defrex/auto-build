/**
 * Read-only monitor dashboard for an autonomous build.
 *
 * Given a build slug (or its `build/<slug>/` path), this renders a live TUI that
 * reflects build progress purely by *watching* the on-disk artifacts under
 * `build/<slug>/` — it never writes to the build directory and never drives the
 * build. It is the right-hand pane of a herdr build workspace (the left pane runs
 * the `claude "/build <slug>"` supervisor), and is also runnable standalone:
 *
 *   bun run bin/build/dashboard.ts <slug | build/<slug>/ | /abs/build/<slug>>
 *
 * The split mirrors the repo's "pure logic + thin glue" convention
 * (`monitor.ts` is pure, `repo.ts` is IO): every reader/renderer here is a pure
 * function over fs reads, and the only side-effecting code is the `main` poll
 * loop guarded by `import.meta.main`.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import {
  type AutoMergeView,
  applyAutoMergeToggle,
  createAutoMergeCoordinator,
  readApplyError,
  readAutoMergeState,
  readPendingIntent,
  resolveApplyError,
  spawnExec,
  writePendingIntent,
} from "./auto-merge"
import { readDevServerPane } from "./dev-server-control"
import {
  createDevServerCoordinator,
  type DevServerAction,
  type DevServerView,
  devServerActionCommand,
  parseDevServerStatusOutput,
} from "./dev-server-status"
import { type OptionalStepView, optionalStepViews } from "./optional-steps"
import { detectRepoRoot } from "./repo"
import { type BuildState, buildDir, buildStateSchema, PHASES } from "./state"

/** Whether the build is actively progressing right now (from `build.log` mtime). */
export type Liveness = "live" | "stalled" | "unknown"

/**
 * Result of parsing the dashboard's CLI argument. The spec requires accepting "a
 * build slug (or its `build/<slug>/` path)" and *watching that directory*.
 * `slug` is always derived (for display/breadcrumb); `buildDir` is the resolved
 * directory to watch ONLY when an explicit path was supplied, else null (the
 * runner then resolves it via the repo root).
 */
export type DashboardTarget = {
  slug: string
  /** Explicit directory to watch, or null for a bare slug (resolve via repo root). */
  buildDir: string | null
}

/** Everything the renderer needs for one frame; built by `readDashboardSnapshot`. */
export type DashboardSnapshot = {
  slug: string
  dirExists: boolean
  /** Parsed state, or null if missing OR unparseable (never throws). */
  state: BuildState | null
  /** Set when state.json is present but invalid/partial. */
  stateError: string | null
  specExists: boolean
  needsInput: boolean
  validateFailures: boolean
  logMtimeMs: number | null
}

/** How long without `build.log` activity before the build reads as "stalled". */
const DEFAULT_LIVENESS_THRESHOLD_MS = 90_000
/** Poll cadence for the live frame. */
const POLL_INTERVAL_MS = 1_000
/**
 * Cadence for the live `gh` auto-merge read, decoupled from the 1s render loop
 * (gh calls are slow + rate-limited). Tuned to feel live while staying well
 * under gh rate limits; a toggle's forced confirm read resets the cadence.
 */
const AUTO_MERGE_POLL_INTERVAL_MS = 5_000
/**
 * Cadence for the dev-server status read (shells out to the control CLI), on its
 * own clock so it never piles up against the 1s render loop. An in-flight action
 * (start/stop/restart) suppresses the background read.
 */
const DEV_SERVER_POLL_INTERVAL_MS = 5_000

/**
 * Parse the CLI arg into a target. A bare slug (no path separator) returns
 * `buildDir: null` so the runner resolves it against the detected repo root; a
 * path form resolves to the exact directory to watch (honored verbatim,
 * independent of cwd/repo root). A trailing `state.json`/`spec.md` resolves to
 * its parent build directory. Empty/whitespace throws a usage error. (pure)
 */
export function parseDashboardArg(arg: string): DashboardTarget {
  const trimmed = (arg ?? "").trim()
  if (!trimmed) {
    throw new Error(
      "usage: dashboard <build-slug | build/<slug>/ | /abs/path/to/build/<slug>>",
    )
  }
  const isPathForm =
    trimmed.includes("/") || trimmed === "state.json" || trimmed === "spec.md"
  if (!isPathForm) {
    return { slug: trimmed, buildDir: null }
  }
  const abs = resolve(trimmed)
  const base = basename(abs)
  const dir = base === "state.json" || base === "spec.md" ? dirname(abs) : abs
  return { slug: basename(dir), buildDir: dir }
}

/**
 * The single build-dir resolution point shared by `main` and tests. A bare-slug
 * target is resolved against the repo root (the thunk is only invoked here, so
 * an explicit path never triggers `detectRepoRoot()`). (pure given the thunk)
 */
export function resolveBuildDir(
  target: DashboardTarget,
  detectRoot: () => string,
): string {
  return target.buildDir ?? buildDir(detectRoot(), target.slug)
}

/**
 * Word-wrap `text` to `columns`, capped to `maxLines`. EVERY returned line is
 * guaranteed ≤ `columns` visible chars — including long unbroken tokens (URLs,
 * generated ids, space-less prose), which are hard-split across lines. If content
 * overflows `maxLines`, the last kept line ends in `…` and still fits `columns`.
 * Width is measured on the raw (un-styled) text — the caller applies `dim(...)`
 * after wrapping, so ANSI escapes never count toward width. (pure)
 */
export function wrapSummary(
  text: string,
  columns: number,
  maxLines: number,
): string[] {
  const collapsed = text.trim().replace(/\s+/g, " ")
  if (collapsed === "") return []
  const width = Math.max(1, columns)

  const lines: string[] = []
  let current = ""
  for (const token of collapsed.split(" ")) {
    let word = token
    // A token that fits is appended to the current line (with a space if needed).
    if (current === "") {
      if (word.length <= width) {
        current = word
        continue
      }
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`
      continue
    } else {
      // Doesn't fit on the current line — flush and start fresh with this token.
      lines.push(current)
      current = ""
    }
    // Hard-split a token longer than the column into width-sized chunks.
    while (word.length > width) {
      lines.push(word.slice(0, width))
      word = word.slice(width)
    }
    current = word
  }
  if (current !== "") lines.push(current)

  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  const last = kept[kept.length - 1] ?? ""
  kept[kept.length - 1] = width === 1 ? "…" : `${last.slice(0, width - 1)}…`
  return kept
}

/**
 * Derive liveness from `build.log` mtime — NOT `state.updatedAt`, which only
 * changes on phase transitions (a single phase can legitimately run for many
 * minutes). `null` mtime → "unknown"; within the threshold → "live"; else
 * "stalled" (reads as "quiet", not "dead"). (pure)
 */
export function deriveLiveness(
  logMtimeMs: number | null,
  nowMs: number,
  thresholdMs: number = DEFAULT_LIVENESS_THRESHOLD_MS,
): Liveness {
  if (logMtimeMs == null) return "unknown"
  return nowMs - logMtimeMs <= thresholdMs ? "live" : "stalled"
}

/**
 * Read a log file's modification time (epoch ms), used to derive build
 * liveness. Returns `null` when the file is absent or unreadable.
 */
export function readLogMtime(logPath: string): number | null {
  try {
    return statSync(logPath).mtimeMs
  } catch {
    return null
  }
}

/**
 * Build a snapshot of `buildDir` for one frame. `slug` is the display slug; the
 * directory is watched directly (never re-derived from the slug), so an explicit
 * path is honored end-to-end. Tolerates missing/older/partial files and never
 * throws: a missing or unparseable `state.json` leaves `state: null` with
 * `stateError` describing the problem.
 */
export function readDashboardSnapshot(
  buildDirPath: string,
  slug: string,
): DashboardSnapshot {
  const dirExists = existsSync(buildDirPath)
  const statePath = join(buildDirPath, "state.json")
  let state: BuildState | null = null
  let stateError: string | null = null
  if (existsSync(statePath)) {
    try {
      state = buildStateSchema.parse(
        JSON.parse(readFileSync(statePath, "utf-8")),
      )
    } catch (err) {
      state = null
      stateError = err instanceof Error ? err.message : String(err)
    }
  }
  return {
    slug,
    dirExists,
    state,
    stateError,
    specExists: existsSync(join(buildDirPath, "spec.md")),
    needsInput: existsSync(join(buildDirPath, "NEEDS-INPUT.md")),
    validateFailures: existsSync(join(buildDirPath, "validate-failures.md")),
    logMtimeMs: readLogMtime(join(buildDirPath, "build.log")),
  }
}

// --- ANSI helpers (no dependency; honors the Status-Is-Signal rule) --------

const ESC = "\x1b["
const RESET = `${ESC}0m`
const bold = (s: string) => `${ESC}1m${s}${RESET}`
const dim = (s: string) => `${ESC}2m${s}${RESET}`
const green = (s: string) => `${ESC}32m${s}${RESET}`
const yellow = (s: string) => `${ESC}33m${s}${RESET}`
const red = (s: string) => `${ESC}31m${s}${RESET}`
const cyan = (s: string) => `${ESC}36m${s}${RESET}`

function humanizeAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

/** Informational notices that render dim (not red) even though they lack an ellipsis. */
const INFO_NOTICES = new Set(["auto-merge armed", "auto-merge disarmed"])

/** A notice reads as an error when it isn't an in-progress ellipsis or an info notice. */
function isErrorNotice(notice: string): boolean {
  return !notice.endsWith("…") && !INFO_NOTICES.has(notice)
}

/**
 * Render the auto-merge indicator + hint lines (Status-Is-Signal: foreground
 * colors only). A distinct cyan "Pending" wins whenever armed (regardless of
 * `prKnown`); otherwise neutral `n/a` before a PR exists (never a false "Off");
 * `unknown` stays yellow rather than collapsing to a false "Off". (pure)
 */
function renderAutoMergeLines(am: AutoMergeView): string[] {
  if (am.pending) {
    // Armed pre-PR intent (PRO-660): a distinct cyan indicator, clearly not On/Off.
    const lines = [cyan("auto-merge: Pending")]
    // A user's own transient (arm/disarm/save-failure) wins for immediate
    // feedback; else the build-side apply failure surfaces here.
    const notice = am.notice ?? am.applyError
    if (notice) lines.push(isErrorNotice(notice) ? red(notice) : dim(notice))
    if (am.armAvailable || am.toggleAvailable)
      lines.push(dim("a — disarm auto-merge"))
    return lines
  }
  if (!am.prKnown) {
    // Pre-PR resting state is a neutral `n/a`; a transient notice (e.g. a
    // save-failure) surfaces as brief feedback below it.
    const lines = [dim("auto-merge — n/a")]
    if (am.notice)
      lines.push(isErrorNotice(am.notice) ? red(am.notice) : dim(am.notice))
    if (am.armAvailable) lines.push(dim("a — arm auto-merge"))
    return lines
  }
  const lines: string[] = []
  let label: string
  if (am.state === "on") label = green("auto-merge: On")
  else if (am.state === "off") label = dim("auto-merge: Off")
  else if (am.state === "unknown") label = yellow("auto-merge: unknown")
  else label = dim("auto-merge — checking…")
  // Immediate toggle ack — a dim "…" suffix while the gh call is in flight.
  if (am.toggleBusy) label += dim(" …")
  lines.push(label)
  if (am.notice)
    lines.push(isErrorNotice(am.notice) ? red(am.notice) : dim(am.notice))
  if (am.toggleAvailable) lines.push(dim("a — toggle auto-merge"))
  return lines
}

/**
 * Render the dev-server status indicator + control-hint line (Status-Is-Signal:
 * foreground colors only). `running` is the only green; `starting`/`unreachable`
 * are yellow (in-progress / attention, never a surface fill); `stopped` is a calm
 * dim. The `s/x/r` hint line shows ONLY when controls are available (TTY +
 * herdr-framed). `null` status reads as a neutral "checking…". (pure)
 */
export function renderDevServerLines(view: DevServerView): string[] {
  const lines: string[] = []
  let label: string
  if (view.status === "running") label = green("dev server: running")
  else if (view.status === "starting") label = yellow("dev server: starting…")
  else if (view.status === "unreachable")
    label = yellow("dev server: unreachable")
  else if (view.status === "stopped") label = dim("dev server: stopped")
  else label = dim("dev server — checking…")
  // Immediate action ack — a dim "…" suffix while the control CLI runs.
  if (view.busy) label += dim(" …")
  lines.push(label)
  if (view.notice)
    lines.push(isErrorNotice(view.notice) ? red(view.notice) : dim(view.notice))
  if (view.controlsAvailable)
    lines.push(dim("s — start · x — stop · r — restart dev server"))
  return lines
}

/**
 * Render a single optional-step line (Status-Is-Signal: foreground color only;
 * a skipped step reads calm, not as a failure). Reuses the panel's `●`/`○` glyph
 * and `green`/`dim` idiom. (pure) Exported for unit test. The blocked/needs-input
 * case is NOT rendered here — it surfaces through the existing NEEDS-INPUT alert.
 */
export function renderOptionalStepLine(v: OptionalStepView): string {
  switch (v.status) {
    case "running":
      return green(`● ${v.id} — running`)
    case "done":
      return green(`● ${v.id} — done`)
    case "pending":
      return dim(`○ ${v.id} — pending`)
    case "skipped":
      return dim(`○ ${v.id} — skipped (${v.reason})`)
  }
}

/**
 * Render the full dashboard frame as a string (pure; the runner does terminal
 * IO). Never throws, even on a fully-null snapshot.
 */
export function renderDashboard(
  snap: DashboardSnapshot,
  opts: {
    nowMs: number
    columns?: number
    autoMerge?: AutoMergeView
    devServer?: DevServerView
  },
): string {
  const lines: string[] = []
  const columns = opts.columns ?? 80

  // 1. Identity — the one mono agent file-path breadcrumb (File-Path rule).
  lines.push(dim(cyan(`build/${snap.slug}/`)))
  // Human heading: the Linear title owns the visual role the old bold kebab
  // `feature` line had; fall back to feature/slug so the header is never blank.
  const title = snap.state?.linearTitle ?? snap.state?.feature ?? snap.slug
  lines.push(bold(title))
  // One-line orientation summary from the Linear ticket, wrapped/capped to fit
  // the terminal so a verbose description can't distort the panel.
  if (snap.state?.linearSummary)
    for (const l of wrapSummary(snap.state.linearSummary, columns, 2))
      lines.push(dim(l))
  if (snap.state?.branch) lines.push(dim(`branch ${snap.state.branch}`))
  // Prominent links — purely a function of persisted state (the panel never
  // shells out), so they stay visible from `monitor` through the terminal state.
  // bold(cyan) reuses the panel's existing accent (One-Voice; foreground only);
  // the Linear and PR links share one consistent style.
  if (snap.state?.linearUrl)
    lines.push(
      bold(
        cyan(
          `▸ ${snap.state.linearIssueId ?? "Linear"}  ${snap.state.linearUrl}`,
        ),
      ),
    )
  else if (snap.state?.linearIssueId)
    lines.push(bold(cyan(`▸ ${snap.state.linearIssueId}`)))
  if (snap.state?.prUrl) {
    const n = snap.state.prNumber ? ` #${snap.state.prNumber}` : ""
    lines.push(bold(cyan(`▸ PR${n}  ${snap.state.prUrl}`)))
  }
  // Dev-login URLs — the two URLs `bin/dev.sh` prints on startup, so the human
  // can click straight into the running app. Purely a function of persisted
  // `state.devUrl` (the panel never shells out for these); absent when unset.
  if (snap.state?.devUrl) {
    lines.push(
      bold(cyan(`▸ dev-login  ${snap.state.devUrl}/api/auth/dev-login`)),
    )
    lines.push(
      bold(
        cyan(
          `▸ dev-login (comped)  ${snap.state.devUrl}/api/auth/dev-login?comp=1`,
        ),
      ),
    )
  }
  // Auto-merge indicator + hint — live GitHub truth (not from state.json), so it
  // comes through opts, logically grouped with the PR it describes.
  if (opts.autoMerge)
    for (const l of renderAutoMergeLines(opts.autoMerge)) lines.push(l)
  // Dev-server status + controls — live pane truth (not from state.json), so it
  // also comes through opts, grouped with the other active affordances.
  if (opts.devServer)
    for (const l of renderDevServerLines(opts.devServer)) lines.push(l)
  lines.push("")

  // 2. Phase progress — the full pipeline with the current phase emphasized.
  const phase = snap.state?.phase
  const pipeline = PHASES.map((p) =>
    p === phase ? bold(green(`[${p}]`)) : dim(p),
  )
  lines.push(pipeline.join(dim(" › ")))
  lines.push("")

  // 2b. Optional steps — pipeline shape, computed purely from state.json
  // (declaration + overrides + current phase). Grouped with phase progress.
  if (snap.state) {
    const views = optionalStepViews({
      phase: snap.state.phase,
      optionalSteps: snap.state.optionalSteps,
      optionalStepOverrides: snap.state.optionalStepOverrides,
    })
    if (views.length) {
      lines.push(dim("optional steps"))
      for (const v of views) lines.push(renderOptionalStepLine(v))
      lines.push("")
    }
  }

  // 3. Status — blocked/failed prominent; running/done quiet.
  const status = snap.state?.status
  if (status === "blocked") lines.push(bold(red("● status: BLOCKED")))
  else if (status === "failed") lines.push(bold(red("● status: FAILED")))
  else if (status === "done") lines.push(green("● status: done"))
  else if (status === "running") lines.push(dim("● status: running"))

  // 4. Liveness — derived from build.log mtime (foreground color only).
  const liveness = deriveLiveness(snap.logMtimeMs, opts.nowMs)
  if (liveness === "live")
    lines.push(
      green(
        `● live — active ${snap.logMtimeMs != null ? humanizeAge(opts.nowMs - snap.logMtimeMs) : "0s"} ago`,
      ),
    )
  else if (liveness === "stalled")
    lines.push(
      yellow(
        `● quiet — no log activity for ${snap.logMtimeMs != null ? humanizeAge(opts.nowMs - snap.logMtimeMs) : "?"}`,
      ),
    )
  else lines.push(dim("● liveness — waiting for build.log"))

  // 5. Alerts.
  if (snap.needsInput) {
    lines.push("")
    lines.push(
      bold(red("  ⚠ NEEDS INPUT — the build is waiting for the operator  ")),
    )
  }
  if (snap.validateFailures)
    lines.push(yellow("⚠ validate-failures.md present"))
  if (snap.state && snap.state.reviewRound > 0)
    lines.push(dim(`review round ${snap.state.reviewRound}`))

  // 6. Starting-up / degraded states (when no parsed state yet).
  if (!snap.state) {
    lines.push("")
    if (snap.stateError) lines.push(dim("state.json unreadable (retrying)"))
    else if (snap.specExists)
      lines.push(dim("starting up — spec present, waiting for state.json"))
    else if (!snap.dirExists) lines.push(dim("waiting for build directory"))
    else lines.push(dim("starting up — waiting for state.json"))
  }

  return lines.join("\n")
}

// --- Runner (thin IO glue; not unit-tested) --------------------------------

async function main(): Promise<void> {
  const arg = process.argv[2]
  let target: DashboardTarget
  try {
    target = parseDashboardArg(arg)
  } catch (err) {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exit(2)
    return
  }
  const dir = resolveBuildDir(target, () => detectRepoRoot())
  const slug = target.slug

  // Auto-merge coordinator: owns the live gh view + read/toggle concurrency and
  // the pre-PR pending intent (PRO-660). The runner holds NO auto-merge state of
  // its own — it only drives this + persists/reads the durable marker.
  const coord = createAutoMergeCoordinator(
    {
      read: (n, cwd) => readAutoMergeState(n, cwd, spawnExec),
      toggle: (a, n, cwd) => applyAutoMergeToggle(a, n, cwd, spawnExec),
      savePending: (pending) => writePendingIntent(dir, pending),
    },
    { initialPending: readPendingIntent(dir) },
  )

  // Dev-server coordinator: owns the live pane status + start/stop/restart
  // control, shelling out to the co-located `dev-server-control.ts` CLI. Bound to
  // this dashboard's build dir for its lifetime; the worktree root is the exec
  // cwd. Mirrors the auto-merge coordinator (same `spawnExec`).
  const devControlScript = join(import.meta.dir, "dev-server-control.ts")
  const devCwd = dirname(dirname(dir))
  const devCoord = createDevServerCoordinator({
    status: async () => {
      const res = await spawnExec(
        devServerActionCommand(devControlScript, "status", dir),
        devCwd,
      )
      return parseDevServerStatusOutput(res.stdout)
    },
    action: (action: DevServerAction) =>
      spawnExec(devServerActionCommand(devControlScript, action, dir), devCwd),
  })

  // Terminal setup: hide cursor + clear screen. stdin raw mode is entered ONLY
  // when stdin is an interactive TTY (degraded/headless herdr panes deliver a
  // non-TTY; there the indicator still renders, the toggle is just unavailable).
  const isTty = Boolean(process.stdin.isTTY)
  let rawEntered = false
  let dataHandler: ((chunk: string) => void) | null = null
  let restored = false
  // Idempotent: show cursor, and (if entered) leave raw mode + detach our own
  // listener. Safe to run on every exit path; the `restored` guard makes the
  // quit-path exit(0) → "exit"-event double-call a no-op.
  const restore = () => {
    if (restored) return
    restored = true
    process.stdout.write(`${ESC}?25h`)
    if (rawEntered) {
      try {
        process.stdin.setRawMode(false)
      } catch {}
      process.stdin.pause()
      if (dataHandler) process.stdin.removeListener("data", dataHandler)
    }
  }
  process.stdout.write(`${ESC}?25l${ESC}2J`)
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      restore()
      process.exit(0)
    })
  }
  process.on("exit", restore)

  if (isTty) {
    // The latest PR number is read fresh on each keystroke so a toggle acts on
    // the current PR; a pre-PR press instead arms/disarms the pending intent.
    process.stdin.setRawMode(true)
    rawEntered = true
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
    dataHandler = (chunk: string) => {
      // Dev-server controls first (s/x/r) — disjoint from auto-merge's a/q/ctrl-c.
      // The reducer self-gates on controlsAvailable, so a non-"none" effect means
      // controls are live and the action should run. Never rejects (guarded).
      const dsEffect = devCoord.keystroke(chunk)
      if (dsEffect !== "none") {
        void devCoord.handleAction(dsEffect)
        return
      }
      const effect = coord.keystroke(chunk)
      if (effect === "quit") {
        restore()
        process.exit(0)
      } else if (effect === "toggle") {
        const n = readDashboardSnapshot(dir, slug).state?.prNumber
        // Pre-PR presses arm/disarm instead (routed above); a `toggle` effect
        // only fires with a real PR. Never rejects (all IO inside is guarded).
        if (n != null) void coord.handleToggle(n, dir)
      } else if (effect === "arm" || effect === "disarm") {
        // PRO-660: persist the optimistic pending flip to the durable marker.
        // The build-side actor (monitorPhase) is the applier; the panel only
        // writes/deletes the intent. `persistPending` reverts + notices on throw.
        coord.persistPending()
      }
    }
    process.stdin.on("data", dataHandler)
  }

  // Poll loop: render one frame per tick (cursor-home + clear-to-end → no flicker).
  for (;;) {
    const snap = readDashboardSnapshot(dir, slug)
    const prNumber = snap.state?.prNumber
    const prKnown = prNumber != null
    // Reconcile the PRO-660 pending display from the durable marker (so build-side
    // consumption + disarm are reflected) and the failure notice from the
    // apply-error file (TTL-resolved). The panel is NOT the actor — it never
    // enables auto-merge and never writes the apply-error file.
    coord.sync({
      prKnown,
      toggleAvailable: isTty && prKnown,
      armAvailable: isTty,
      pending: readPendingIntent(dir),
      applyError: resolveApplyError(readApplyError(dir), Date.now()),
    })
    if (prKnown && coord.dueForRefresh(AUTO_MERGE_POLL_INTERVAL_MS))
      void coord.refresh(prNumber, dir)
    // Dev-server controls are live only on a TTY AND a herdr-framed build (the
    // pane file the kickoff provider recorded). Standalone → status still renders,
    // controls hidden (mirrors auto-merge's toggleAvailable gate).
    const devControlsAvailable = isTty && readDevServerPane(dir) != null
    devCoord.sync({ controlsAvailable: devControlsAvailable })
    if (devCoord.dueForRefresh(DEV_SERVER_POLL_INTERVAL_MS))
      void devCoord.refresh()
    const frame = renderDashboard(snap, {
      nowMs: Date.now(),
      columns: process.stdout.columns ?? 80,
      autoMerge: coord.getView(),
      devServer: devCoord.getView(),
    })
    process.stdout.write(`${ESC}H${ESC}0J${frame}`)
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }
}

if (import.meta.main) {
  void main()
}
