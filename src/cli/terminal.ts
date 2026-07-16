/**
 * The output seam for interactive rendering (SPEC §14).
 *
 * `ab dispatch` writes lines through a `stdout: (line) => void` dep. That is
 * the right shape for append-only output and the wrong one for a redrawn
 * region, which needs raw writes (no implicit newline), the terminal width,
 * and — above all — an honest answer to "is anyone watching?".
 *
 * The seam is deliberately tiny and injectable: `DispatchOpts.terminal` is
 * OPTIONAL, and absent ⇒ non-interactive ⇒ plain output. That default is what
 * keeps every existing dispatch test (and every piped invocation) on exactly
 * today's behavior, and it means the dashboard can never be the reason a
 * scripted `ab dispatch` starts emitting escape sequences.
 */

export interface TerminalOut {
  /** Raw write — no newline appended (unlike the line-oriented stdout dep). */
  write(chunk: string): void
  /** Terminal width in columns; a sane fallback when unknown. */
  columns: number
  /** True only for a real TTY — false for pipes and redirects. */
  interactive: boolean
}

/** Width to assume when the stream reports none — the conventional default. */
const FALLBACK_COLUMNS = 80

/**
 * `stream.columns` for a real terminal, else the fallback.
 *
 * The guard is `> 0`, not `?? `: a TTY may report **0** columns — `script(1)`,
 * many pty wrappers, and some CI runners all do — and `0 ?? 80` is `0`, which
 * truncates every line to nothing and collapses the dashboard to a column of
 * ellipses. Zero is not a width; it means "this terminal will not say".
 */
function resolveColumns(stream: NodeJS.WriteStream): number {
  const columns = stream.columns
  return typeof columns === 'number' && columns > 0 ? columns : FALLBACK_COLUMNS
}

/**
 * The real terminal over a Node/Bun write stream.
 *
 * `isTTY` is `undefined` when stdout is a pipe or a file, so
 * `stream.isTTY === true` delivers "non-interactive output, including
 * redirected or piped output, automatically uses plain mode" for free — there
 * is no separate detection path to keep in sync.
 *
 * `columns` is a getter, not a snapshot: a resized window is picked up on the
 * next frame without anyone subscribing to SIGWINCH.
 */
export function processTerminal(stream: NodeJS.WriteStream = process.stdout): TerminalOut {
  return {
    write: (chunk: string) => {
      stream.write(chunk)
    },
    get columns(): number {
      return resolveColumns(stream)
    },
    interactive: stream.isTTY === true,
  }
}
