# Kickoff

A funnel that manufactures buildable Linear tickets — maintenance or otherwise —
and feeds them into the existing build pipeline (`bin/build.ts`). It replicates
the engineering-manager loop: engineers (build agents, Sentry) surface problems;
this system triages, batches, and kicks them off.

- **Harvest observations** — mine `build/<dir>/observations.md` into Linear issues.
- **Triage Sentry** — mine production errors into Linear issues.
- **Groom (human)** — you approve + prioritize candidates into a Ready lane.
- **Kickoff** — pull one Ready issue (not marked `needs-definition`) and run it to a PR.

Ingesters **propose**; they never kick off builds. A ticket only becomes
buildable when a human moves it to **Ready**. The kickoff loop skips any Ready
issue carrying `needs-definition` (the relief valve for an under-specified
ticket), and any Ready issue **blocked by an unfinished issue** (a `blocked by`
relation clears only once the blocker reaches a completed-type state) — a
blocked ticket is passed over, not failed, and picked up on a later run once its
blockers complete. It also skips any Ready issue carrying a future
`<!-- defer-until: … -->` marker in its description (an absolute instant;
date-only = start of day UTC) — a deferred ticket stays a visible Ready
candidate, is passed over (not failed), and is picked up automatically on the
first run at/after that time. Deferral **composes with blocked-by** (skipped
until both gates clear); a malformed value is treated as not deferred and logged.

## Layout

- `config.json` — Linear IDs + tunables (this file's IDs MUST be pinned, see Setup).
- `ledger.jsonl` — the committed dedup ledger (one row per processed signal).
  Shipped empty. Never hand-edit; `record-outcomes.ts` appends + commits it.
- Deterministic code: `bin/kickoff/*` (unit-tested pure core + entrypoints).
- Skills: `.agents/skills/{harvest-observations,triage-sentry,kickoff}`.

## Setup (one-time, manual — there is no `--setup` flag)

The Linear team/project/state/label IDs can't be known ahead of time. Pin them
once, before the first run. In an authenticated session (Linear MCP available),
ask the agent to list them and fill `config.json`:

1. List the team and its workflow states + labels via the Linear MCP
   (`list_teams`, `list_issue_statuses`, `list_issue_labels`).
2. Fill `config.json`:
   - `teamId`, `projectId`
   - state ids: `triageStateId`, `readyStateId`, `inProgressStateId`,
     `doneStateId`, and every "won't do / canceled" state in `rejectedStateIds`
   - `inReviewStateId` — **OPTIONAL.** The build's `monitor` phase forward-only
     advances the ticket to this state once the PR is open. Unpinned → the move
     is skipped (a logged note) and the build still runs; it is not required by
     kickoff. Override at runtime with `KICKOFF_LINEAR_IN_REVIEW_STATE_ID`.
   - label ids: `sourceObservationsLabelId`, `sourceSentryLabelId`,
     `needsDefinitionLabelId`

   Creating the `needs-definition` label in Linear and pinning its ID is part of
   this setup (it gates kickoff — issues carrying it are never selected). Keep
   that label live: if it is archived/deleted in Linear, the select agent filters
   on a dead ID and the gate fails open (every Ready issue becomes selectable).
3. (Optional) override IDs at runtime with `KICKOFF_LINEAR_*` env vars
   (e.g. `KICKOFF_LINEAR_TEAM_ID`, `KICKOFF_LINEAR_NEEDS_DEFINITION_LABEL_ID`).
4. Pick a **worktree provider** (`worktree.provider`, default `git`; override
   with `KICKOFF_WORKTREE_PROVIDER`):
   - `git` — plain `git worktree add` into `../.kickoff-worktrees/<slug>`.
   - `superset` — provisions a Superset workspace via the `superset` CLI so
     launched builds show up in the Superset app. Requires `superset auth
     login`, the host service running, and `worktree.supersetProjectId`
     pinned to this repo's project UUID (`superset projects list --json`;
     `KICKOFF_SUPERSET_PROJECT_ID` also works). The kickoff run also makes the
     build **visible in the app**: it opens the workspace (`superset
     workspaces open` — the app only renders opened workspaces) and launches
     a `claude "/build <slug>"` supervisor session **detached** inside a
     `superset terminals create` session that outlives the kickoff run — the
     `/build` skill runs `bin/build.ts` in the background and escalates
     blockers (`NEEDS-INPUT.md`) to the user in the terminal. If the terminal
     can't be created (or the `claude` CLI isn't runnable) the build falls
     back to a synchronous headless `bin/build.ts` child process. Providers live in
     `bin/kickoff/worktree-provider.ts` — adding a new worktree tool is a new
     provider there plus a config value.

