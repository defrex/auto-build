/**
 * The ref kickoff worktrees are based on. Extracted into its own module (rather
 * than living in `kickoff.ts`) so `restore.ts` can import the constant without a
 * `kickoff.ts ↔ restore.ts` import cycle.
 *
 * A kickoff/restore run may run from any checkout (a stale local `main`, a
 * feature branch, another worktree), so worktrees MUST be anchored to this
 * remote-tracking ref rather than the run's current HEAD — otherwise a build can
 * inherit unrelated local changes and PR against the wrong base.
 */
export const KICKOFF_BASE_REF = "main"
