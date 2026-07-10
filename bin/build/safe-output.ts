/**
 * Crash-proof stream helpers shared by the streaming sinks in `harness.ts` and
 * `validate.ts` and by the crash handlers.
 *
 * These exist because the orchestrator streams child stdout/stderr to
 * `process.stdout`/`stderr` (the background-shell pipe) AND to `build.log`. A
 * write to that pipe can fail with EPIPE, and an unbounded in-memory copy of
 * child stdout is a memory-pressure liability (H1). Every helper here is pure
 * and dependency-free (except `appendFileSync`) so both sinks and the diagnostic
 * layer share one implementation.
 */

import { appendFileSync } from "node:fs"

/**
 * 1 MiB tail cap for the in-memory copy of a child's stdout. The verdict parser
 * (`verdicts.ts` → `lastSentinel`) scans from the END of the buffer, so keeping
 * only the trailing `CHILD_OUTPUT_CAP` chars is provably verdict-safe: the final
 * sentinel line is always retained. Any future consumer that needs the FULL
 * stdout would be affected — 1 MiB is far above any sentinel's needs.
 */
export const CHILD_OUTPUT_CAP = 1_048_576

/**
 * Append `next` to `prev`, then keep only the trailing `cap` characters. Bounds
 * memory (reducing H1 exposure) while retaining the tail the verdict parser
 * needs. Pure.
 */
export function boundedConcat(
  prev: string,
  next: string,
  cap = CHILD_OUTPUT_CAP,
): string {
  const combined = prev + next
  if (combined.length <= cap) return combined
  return combined.slice(combined.length - cap)
}

/** True when `err` is a Node EPIPE error (the H2 broken-pipe fingerprint). */
export function isEpipe(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "EPIPE"
}

/**
 * Write `text` to `stream`, swallowing any synchronous throw. `build.log` is the
 * authoritative sink, so a failed echo to the (possibly broken) background-shell
 * pipe must never take the process down.
 *
 * The swallow is intentionally SILENT to avoid double-logging: Node surfaces a
 * write-side EPIPE as an asynchronous `'error'` event, not a synchronous throw,
 * so the authoritative H2 fingerprint (the log-once `stream: EPIPE …` line) is
 * owned by the crash handler's stream `'error'` listener — see
 * `crash-handlers.ts`.
 */
export function safeStreamWrite(
  stream: NodeJS.WritableStream,
  text: string,
): void {
  try {
    stream.write(text)
  } catch {
    // Swallow: build.log is the authoritative sink; the crash handler's stream
    // 'error' listener owns the H2 fingerprint.
  }
}

/**
 * Append `text` to `logPath`, swallowing any failure. Best-effort — an
 * `appendFileSync` failure inside a stream `'data'` handler must never escape as
 * an uncaught exception and take the orchestrator down.
 */
export function safeAppend(logPath: string, text: string): void {
  try {
    appendFileSync(logPath, text)
  } catch {
    // Best-effort; must not escape a stream handler.
  }
}
