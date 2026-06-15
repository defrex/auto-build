/**
 * ENTRYPOINT: read an agent result (or a reconcile classification), append the
 * resulting rows to the ledger, and COMMIT the ledger in the same run — the
 * durability guarantee that a re-run mints no duplicates (design "Idempotency").
 *
 *   bun run bin/kickoff/record-outcomes.ts <result.json> [--push] [--dry-run]
 *   bun run bin/kickoff/record-outcomes.ts --reconcile <classification.json> [--push] [--dry-run]
 *
 * `<result.json>` is `{ outcomes: [...], seenUpdates: [...] }` (see outcomes.ts).
 * `<classification.json>` is `{ "<issueUuid>": "rejected" | "done", ... }`.
 * `--dry-run` prints the rows it would append (and the commit it would make)
 * without writing or committing. `--push` also pushes the ledger commit.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { detectRepoRoot, type ShResult, sh } from "../build/repo"
import { loadConfig, validateConfig } from "./config"
import {
  appendRows,
  type LedgerRow,
  type ReconcileState,
  readLedger,
  reconcile,
} from "./ledger"
import {
  type CommitLedgerResult,
  commitLedger,
  LEDGER_PATH,
} from "./ledger-commit"
import { type AgentResult, applyOutcomes } from "./outcomes"

export type PersistArgs = {
  repoRoot: string
  ledgerPath: string
  rows: LedgerRow[]
  push: boolean
  dryRun: boolean
  exec?: (cmd: string[], cwd: string) => ShResult
}

/**
 * Append rows + commit the ledger (unless dry-run). Returns the commit result,
 * or null when nothing was persisted (dry-run or no rows).
 */
export function persistRows({
  repoRoot,
  ledgerPath,
  rows,
  push,
  dryRun,
  exec = sh,
}: PersistArgs): CommitLedgerResult | null {
  if (dryRun || rows.length === 0) return null
  appendRows(ledgerPath, rows)
  return commitLedger({ repoRoot, push, exec })
}

export type RecordOptions = {
  push?: boolean
  dryRun?: boolean
  now: string
  exec?: (cmd: string[], cwd: string) => ShResult
}

/**
 * Apply an agent result against the ledger at `ledgerPath` and persist it.
 * Returns the rows computed (for logging/tests) and the commit result.
 */
export function recordOutcomes(
  repoRoot: string,
  ledgerPath: string,
  result: AgentResult,
  opts: RecordOptions,
): { rows: LedgerRow[]; commit: CommitLedgerResult | null } {
  const ledger = readLedger(ledgerPath)
  const rows = applyOutcomes(ledger, result, opts.now)
  const commit = persistRows({
    repoRoot,
    ledgerPath,
    rows,
    push: opts.push ?? false,
    dryRun: opts.dryRun ?? false,
    exec: opts.exec,
  })
  return { rows, commit }
}

function parseFlags(argv: string[]) {
  return {
    push: argv.includes("--push"),
    dryRun: argv.includes("--dry-run"),
    reconcile: argv.includes("--reconcile"),
    positional: argv.filter((a) => !a.startsWith("--")),
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(Bun.argv.slice(2))
  const file = flags.positional[0]
  if (!file) {
    console.error(
      "Usage: record-outcomes.ts <result.json> [--push] [--dry-run] | --reconcile <classification.json>",
    )
    process.exit(1)
  }

  const repoRoot = detectRepoRoot()
  validateConfig(loadConfig(repoRoot))
  const ledgerPath = join(repoRoot, LEDGER_PATH)
  const now = new Date().toISOString()
  const ledger = readLedger(ledgerPath)

  const rows = flags.reconcile
    ? reconcile(
        ledger,
        JSON.parse(readFileSync(file, "utf-8")) as Record<
          string,
          ReconcileState
        >,
        now,
      )
    : applyOutcomes(
        ledger,
        JSON.parse(readFileSync(file, "utf-8")) as AgentResult,
        now,
      )

  if (flags.dryRun) {
    process.stdout.write(
      `[dry-run] would append ${rows.length} row(s) and commit ${LEDGER_PATH}:\n`,
    )
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
    return
  }

  const commit = persistRows({
    repoRoot,
    ledgerPath,
    rows,
    push: flags.push,
    dryRun: false,
  })
  process.stdout.write(
    `Appended ${rows.length} row(s). committed=${commit?.committed ?? false} pushed=${commit?.pushed ?? false}\n`,
  )
  // A push rejection means a single-writer conflict (someone landed a ledger
  // change in between). The issues are already created; surface the orphaned
  // commit and exit non-zero so the operator reconciles (plan §0.2).
  if (commit?.error) {
    console.error(
      `Ledger commit/push failed: ${commit.error.stderr || commit.error.stdout}`,
    )
    if (commit.committed && !commit.pushed) {
      console.error(
        "The ledger commit is local but unpushed. Run `git pull --rebase` to converge with the other writer, then re-run (the rebased ledger still dedups locally).",
      )
    }
    process.exit(2)
  }
}

if (import.meta.main) {
  await main()
}
