---
name: triage-sentry
description: Mine production Sentry errors into clustered, deduped Linear maintenance issues. Filters by frequency/users/recency/deploy-staleness, root-causes survivors via /investigate, clusters by cause, files Triage issues, and records + commits the dedup ledger. Heavy filtering, then synthesis. Ingesters propose, never dispatch. Use when triaging the Sentry backlog into maintenance work.
user-invocable: true
---

# /triage-sentry

You are the **Sentry triage** ingester — *triage + root-cause*. Errors are
low-signal, high-volume: decide what is real, still happening, and impactful
**before** anything becomes a task. **Heavy filtering, then synthesis.** You
share the harvester's backend (dedup ledger, caps, Linear contract, commit step)
but have a heavier front-end. You **propose** Triage issues; never dispatch.

The threshold predicate and the ledger are code (`bin/kickoff/sentry-filter.ts`,
`bin/kickoff/ledger.ts`). You own the MCP reads, the `/investigate` root-cause,
clustering, and brief authoring.

## Setup gate

As `harvest-observations`: read `build/kickoff/config.json`; if Linear IDs are
unset, STOP and point at `build/kickoff/README.md` → Setup.

## Steps

1. **Reconcile open issues first.** Same as the harvester step 2 — classify every
   `openIssues` issue's current Linear state and run
   `bun run bin/kickoff/record-outcomes.ts --reconcile <classification.json>`.
   (Get `openIssues` from the ledger; you can run `scan-observations.ts` purely
   for its `openIssues` field, or read `ledger.jsonl` open rows.)

2. **Pull + filter.** Query the Sentry MCP for production issues
   (`mcp__sentry__find_organizations` → `find_projects` → `search_issues`, per
   `/investigate` Path B). Determine `latestDeployAt`:
   - try Sentry release/deploy data for the project; else the latest production
     deploy from Vercel or the latest `main` deploy tag; if none is reachable,
     use `null` (the filter falls back to a tight recency window and flags the
     skipped check — see README "Known limitation").

   Normalize each issue to `{ shortId, events, users, lastSeen, status, environment }`
   and keep only threshold survivors. The thresholds + deploy-staleness logic live
   in `bin/kickoff/sentry-filter.ts` (`passesSentryThreshold`); apply the same
   rules (don't re-derive them). Dedup against the ledger by the **project-scoped
   Sentry id**. Build it by the EXACT format defined in code —
   `sentrySignalId({ organizationSlug, projectSlug, shortId })` in
   `bin/kickoff/sentry-filter.ts`, which yields
   `sentry:<organizationSlug>/<projectSlug>/<shortId>`. Use that format verbatim
   (it is the single source of truth, unit-tested) so the id never drifts between
   runs. No content hashing — the short-id is the upstream fingerprint.

3. **Cap investigations.** Take at most `caps.maxInvestigationsPerRun` survivors —
   investigation is the expensive step.

4. **Root-cause.** Run the `/investigate` skill's Path B on each survivor to get
   trigger / mechanism / scope / why-now. Do **not** re-derive this — reuse
   `/investigate` (it already stops before fixing).

5. **Cluster by root cause.** Group errors sharing a cause into one issue. Heavy
   filtering already happened, so clustering is lighter than for observations.

6. **Create + record + commit.** Identical to the harvester steps 5–6, but with
   the `source:sentry` label (`sourceSentryLabelId`) and the Sentry signal ids
   recorded as the cluster's signals. Outcomes use `source: "sentry"`. Then:

   ```bash
   bun run bin/kickoff/record-outcomes.ts <result.json>        # add --push in CI
   ```

## Rules

- Never move an issue past Triage.
- Specify from the root cause. The `/investigate` output gives you trigger,
  mechanism, scope, and why-now — that's enough to write a buildable brief.
  **Only** when a fix genuinely requires a product decision or information you
  can't recover should you file the issue anyway and add the `needs-definition`
  label (`needsDefinitionLabelId`) so the dispatcher skips it until a human
  fleshes it out. Sparing exception, not a default.
- Respect the caps; overflow is reconsidered next run.
- Surface commit/push failures rather than swallowing them.