Until the IDs are pinned, the ingesters and the kickoff run hard-stop with a clear
message (config validation lives in `bin/kickoff/config.ts`).

### Linear API token (required for the kickoff/restore select)

The kickoff **select** (claim a Ready ticket) and **restore** select (list your
In-Progress tickets) are deterministic Linear API pulls — no agent. They need a
Linear personal API key in the **hand-managed** root `.env`:

```
LINEAR_API_KEY=lin_api_...
```

Create one at Linear → Settings → Security & access → Personal API keys. With it
set, the select steps run fully headless (no OAuth, no interactive session), so
the loop is cron-friendly. A missing key makes the select throw a clear error
(treated as a failure, never as an empty queue).

The **Sentry** MCP server still needs to be authenticated in the running session
for the `triage-sentry` ingester (see `.mcp.json`); the kickoff/restore selects
no longer depend on the Linear MCP.

## Running the loop (v1, manual)

**Harvest observations** — invoke the `harvest-observations` skill. It scans,
reconciles open issues, re-validates staleness, clusters, files Triage issues,
and records + commits the ledger.

**Triage Sentry** — invoke the `triage-sentry` skill. Shares the threshold
filter (`sentry-filter.ts`) + `/investigate` root-cause front-end, but dedups on
**live Sentry + Linear state** (breadcrumb notes on the Sentry issue + the linked
ticket's state) rather than the ledger. It does **not** read or write
`ledger.jsonl`; resolution rides shipped `fixes <SHORT-ID>` commits so regressions
re-enter naturally. Run its one-time **Bootstrap** (in the skill) before the first
live-state run. (`harvest-observations` still uses the ledger unchanged.)

**Kickoff** — after you've groomed issues into Ready (the kickoff loop skips any
Ready issue carrying `needs-definition`, and any Ready issue blocked by an
unfinished issue until every blocker reaches a completed-type state):

```bash
bun run bin/kickoff/kickoff.ts
```

Each run **fills capacity, then exits** (designed to be run periodically, e.g.
on a cron): it loops — claim one issue (moved to In-Progress before building),
create a worktree on a branch carrying the Linear id, write
`build/<slug>/spec.md` inside it, launch `bin/build.ts` there detached in a
Superset terminal — until the select agent reports at-capacity / nothing
ready (hard-capped at `maxConcurrentBuilds` launches per run). Launched builds
shepherd themselves to a PR; the kickoff run does not wait on them. Exit codes:
0 = launched what it could / nothing to do, 1 = an issue was claimed but its
build never launched (stuck In-Progress — bounce it by hand), 2 = a
*synchronous* fallback build (git provider or degraded superset)
blocked/failed — in that mode it's one build per run, 3 = the select agent
itself failed (nothing new claimed — verify in Linear). Overlapping runs are
safe: a pid lockfile (`.kickoff/kickoff.pid`) makes a second kickoff run exit
0 while one is already running.

#### Monitor mode (long-running)

Instead of one-shot + cron, run kickoff as a long-running daemon that re-runs
exactly one pass on a fixed interval:

```bash
bun run kickoff:monitor          # == bun run bin/kickoff/kickoff.ts --watch
```

(`--monitor` is an alias for `--watch`.) Each tick runs the same one-shot pass —
same capacity gate, same select agent. In-flight builds from earlier ticks count
against `maxConcurrentBuilds` automatically (the monitor does no capacity
accounting of its own), so it fills capacity as builds finish and new Ready
issues appear.

- **Interval:** every `KICKOFF_MONITOR_INTERVAL_SECONDS` seconds (default
  **300** / 5 min). An unset/empty/invalid/non-positive value falls back to the
  default.
- **Resilient to every exit code:** the loop logs each pass outcome (0/1/2/3)
  and a thrown pass, then sleeps and continues — a transient select-agent hiccup
  (code 3, e.g. a Linear MCP outage) never kills the daemon; the next tick may
  recover.
