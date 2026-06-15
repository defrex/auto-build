---
name: kickoff
description: Pick up groomed Linear tickets — maintenance or otherwise — and kick off builds in one pass. Thin wrapper over bin/kickoff/kickoff.ts, which loops — claim a Ready issue (one that isn't marked needs-definition, moving it to In-Progress first), create a Superset workspace worktree on a branch carrying the Linear id, write the spec inside it, launch a user-visible Claude session running /build in a Superset terminal (which launches bin/build.ts and supervises it) — until at capacity, then exits without waiting on the builds. Use to kick off groomed tickets (cron-friendly).
user-invocable: true
---

# /kickoff

You kick off groomed Linear tickets (maintenance or
otherwise) into the build pipeline, filling available capacity in one pass. The
real work is a headless-runnable script — your job is to run it and report what
it did.

## Gate

Confirm `build/kickoff/config.json` is pinned (see
`build/kickoff/README.md` → Setup) and the Linear MCP is authenticated. The
script hard-stops on unset config.

## Run

```bash
bun run bin/kickoff/kickoff.ts
```

It loops until capacity is full (all deterministic; the only agent step is
select+claim), hard-capped at `maxConcurrentBuilds` launches per run:

1. **Select + claim** — spawns one agent per iteration to pick exactly one issue
   in **Ready** that does **not** carry `needs-definition`, never one already
   In-Progress/terminal, and **immediately moves it to In-Progress** (claims it
   before building, so a re-run/crash can't double-launch). Reports
   at-capacity when In-Progress count reaches `maxConcurrentBuilds`, which ends
   the loop.
2. **Worktree first** — provisions a worktree on branch
   `kickoff/<dis-id>-<slug>` off `main`, via the provider configured at
   `worktree.provider` (`git` = `git worktree add ../.kickoff-worktrees/<slug>`;
   `superset` = `superset workspaces create`, landing at
   `~/.superset/worktrees/<projectId>/<branch>`, opened in the app — see
   `bin/kickoff/worktree-provider.ts`). The Linear id in the branch is the
   loop-closer: the eventual PR auto-links the issue and merging auto-resolves it.
3. **Design inside the worktree** — writes `build/<slug>/spec.md` into that
   worktree from the issue's brief.
4. **Launch detached** — starts a user-visible `claude "/build <slug>"`
   supervisor session (cwd = the worktree) in a visible Superset terminal that
   outlives the kickoff run, then loops to claim the next issue. The `/build`
   skill launches `bin/build.ts` in the background and stays attached, so when
   a build parks on a blocker (`NEEDS-INPUT.md`, user-input requests) the
   session escalates it to the user in the terminal. Builds shepherd
   themselves to a PR — the kickoff run never waits on them. If no detached
   runtime is available (git provider, superset degraded, `claude` CLI not
   runnable) `bin/build.ts` runs synchronously instead and ends the run — one
   build per run in that mode.

   Caveat: each worktree is a path `claude` hasn't seen before, so the session
   may open on the folder-trust dialog and wait for a click in the terminal
   before `/build` runs. If launched builds sit idle at launch, check the
   terminal for that prompt.

## Exit codes

- `0` — launched everything it could (zero or more detached builds) / nothing
  ready / at capacity / a synchronous fallback build succeeded.
- `2` — a *synchronous* fallback build ran and blocked/failed (the `/build`
  pipeline's `NEEDS-INPUT.md` explains why).
- `1` — **failed launch**: an issue was claimed but its build never started
  (already-launched builds keep running). The issue is stuck In-Progress; bounce
  it back to Triage by hand and investigate the logged reason.
- `3` — **select agent failure**: the select+claim agent itself crashed — nothing
  new was claimed (verify in Linear); already-launched builds keep running.

## After a kickoff

- The build pipeline owns progress, and the per-build `/build` supervisor
  session owns escalation (`NEEDS-INPUT.md`); this skill does not poll either.
  Watch builds — and answer escalations — live in the Superset app.
- When the PR merges, Linear auto-resolves the issue; the **next** ingester run's
  reconcile step records the `done` outcome in the ledger.
- Prune the worktree after merge: `git worktree remove
  ../.kickoff-worktrees/<slug>` (provider `git`) or `superset workspaces
  delete <workspace-id>` (provider `superset`; the id is logged at launch time).

## Concurrency

`maxConcurrentBuilds` (config, default 1) caps in-flight builds. Each run tops
capacity back up, so the intended cadence is periodic (e.g. cron) — claims are
strictly sequential within a run, which is what keeps double-launch
impossible. A pid lockfile (`build/kickoff/.kickoff/kickoff.pid`) makes
overlapping cron ticks safe: a second kickoff run exits 0 immediately while the
first is alive, and stale locks from crashed runs are stolen automatically.
