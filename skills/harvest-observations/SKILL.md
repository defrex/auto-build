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

   **`e2e-infra` observations** (the kind the build pipeline's e2e stages emit when
   a flow can't be e2e-tested locally — a service that should be mockable but isn't,
   a missing fixture/seed, un-settable local state, an external dependency with no
   local stand-in) cluster toward **"make more of the product e2e-testable"**
   investment: group them by the missing capability (e.g. several "no local
   stand-in for &lt;service&gt;" notes → one "build a local test harness for
   &lt;service&gt;" project) rather than scattering them across unrelated feature
   issues.

   **`eval-infra` observations** (the kind the build pipeline's `evals` stages emit
   when a changed model-facing prompt is hard to eval-cover because the harness
   lacks a driver, fixture, or seed for that automation/session surface) cluster
   toward **"make more of the agent eval-coverable"** investment: group them by the
   missing driver/fixture/automation surface (e.g. several "no eval driver for
   &lt;automation&gt; sessions" notes → one "add an eval driver for
   &lt;automation&gt;" project), mirroring the broad-merge `e2e-infra` default above
   rather than scattering them across unrelated feature issues.

   **`schema-narrow` observations** are the deferred **narrow** of a Convex
   widen→migrate→narrow migration: an orphaned deprecated field or dead union
   literal left in `apps/web/convex/schema.ts` after the widen+migrate landed,
   along with its `@deprecated` / "narrow to required in a follow-up deploy"
   comment. Each narrow is an **independent, safe-to-do** task. Cluster
   **narrowly**: group only narrows for the **same migration/table** into one
   "complete the narrow of &lt;table.field&gt;" Triage ticket. **Do NOT collapse
   unrelated migrations into one mega-ticket** — this is the *opposite* of the
   `e2e-infra` default above (which merges broadly by missing capability); here
   over-merging produces an un-actionable grab-bag, so keep distinct migrations in
   distinct tickets. The filed brief MUST carry forward: (a) the **safety
   precondition** — "verify nothing still reads/writes the deprecated field and the
   backfill completed before deleting" — (b) the **widen+migrate origin**
   (PR/commit/migration), and (c) the pointer to the `convex/schema.ts`
   deprecation comment, so the implementer (and `/build`) can confirm no remaining
   readers before deleting.

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
