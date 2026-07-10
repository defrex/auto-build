/**
 * Durable commit of the dedup ledger (the design's "make-or-break" persistence).
 *
 * `record-outcomes.ts` calls this in the SAME run that created the Linear issues,
 * so the ledger mutation is persisted to git immediately — a fresh checkout or a
 * clean reset never re-mints duplicates. Modeled on `bin/build/repo.ts`'s
 * `commitArtifacts` / `publishArtifacts` (injectable `exec` for hermetic tests).
 *
 * Single-writer (design "Idempotency"): a rejected push means someone landed a
 * ledger change in between; the caller logs the orphaned commit and the next run
 * re-reads the updated ledger and reconciles.
 */

import { type ShResult, sh } from "../build/repo"

export const LEDGER_PATH = "build/kickoff/ledger.jsonl"

export type CommitLedgerArgs = {
  repoRoot: string
  push: boolean
  exec?: (cmd: string[], cwd: string) => ShResult
}

export type CommitLedgerResult = {
  committed: boolean
  pushed: boolean
  /** The underlying failing result, when commit or push failed. */
  error?: ShResult
}

export function commitLedger({
  repoRoot,
  push,
  exec = sh,
}: CommitLedgerArgs): CommitLedgerResult {
  exec(["git", "add", "--", LEDGER_PATH], repoRoot)
  // `git diff --cached --quiet` exits 0 when nothing is staged → nothing to do.
  const staged = exec(
    ["git", "diff", "--cached", "--quiet", "--", LEDGER_PATH],
    repoRoot,
  )
  if (staged.code === 0) return { committed: false, pushed: false }

  const commit = exec(
    [
      "git",
      "commit",
      "-m",
      "chore(kickoff): record ledger outcome(s) [skip ci]",
      "--",
      LEDGER_PATH,
    ],
    repoRoot,
  )
  if (commit.code !== 0)
    return { committed: false, pushed: false, error: commit }

  if (!push) return { committed: true, pushed: false }

  const pushed = exec(["git", "push"], repoRoot)
  if (pushed.code !== 0)
    return { committed: true, pushed: false, error: pushed }
  return { committed: true, pushed: true }
}