- **Lock per pass:** the pid lock is acquired and released *around each pass*,
  never across the sleep — a concurrent one-shot cron is blocked at most for one
  pass. Lock contention (another pass/cron mid-run) **skips the tick** and
  sleeps, rather than exiting.
- **Heartbeat:** each wake logs the pass outcome and the next wake time, so an
  operator watching the terminal can see it's alive.
- **Shutdown (`SIGINT`/`SIGTERM`):** stops cleanly. A signal during sleep exits
  promptly; a signal mid-pass lets the in-flight pass finish (interrupting a
  half-done claim/build is worse than finishing it). Pass children run detached
  (their own process group), so a terminal Ctrl+C never tears down an in-flight
  claim or build — under the **git sync-build provider** a pass can run a
  synchronous build for minutes/hours, so shutdown waits for it; under the
  superset provider passes are short. The lock is released on every pass, so a
  stopped monitor never wedges the next run (and `SIGKILL`, which bypasses the
  handlers, is recovered by the lock's stale-pid steal on the next run).

### Single-writer + ledger commit

v1 assumes a **single writer** — never run two ingesters concurrently. After an
ingester files issues, `record-outcomes.ts` commits `ledger.jsonl`. You must land
that commit on `main` (PR or direct push) before the *next* ingester run, so the
next run sees the updated ledger and never re-mints duplicates. If a `--push` is
rejected (someone landed a ledger change in between), the run aborts *after* the
issues were created and logs the orphaned commit — reconcile by hand, then re-run.

### Dry runs

- `bun run bin/kickoff/scan-observations.ts` — prints the candidate packet
  (side-effect-free).
- `bun run bin/kickoff/record-outcomes.ts <result.json> --dry-run` — prints the
  ledger rows it *would* append/commit without writing.

## Worktree pruning

Each kickoff leaves a worktree behind. The build commits its artifacts on the
branch but does **not** remove the worktree. After the PR merges (and Linear
auto-resolves the issue), prune it — how depends on `worktree.provider`:

```bash
# provider "git" — worktrees live at ../.kickoff-worktrees/<slug>
git worktree remove ../.kickoff-worktrees/<slug>

# provider "superset" — delete the workspace (the id is logged at launch
# time); this removes the worktree at ~/.superset/worktrees/<projectId>/<branch>
superset workspaces delete <workspace-id>
```

A **failed launch** (exit 1) under the superset provider also leaves a
workspace behind — delete it the same way when you bounce the issue back to
Triage.

Automatic cleanup is deferred (out of scope for v1).

## Known limitation — Sentry deploy staleness

The Sentry filter prefers to drop errors not seen since the latest production
deploy (`requireSeenSinceLatestDeploy`). If the running session can't reach
release/deploy data (Sentry MCP release fields, Vercel, or a `main` deploy tag),
it falls back to a tighter recency window (`staleAfterDeployFallbackDays`) and the
run log flags that the deploy check was skipped — the requirement is degraded,
not silently dropped. Confirm whether the Sentry MCP surface exposes release data
in your session; if not, the fallback is in effect.

## Threshold tuning (`sentry` block)

- **`minEvents` is intentionally low (`2`).** A repeating production error
  becomes a triage candidate from its **second** occurrence rather than waiting
  for a large pileup. Sentry's own trend detection (`is:regressed` /
  `is:escalating`) is the real frequency signal; the event floor just filters
  one-off noise.
- **`minAffectedUsers` is intentionally `0`.** User attribution isn't reliably
  present on Sentry events, so `users: 0` means *unattributed*, not *unaffected*.
  A positive floor would silently drop real errors that Sentry couldn't
  attribute to a user. `users` is a lower bound, never a penalty — it is
  boost-only in `prioritizeSentryCandidates` and must never be reintroduced as a
  positive filter floor casually. (Same rationale lives in the predicate comment
  in `bin/kickoff/sentry-filter.ts` and in `DEFAULT_SENTRY`.)
- **Overflow past `caps.maxInvestigationsPerRun` (`5`) is deferred, not
  dropped.** The lower floor routinely produces more survivors than the cap, so
  runs take survivors in `prioritizeSentryCandidates` order (worst first: Tier A
  regressed/escalating, then `events` desc, then `users` desc) and defer the rest
  to the next run.
