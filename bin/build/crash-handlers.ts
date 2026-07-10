/**
 * Crash & signal handlers for the build orchestrator — the death-attribution
 * safety net the `run()` phase loop's `try/catch` can't cover.
 *
 * The phase loop already parks THROWN/awaited errors. These handlers cover the
 * ASYNCHRONOUS faults outside that try: an OS signal (H4), an `uncaughtException`
 * / `unhandledRejection` (any in-process async crash), and a write-side EPIPE on
 * `process.stdout`/`stderr` (H2 — Node surfaces this as an async `'error'` event,
 * not a synchronous throw, so `safeStreamWrite`'s swallow can't see it).
 *
 * Fully injectable (`proc`/`stdout`/`stderr`) so it is unit-testable without
 * touching the real `process` or exiting the test runner.
 */

import { isEpipe } from "./safe-output"

/** Exit code per signal — `128 + signum`, matching the shell's `$?` convention. */
export const SIGNAL_EXIT: Record<string, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
}

export type CrashHandlerArgs = {
  /** Append a diagnostic line to build.log (wraps `appendLog(ctx.logPath, …)`). */
  logLine: (message: string) => void
  /** Park the run (mark blocked + write NEEDS-INPUT) on an in-process crash. */
  onUncaught: (
    err: unknown,
    origin: "uncaughtException" | "unhandledRejection",
  ) => void
  /** Extra hook run on a signal before exit (e.g. stop the heartbeat). */
  onSignal?: (signal: NodeJS.Signals) => void
  /** Injectable process; defaults to the real `process`. */
  proc?: NodeJS.EventEmitter & { exit(code: number): never }
  /** Injectable stdout; defaults to `process.stdout`. */
  stdout?: NodeJS.EventEmitter
  /** Injectable stderr; defaults to `process.stderr`. */
  stderr?: NodeJS.EventEmitter
}

/**
 * Install signal, uncaught/unhandled, and stream-EPIPE handlers. Each produces a
 * distinct `build.log` fingerprint so every abnormal death is attributable:
 *
 * - **H2 (EPIPE echoing child stdout):** log ONCE `stream: EPIPE …; continuing`,
 *   then swallow — the run survives (silent-crash path eliminated AND still
 *   attributable). A non-EPIPE stream error rethrows to surface via
 *   `uncaughtException`.
 * - **H4 (external signal):** log `signal: received <SIG> — exiting`, run
 *   `onSignal`, exit `128 + signum`.
 * - **Any in-process async fault:** log `uncaught (<origin>): <stack>`, park via
 *   `onUncaught`, exit 1 — a non-zero code that can never masquerade as a kill
 *   (1 ≠ 137/143/…). NOTE: this makes EVERY `unhandledRejection` build-fatal
 *   (intentional, per spec: "a crash must never masquerade as a kill"). Any
 *   future fire-and-forget promise that rejects anywhere in a build run will
 *   park the build as `blocked` and exit 1 — attach a `.catch` to background
 *   work that is legitimately allowed to fail.
 *
 * `run()` runs once per process, so handlers register once. A future caller
 * invoking `run()` twice would stack `process.on` listeners — acceptable for now.
 */
export function installCrashHandlers(args: CrashHandlerArgs): void {
  const proc = args.proc ?? (process as CrashHandlerArgs["proc"])
  const stdout = args.stdout ?? process.stdout
  const stderr = args.stderr ?? process.stderr
  if (!proc) return

  // H2 — log-once so a repeatedly-emitting broken pipe can't flood build.log.
  let epipeLogged = false
  const onStreamError = (which: "stdout" | "stderr") => (err: unknown) => {
    if (isEpipe(err)) {
      if (!epipeLogged) {
        epipeLogged = true
        args.logLine(`stream: EPIPE writing ${which} echo; continuing`)
      }
      return
    }
    // Non-EPIPE: rethrow so it surfaces via uncaughtException + gets a fingerprint.
    throw err
  }
  stdout.on("error", onStreamError("stdout"))
  stderr.on("error", onStreamError("stderr"))

  // H4 — external signals.
  for (const sig of Object.keys(SIGNAL_EXIT) as NodeJS.Signals[]) {
    proc.on(sig, () => {
      args.logLine(`signal: received ${sig} — exiting`)
      args.onSignal?.(sig)
      proc.exit(SIGNAL_EXIT[sig])
    })
  }

  // In-process async faults — a crash must never masquerade as a kill.
  proc.on("uncaughtException", (err: unknown) => {
    const stack = (err as Error)?.stack ?? String(err)
    args.logLine(`uncaught (uncaughtException): ${stack}`)
    args.onUncaught(err, "uncaughtException")
    proc.exit(1)
  })
  proc.on("unhandledRejection", (err: unknown) => {
    const stack = (err as Error)?.stack ?? String(err)
    args.logLine(`uncaught (unhandledRejection): ${stack}`)
    args.onUncaught(err, "unhandledRejection")
    proc.exit(1)
  })
}
