/**
 * Pure CLI arg parsing for kickoff's arg-style modes (`--restore` / `--cleanup`),
 * kept out of the loop-infra `monitor.ts` so mode detection stays a single,
 * unit-testable seam. `main()` dispatches on these.
 */

/** `--restore` rebuilds local environments for In-Progress tickets. */
export function isRestoreMode(argv: string[]): boolean {
  return argv.includes("--restore")
}

/** `--cleanup` tears down a single workspace. */
export function isCleanupMode(argv: string[]): boolean {
  return argv.includes("--cleanup")
}

/** `--help` / `-h` prints usage and exits before any other mode runs. */
export function isHelpMode(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h")
}

export type CleanupArgs = {
  /** Target the gwt worktree whose dir name ends in `-<slug>` (the build slug). */
  slug: string | null
  /** Target the worktree checked out on this branch. */
  branch: string | null
  /** Bypass BOTH safety guards (manual human override). */
  force: boolean
  /** Caller asserts the PR merged; bypass the unpushed guard only. */
  merged: boolean
}

/**
 * Read the value of `--flag value` or `--flag=value` from argv, or null when the
 * flag is absent or has no following value.
 */
function flagValue(argv: string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === flag) {
      const next = argv[i + 1]
      return next !== undefined ? next : null
    }
    if (arg.startsWith(`${flag}=`)) {
      return arg.slice(flag.length + 1)
    }
  }
  return null
}

/**
 * Parse the cleanup-mode flags. Mechanical only — `--slug` + `--branch` together
 * is NOT rejected here (the conflict is surfaced in `resolveCleanupTarget`).
 */
export function parseCleanupArgs(argv: string[]): CleanupArgs {
  return {
    slug: flagValue(argv, "--slug"),
    branch: flagValue(argv, "--branch"),
    force: argv.includes("--force"),
    merged: argv.includes("--merged"),
  }
}
