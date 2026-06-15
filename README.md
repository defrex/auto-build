# auto-build

A snapshot of the autonomous build system I run inside the Dispatch monorepo,
lifted out for sharing. It's five [Claude Code](https://claude.com/claude-code)
skills plus the deterministic TypeScript that powers them — together they take
work from *"something should be done"* all the way to a mergeable PR, with a human
only in the loop where judgment actually matters.

This is **not** an open-source product. It's a reference for friends who are
curious how I'm scaling the dev process: read it, steal the ideas, adapt the
pieces. It was lifted from a larger monorepo, so it won't run drop-in (see
[Caveats](#caveats-reading-this-in-isolation)).

## The idea: an engineering-manager loop

The system replicates what an engineering manager does: engineers and monitoring
surface problems, someone triages and batches them, work gets assigned, and code
ships. Each of those steps is a skill, and the steps chain into a loop:

```
  ┌─────────────────────────── signals ───────────────────────────┐
  │                                                                │
  │   build agents jot              production errors              │
  │   observations.md               in Sentry                      │
  │        │                             │                         │
  │        ▼                             ▼                         │
  │  /harvest-observations        /triage-sentry                   │
  │   (synthesis ingester)         (filter + root-cause ingester)  │
  │        │                             │                         │
  │        └──────────────┬──────────────┘                         │
  │                       ▼                                         │
  │              Linear "Triage" lane          ingesters PROPOSE   │
  │                       │                     — never dispatch    │
  │                       ▼                                         │
  │               human grooming  ◀── the one required human step  │
  │           (approve + prioritize → "Ready")                     │
  │                       │                                        │
  │                       ▼                                        │
  │                   /kickoff  ── claims a Ready issue,           │
  │                       │        makes a worktree, writes a      │
  │                       │        spec, launches /build           │
  │                       ▼                                        │
  │            ┌──────  /build  ──────┐   plan → build → review →  │
  │            │  (headless pipeline) │   PR, autonomously         │
  │            └──────────┬───────────┘                           │
  │                       ▼                                        │
  │                  mergeable PR ──▶ merge ──▶ Linear auto-resolves│
  │                       │                                        │
  │            (build agents notice out-of-scope issues along      │
  │             the way and append them to observations.md) ───────┘
```

The two ingesters (`/harvest-observations`, `/triage-sentry`) **only propose**
candidate issues into a Triage lane. A human grooms — approves and prioritizes —
moving the good ones to **Ready**. `/kickoff` picks up from Ready and runs each to
a PR. That single human gate is deliberate: it's where taste and prioritization
live, and it's the thing that keeps an autonomous fleet pointed at work worth doing.

`/spec` and `/build` are also usable directly, by hand, with no Linear or
ingesters involved — that's the inner loop. The kickoff funnel is the outer loop
that *feeds* `/build` automatically.

## The five skills

| Skill | Role | What it does |
|---|---|---|
| **`/spec`** | design | Designs a feature *through conversation* into `build/[feature]/spec.md`. A requirements doc — *what* and *why*, not *how*. Stops when the design is good. Can seed from / sync back to a Linear ticket. |
| **`/build`** | ship | Takes a `spec.md` through **plan → build → review → PR** autonomously. Launches a headless background process (`bin/build.ts`) that outlives the Claude session. Writes one short spec itself if none exists. |
| **`/kickoff`** | dispatch | Pulls groomed **Ready** Linear tickets, claims each, makes a worktree, writes its spec, and launches a supervised `/build`. Fills capacity then exits — cron-friendly. |
| **`/harvest-observations`** | ingest (synthesis) | Mines `build/*/observations.md` notes (jotted by build agents) into clustered, deduped Linear Triage issues. Low filtering, high merging. |
| **`/triage-sentry`** | ingest (triage) | Mines production Sentry errors into Linear Triage issues. Heavy filtering by frequency/users/recency/deploy-staleness, then `/investigate` root-cause, then clustering. |

### Two layers: judgment vs. determinism

Every skill is split the same way, and it's the core design principle worth
stealing:

- **The skill (`SKILL.md`)** owns *judgment* — the parts that need an LLM:
  conversation, clustering, root-causing, brief authoring, staleness calls.
- **The scripts (`bin/`)** own everything *deterministic* — state machines, dedup
  hashing, ledger commits, threshold filters, worktree provisioning, git/PR
  plumbing. These are plain TypeScript with unit tests (`*.test.ts`), so the
  reliable parts stay reliable and only the genuinely fuzzy parts run through a model.

So `/build` is a thin skill over a real state machine (`bin/build/`); the
ingesters are thin skills over a real dedup ledger and filter (`bin/kickoff/`).
The agent never decides signal identity or phase transitions — code does.

## Repo layout

```
skills/
  spec/SKILL.md                  # /spec
  build/SKILL.md                 # /build
  kickoff/SKILL.md               # /kickoff
  harvest-observations/SKILL.md  # /harvest-observations
  triage-sentry/SKILL.md         # /triage-sentry

bin/
  build.ts                       # entry: `bun run bin/build.ts <feature>`
  build/                         # the /build orchestrator (state machine)
    orchestrator.ts              #   top-level run loop
    state.ts                     #   on-disk resumable state (state.json)
    transitions.ts               #   phase → phase state machine
    harness.ts                   #   shells out to claude / codex per phase
    prompts.ts / spec-doc.ts     #   per-phase prompt + spec construction
    monitor.ts                   #   watches a running phase
    validate.ts                  #   gate checks (typecheck/lint/test/…)
    verdicts.ts                  #   parses reviewer verdicts
    repo.ts                      #   git/PR helpers
    linear-ticket.ts             #   ticket ↔ branch/PR linking
    dev-server.ts                #   owns the dev server for the e2e step
    mcp-config.ts                #   scopes a minimal MCP config for e2e
    log.ts                       #   build.log helper
    *.test.ts                    #   Bun unit tests for each module

  kickoff/                       # the kickoff funnel + ingester core
    kickoff.ts                   #   entry: claim → worktree → spec → launch /build
    kickoff-lock.ts              #   pid lockfile (safe overlapping cron ticks)
    worktree-provider.ts         #   git | superset worktree provisioning
    branch.ts / candidates.ts    #   branch naming, Ready-issue selection helpers
    spec-doc.ts / prompts.ts     #   spec writing + agent prompts
    scan-observations.ts         #   entry: deterministic observation scan packet
    observation-signals.ts       #   signal hashing for observations
    sentry-filter.ts             #   threshold + deploy-staleness predicate (Sentry)
    ledger.ts / ledger-commit.ts #   the dedup ledger (append + commit)
    outcomes.ts / record-outcomes.ts  # entry: record outcomes + commit ledger
    *.test.ts, __fixtures__/     #   Bun unit tests + fixtures

build/
  build-flow/design.html         # the design doc for the /build pipeline itself
  kickoff/
    README.md                    # the kickoff funnel's own docs + Setup
    config.json                  # Linear IDs + tunables — TEMPLATE, pin before use
    ledger.jsonl                 # the committed dedup ledger — shipped empty
```

(At runtime each feature gets a `build/<feature>/` dir holding its `spec.md`,
`state.json`, `build.log`, intermediate artifacts, and `observations.md`.)

## The `/build` pipeline

`/build` is the engine the whole system feeds. It runs a **resumable state
machine** as a background OS process:

- **Phases:** plan → build → review → PR. Each phase is a pure function of what's
  on disk in `build/<feature>/` plus the repo, so the pipeline is inspectable and
  resumable — re-running `/build <feature>` resumes from `state.json`; there's no
  separate resume path.
- **Harness routing:** each phase shells out to a coding CLI, configurable in
  `state.json → harnessMap` (default: claude/opus plans & builds, codex reviews).
  Mixing models across phases is intentional — a different reviewer catches more.
- **Gates:** `validate.ts` runs typecheck / lint / test between phases; the review
  phase loops until the reviewer's verdict passes (`verdicts.ts`).
- **Escalation:** when the build needs a human decision it parks, writes
  `NEEDS-INPUT.md`, and exits non-zero (code 2) so the supervising `/build` session
  surfaces the blocker. Resolve it, delete the file, re-run.
- **Audit trail in the PR:** on success the orchestrator commits the whole
  `build/<feature>/` dir (spec, plan, reviews, `build.log`, `state.json`) to the PR
  branch — every build carries its own paper trail.
- **Observations:** build and review agents append out-of-scope findings (latent
  bugs, refactors, tech debt) to `build/<feature>/observations.md` — an append-only
  backlog that never blocks the run. That file is exactly what
  `/harvest-observations` mines later, closing the loop.

See `build/build-flow/design.html` for the full pipeline design.

## The kickoff funnel

`bin/kickoff/` is the outer loop that manufactures buildable tickets and feeds
them to `bin/build.ts`. Its mechanics — the dedup **ledger**, the
**single-writer** discipline, **Sentry thresholds**, **worktree providers** (git
vs. superset), dry runs, and pruning — are documented in
[`build/kickoff/README.md`](build/kickoff/README.md). A few load-bearing ideas:

- **Dedup ledger (`ledger.jsonl`).** Every processed signal (an observation hash
  or a Sentry short-id) gets one committed row, so re-running an ingester never
  re-files a duplicate. `record-outcomes.ts` appends *and commits* in the same run;
  the commit must land on `main` before the next run. Single writer — never run two
  ingesters at once.
- **Claim-before-build.** `/kickoff` moves an issue to In-Progress *before*
  launching, so a crash or overlapping cron tick can't double-launch. A pid
  lockfile makes overlapping runs safe.
- **Ingesters propose, humans dispatch.** Nothing the ingesters file is ever moved
  past Triage automatically. Promotion to Ready is the human grooming step.

## Setup

This is a reference snapshot, but if you're adapting it the real prerequisites are:

1. **Pin `build/kickoff/config.json`.** It ships as a *template* with empty IDs.
   In an authenticated Linear MCP session, fill in your team/state/label UUIDs —
   the full procedure is in `build/kickoff/README.md` → Setup. The ingesters and
   `/kickoff` hard-stop until it's pinned.
2. **Authenticate the MCP servers** the skills use: Linear (all of kickoff),
   Sentry (`/triage-sentry`).
3. **Pick a worktree provider** (`config.json → worktree.provider`): `git` (the
   zero-setup default, `git worktree add`) or `superset` (provisions Superset
   workspaces so launched builds show up in the app).

## Runtime

Everything is written for the [Bun](https://bun.sh) runtime and shells out to the
`claude` and `codex` CLIs to run each phase. The Bun test files (`*.test.ts`) cover
the deterministic core.

## Caveats: reading this in isolation

Lifted from a larger monorepo, so a few things won't run standalone without
adaptation:

- The build/review prompts invoke other Dispatch skills by name at runtime (e.g.
  `/address-review`, `/code-review`, `/investigate`) — those aren't all included
  here. `/triage-sentry` in particular leans on `/investigate` for root-causing.
- `mcp-config.ts` reads the project's `.mcp.json` to scope the `next-devtools`
  browser MCP for the e2e step.
- The pipeline assumes repo conventions (commands like `bun run typecheck`,
  `bun run lint`, `bun run test`; a GitHub remote for PRs; Linear for tickets).
- `config.json` is a blanked template and `ledger.jsonl` ships empty — the real
  Linear workspace IDs and dedup history are intentionally not shared.

It's meant for reading and adaptation, not drop-in execution.
