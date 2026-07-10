/**
 * The `--help` / `-h` usage text for the kickoff CLI. Kept pure (a plain string
 * builder) so it stays unit-testable and `main()` only has to print it.
 */

/** The full usage text printed by `bun run kickoff --help`. */
export function kickoffHelpText(): string {
  return [
    "kickoff — pick up groomed Linear tickets and launch builds.",
    "",
    "USAGE",
    "  bun run kickoff [--watch | --monitor]",
    "  bun run kickoff --restore",
    "  bun run kickoff --cleanup (--slug <slug> | --branch <branch>) [--force] [--merged]",
    "  bun run kickoff --help | -h",
    "",
    "MODES",
    "  (default)            Run one fill pass: claim Ready issues (not marked",
    "                       needs-definition), create a worktree + spec per issue,",
    "                       and launch a detached /build, until at capacity or",
    "                       nothing is ready. Cron-friendly — exits without waiting",
    "                       on the launched builds.",
    "  --watch, --monitor   Long-running daemon: run a fill pass on an interval",
    "                       until SIGINT/SIGTERM. (alias: bun run kickoff:monitor)",
    "  --restore            Rebuild local worktree environments for In-Progress",
    "                       tickets (herdr provider only). Best-effort.",
    "  --cleanup            Tear down a single build workspace (worktree + branch).",
    "                       Requires --slug or --branch to target it.",
    "  --help, -h           Show this help and exit.",
    "",
    "CLEANUP FLAGS",
    "  --slug <slug>        Target the worktree whose dir ends in -<slug>.",
    "  --branch <branch>    Target the worktree checked out on <branch>.",
    "  --force              Bypass both safety guards (manual human override).",
    "  --merged             Assert the PR merged; bypass the unpushed-commits guard.",
    "",
    "ENVIRONMENT",
    "  KICKOFF_MONITOR_INTERVAL_SECONDS",
    "                       Seconds between passes in --watch mode (default 300).",
    "",
    "EXIT CODES (fill pass)",
    "  0  filled what it could / nothing ready / sync build succeeded",
    "  1  an issue was claimed but its build never launched (bounce to Triage)",
    "  2  a synchronous fallback build blocked or failed",
    "  3  the select agent itself failed — nothing new claimed",
  ].join("\n")
}
