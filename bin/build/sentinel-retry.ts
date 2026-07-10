/**
 * Bounded auto-retry for a builder phase that exits WITHOUT emitting a
 * completion sentinel (PRO-639).
 *
 * Builder phases run single-turn via `claude --print` (see `harness.ts`
 * `builderArgs`). When a builder backgrounds a long command (an eval run, smoke
 * test, dev-server wait) and ends its turn expecting a background-task
 * notification / waiter task / scheduled wakeup to re-invoke it, those never
 * fire: the process exits, no sentinel (`PLAN_DONE`/`BUILD_DONE`/`E2E_PASS`…) is
 * emitted, and the orchestrator would park the build for a human on a purely
 * mechanical failure. This module relaunches the phase automatically (bounded)
 * with a corrective note appended, and only escalates once retries are
 * exhausted.
 *
 * The loop is kept pure and injectable (no `ctx`/spawn) so it unit-tests without
 * a subprocess. The orchestrator wraps `invokeBuilderRaw` as the `runner`.
 */

/** Bounded auto-retries for a builder phase that exits with no completion sentinel. */
export const SENTINEL_RETRY_CAP = 2

/** Corrective note injected into the prompt on each auto-retry (PRO-639). */
export function sentinelCorrectiveNote(attempt: number, cap: number): string {
  return [
    `AUTO-RETRY ${attempt} of ${cap} — your PREVIOUS attempt exited WITHOUT emitting a completion sentinel.`,
    "The overwhelmingly common cause: you backgrounded a long-running command (an eval run,",
    "smoke test, or dev-server wait) and ended your turn expecting a background-task",
    "notification, waiter task, or scheduled wakeup to re-invoke you. You run SINGLE-TURN via",
    "`claude --print`: those NEVER fire. Ending your turn while work is pending kills the run.",
    "Do it differently now: run long commands SYNCHRONOUSLY in the FOREGROUND in THIS turn. If",
    "one run would exceed the Bash timeout, split it into smaller chunks that each fit, checking",
    "intermediate output between chunks — results accumulate on disk, so chunking is safe and",
    "resumable. Finish the work and emit your completion sentinel before yielding.",
  ].join("\n")
}

export type SentinelRawRunner = (prompt: string) => Promise<string>

export type InvokeWithSentinelRetryArgs = {
  runner: SentinelRawRunner
  basePrompt: string
  /** True when the output carries a recognized sentinel (phase-specific). */
  hasSentinel: (output: string) => boolean
  maxRetries?: number
  /** Side effects per retry (log + analytics + persist counter). */
  onRetry?: (attempt: number) => void
  note?: (attempt: number, cap: number) => string
}

/**
 * Run `runner(basePrompt)`; while the output has no sentinel and retries remain,
 * re-run with the corrective note appended to the base prompt. Returns the final
 * output and the number of retries actually performed (0 == succeeded first try).
 */
export async function invokeWithSentinelRetry(
  args: InvokeWithSentinelRetryArgs,
): Promise<{ output: string; retries: number }> {
  const cap = args.maxRetries ?? SENTINEL_RETRY_CAP
  const note = args.note ?? sentinelCorrectiveNote
  let output = await args.runner(args.basePrompt)
  let retries = 0
  while (!args.hasSentinel(output) && retries < cap) {
    retries++
    args.onRetry?.(retries)
    output = await args.runner(`${args.basePrompt}\n\n${note(retries, cap)}`)
  }
  return { output, retries }
}
