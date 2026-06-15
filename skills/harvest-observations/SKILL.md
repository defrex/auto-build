---
name: harvest-observations
description: Mine build/<dir>/observations.md into clustered, deduped Linear maintenance issues. Re-validates staleness, clusters related findings into one issue each, files them in Triage with their source label, and records + commits the dedup ledger. Ingesters propose, never dispatch. Use when sweeping accumulated build observations into the maintenance backlog.
user-invocable: true
---

# /harvest-observations

You are the **observation harvester** — the *synthesis* ingester. Observations are
already high-signal and pre-curated (a build agent decided each was worth noting).
Your job is to re-validate, cluster, dedup, and promote. **Low filtering, high
merging.** You **propose** Triage issues; you never move anything to Ready/dispatch.

The deterministic core (hashing, dedup, caps, ledger commit) is code in
`bin/kickoff/`. You own only judgment: clustering, staleness, brief authoring,
and the Linear MCP reads/writes. **Never decide signal identity yourself** — trust
the `signalId`s the scanner emits.

## Setup gate

Read `build/kickoff/config.json`. If the Linear IDs are unset, STOP and point
the user at `build/kickoff/README.md` → Setup. (`scan-observations.ts` also
hard-stops on unset config.)

## Steps

1. **Scan (deterministic).** Run:

   ```bash
   bun run bin/kickoff/scan-observations.ts
   ```

   It prints a JSON packet: `candidates` (fresh signals, capped at
   `caps.maxNewIssuesPerRun`), `seenUpdates` (known-open signals seen again),
   `openIssues` (issues already filed + their signals), and `skipped` (overflow,
   reconsidered next run). Save the JSON.

2. **Reconcile open issues FIRST.** For every issue in `openIssues`, query its
   current Linear state via MCP. Build a classification JSON mapping each
   `issueUuid` that has reached a terminal state to `"rejected"` (canceled /
   won't-do — any state in `rejectedStateIds`) or `"done"` (merged / done state).
   Write it to a temp file and run:

   ```bash
   bun run bin/kickoff/record-outcomes.ts --reconcile <classification.json>
   ```

   This tombstones/terminalizes **every** signal of rejected/done issues *before*
   clustering, so a rejected signal can never be resurrected.

3. **Staleness re-validation.** For each fresh `candidate`, open its `where:`
   `file:line`. If the referenced code is clearly gone or already fixed, mark it
   `tombstoned-stale`. **Ambiguous ≠ stale** — when unsure, keep it (don't lose
   signal).

4. **Cluster + author briefs.** Group surviving candidates that describe the same
   underlying problem into **one** issue each (e.g. several unbounded `.collect()`
   notes across dirs → one "make these reads bounded" project). For each cluster,
   write a proto-spec brief: **what** the problem is, **where** it lives, **why it
   matters**, and a **suggested direction**. The brief must be rich enough to
   become a `spec.md` without re-deriving everything.

5. **Create Linear issues (MCP).** Create each cluster as an issue in the **Triage**
   state (`triageStateId`), with:
   - the `source:observations` label (`sourceObservationsLabelId`),
   - the brief as the body, plus a hidden `<!-- signals: <id>, <id> -->` block
     listing the cluster's member `signalId`s for traceability.

   Your default obligation is unchanged: write a brief rich enough to become a
   `spec.md`. **Only** when a cluster genuinely can't be specified without a
   product decision or missing information, file it anyway and add the
   `needs-definition` label (`needsDefinitionLabelId`) so the dispatcher won't
   pick it up until a human fleshes it out. This is the rare exception, not a
   dumping ground — capturing the signal with the label beats dropping it, but a
   well-specified brief is always the goal.

6. **Record + commit (deterministic).** Write an agent-result JSON:

   ```jsonc
   {
     "outcomes": [
       { "signalId": "sha256:…", "outcome": "filed",  "source": "observations", "ref": "build/x/observations.md#…", "issueId": "DIS-1", "issueUuid": "…" },
       { "signalId": "sha256:…", "outcome": "joined", "source": "observations", "ref": "build/y/observations.md#…", "issueId": "DIS-1", "issueUuid": "…" },
       { "signalId": "sha256:…", "outcome": "tombstoned-stale", "source": "observations", "ref": "build/z/observations.md#…" }
     ],
     "seenUpdates": [ { "signalId": "sha256:…" } ]
   }
   ```

   The **first** signal of a cluster is `filed`; the rest are `joined` (same
   `issueId`/`issueUuid`). Carry `seenUpdates` through from the scan packet
   verbatim. Then:

   ```bash
   bun run bin/kickoff/record-outcomes.ts <result.json>        # add --push in CI
   ```

   This appends rows and **commits** `ledger.jsonl` in the same run (the dedup
   durability guarantee). Land that commit on `main` before the next run. Use
   `--dry-run` first to preview the rows.

## Rules

- Never move an issue past Triage. Grooming (move to Ready) is the human's job.
- Respect the cap — overflow is not lost (it's simply absent from the ledger and
  reconsidered next run).
- Surface, don't swallow, errors. If `record-outcomes.ts` reports a commit/push
  failure, stop and tell the user (single-writer conflict — see README).
