/**
 * ENTRYPOINT: scan `build/<dir>/observations.md`, dedup against the ledger, and
 * emit a candidate packet JSON for the harvest-observations skill to cluster +
 * file. Deterministic and side-effect-free (it never writes Linear or the
 * ledger), so `--dry-run` is identical to a normal run.
 *
 *   bun run bin/kickoff/scan-observations.ts [--dry-run]
 *
 * The packet carries fresh candidates (capped), the seen-again updates to carry
 * through to record-outcomes, the still-open issues (clustering + reconcile
 * context), and the overflow count.
 */

import { join } from "node:path"
import { detectRepoRoot } from "../build/repo"
import { slugify } from "./branch"
import { type SeenUpdate, selectCandidates } from "./candidates"
import { type KickoffConfig, loadConfig, validateConfig } from "./config"
import {
  type LedgerRow,
  type OpenIssue,
  openIssues,
  readLedger,
} from "./ledger"
import { LEDGER_PATH } from "./ledger-commit"
import {
  collectObservationSignals,
  type ObservationSignal,
  signalIdFor,
} from "./observation-signals"

export type ObservationCandidate = ObservationSignal & {
  signalId: string
  source: "observations"
  /** Human-readable origin, e.g. `build/payg/observations.md#make-reads-bounded`. */
  ref: string
}

export type ObservationPacket = {
  source: "observations"
  candidates: ObservationCandidate[]
  seenUpdates: SeenUpdate[]
  openIssues: OpenIssue[]
  skipped: number
}

/** Build the candidate packet from the repo's observations + the current ledger. */
export function buildObservationPacket(
  repoRoot: string,
  cap: number,
  ledger: LedgerRow[],
): ObservationPacket {
  const signals: ObservationCandidate[] = collectObservationSignals(
    repoRoot,
  ).map((s) => ({
    ...s,
    signalId: signalIdFor(s),
    source: "observations" as const,
    ref: `${s.sourcePath}#${slugify(s.title)}`,
  }))
  const { packet, updates, skipped } = selectCandidates(signals, ledger, cap)
  return {
    source: "observations",
    candidates: packet,
    seenUpdates: updates,
    openIssues: openIssues(ledger),
    skipped,
  }
}

async function main(): Promise<void> {
  const repoRoot = detectRepoRoot()
  const config: KickoffConfig = loadConfig(repoRoot)
  validateConfig(config)
  const ledger = readLedger(join(repoRoot, LEDGER_PATH))
  const packet = buildObservationPacket(
    repoRoot,
    config.caps.maxNewIssuesPerRun,
    ledger,
  )
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`)
}

if (import.meta.main) {
  await main()
}
