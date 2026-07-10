---
name: build
description: Take a spec at build/[feature]/spec.md through plan → build → review → PR autonomously. Pass a Linear ticket ref (e.g. PRO-123) and it syncs the ticket description down into spec.md and builds against that, linking the ticket. If no spec exists yet, writes a short one from your instructions and starts immediately — no /spec required for simple tasks. Infers the feature from the current branch's changes or your instructions. Launches bin/build.ts as a session-owned background process (not detached) and reports status from state.json / build.log / NEEDS-INPUT.md.
argument-hint: "[feature-name | linear-ticket-ref] (optional)"
user-invocable: true
allowed-tools: Bash, Read, Write, Glob, mcp__linear__get_issue
---

# /build

Drive a design to a mergeable PR autonomously. The heavy lifting is a long-running
process (`bash bin/build/run.sh <feature>`, a survivor wrapper around `bin/build.ts`) that runs the whole build in the
foreground (it blocks until the build reaches a terminal state, then exits). Launch it
with the Bash tool's background mode so it is **owned by this Claude Code session** — it
appears in the session's background processes, and when it exits the session is
re-invoked. That exit is the supervision/escalation hook.

Do **not** detach the process (no `nohup`, `disown`, or `setsid`). The session must own
it so you can see it in the background-process list and be notified the moment it exits.
A detached build runs blind: the session can no longer observe it or react to its exit,
and you'd have to poll `state.json` by hand. If a session ends with a build still
running, the build stops with it — relaunch with `/build $FEATURE`, which resumes from
`state.json`.

This skill **resolves a feature, ensures a design exists, then launches and reports**.
All control flow (phase loops, harness routing, gates, escalation) lives in the
committed TypeScript orchestrator. See `build/build-flow/design.html` for the full design.

`/build` pairs with `/spec`: `/spec` is for designing a feature through conversation,
captured as a Linear ticket. `/build` is for getting code shipped — hand it that
ticket ref and it builds against the ticket; hand it nothing and it builds against a
local `spec.md` (an existing one, or a short one it writes from your instructions).

## Step 0 — Resolve the feature

Pick `FEATURE` (kebab-case), in priority order:

1. **Argument is a Linear ticket ref** (checked first) — an issue identifier like
   `PRO-123` (team key, dash, number) or a Linear issue URL → this is **ticket mode**.
   Fetch the issue with `mcp__linear__get_issue`, derive `FEATURE` as a **one-to-three-word**
   kebab-case slug of its title (e.g. "Add a snooze button to todos" → `todo-snooze`), and
   remember the issue identifier. State the slug you chose in one line so the user can correct it.
   The ticket's description becomes the spec — see Step 1.
2. **Argument given** (and not a ticket ref) → use it verbatim.
3. **Your message describes what to build** (an instruction like "add a snooze button
   to todos") → derive a **one-to-three-word**, descriptive kebab-case name from it
   (e.g. `todo-snooze`). State the name you chose in one line so the user can correct it.
4. **Bare `/build` with no instruction** (checking in / resuming) → infer from existing
   work:
   - Enumerate candidate dirs that hold a spec: `ls -d build/*/` and keep the ones
     containing a `spec.md` (or, for in-flight worktrees, a legacy `design.md`).
   - If exactly one has a `spec.md`/`design.md`, that's the feature.
   - If several do, narrow by the current branch name and changed paths
     (`git diff --name-only main...HEAD`, plus `git status --short`). Branch-name
     correspondence is the primary signal; treat weak path matches as inconclusive.
   - If you still can't confidently single one out, **stop and ask** which feature to
     build (list the candidates). Do not guess.

Let `DIR=build/$FEATURE`.

## Step 1 — Ensure a spec exists

- **Ticket mode (Step 0 resolved a Linear ticket ref)** — the ticket *is* the spec.
  **Sync it down** to `$DIR/spec.md` at the start of every launch:
  1. Take the issue description you fetched in Step 0 and write it **verbatim** to
     `$DIR/spec.md` (create `$DIR` if needed), overwriting any existing file. Write the
     description body exactly as-is — no added H1, header, or marker — so it matches the
     ticket as closely as possible (the build pipeline's ticket sync compares the two
     verbatim; an exact copy keeps that a no-op, and any residual diff is a harmless
     one-time, file-wins rewrite). If the description is empty, stop and tell the user
     the ticket has no description to build from.
  2. The launch in Step 3 passes the issue id so the build **links this existing
     ticket** rather than minting a new one.

  Having synced the spec down, **fall through to the checks below** — a present
  `$DIR/NEEDS-INPUT.md` still halts the relaunch even in ticket mode. The sync runs
  every launch, so a description edited in Linear between runs flows back into `spec.md`
  on the next `/build`. (The reverse direction — a local `spec.md` edit syncing *up* to
  the ticket — is what the build pipeline's own ensure-ticket step does; here we're
  seeding the file *from* the ticket, then letting that step keep them equal.)
- **If `$DIR/NEEDS-INPUT.md` exists**, the previous run is **blocked on a human
  decision**. Read it, surface the blocker and the requested decision to the user, and
  stop — do not relaunch until it's resolved and the file deleted. The user may resolve
  it themselves, or hand you their decision in conversation — in that case apply it,
  delete the file, and relaunch, per the supervision flow in Step 3. (See Step 4.)
- **If `$DIR/spec.md` (or a legacy `$DIR/design.md`) exists**, use it as the target (a
  human-approved `/spec` output, or one a prior `/build` wrote). Proceed to Step 2.
- **If neither `$DIR/spec.md` nor `$DIR/design.md` exists**, write a **short** spec from
  the user's instructions and proceed immediately — this is the no-`/spec`-needed path:
  1. Capture the user's intent faithfully and concisely. Size the doc to the task: a
     couple of sentences plus a short bullet list for something simple; only expand if
     the instruction itself carries real detail. Don't open a `/spec`-style
     conversation and don't pad with sections that add nothing.
  2. A minimal skeleton (drop any heading you have nothing to say under):

     ```md
     # [feature]

     ## Overview

     <one or two sentences: what to build and why, from the user's instruction>

     ## Notes

     - <any specific behavior, constraint, or file the user named>
     ```
  3. Write it to `$DIR/spec.md`, then continue to Step 2.

  If the request is genuinely large or ambiguous, you may suggest the user run
  `/spec $FEATURE` first for a fuller spec — but the default is to write the short
  spec and build.

## Step 2 — Report existing status (if any)

If `$DIR/state.json` already exists, read it and report the current `phase`, `status`,
and `reviewRound`, plus the last ~20 lines of `$DIR/build.log`. This tells the user
where a prior run got to before you (re)launch.

## Step 3 — Launch in the background

Launch the orchestrator as a **session-owned** background process — owned by this
session, not detached from it:

```bash
bash bin/build/run.sh "$FEATURE"
```

The wrapper records the bun process's exit code (and a derived signal label) to
`build.log` so an uncatchable kill (SIGKILL/segfault/external signal) is still
attributable after the fact. The wrapper traps TERM/INT/HUP, so it survives a
group-wide signal sweep and additionally records when it was signalled itself
(proof the kill hit the whole process tree, not just bun).

**Crash forensics live in `$DIR/crashes.jsonl`** (git-tracked, one JSON record
per incident). The orchestrator records its launch ancestry (who spawned it) at
startup; on a trappable signal it appends a `kind: "signal"` record — signal,
phase, parent pid at signal time vs launch (reparenting = the parent died
first), whether the parent was still alive, and the full launch ancestry + the
session-identifying env. On relaunch after an abnormal death it appends a
`kind: "autopsy"` record (last phase, last-alive heartbeat, wrapper exit code,
prior launch context). When the user asks why builds are being killed, read
`crashes.jsonl` across build dirs and correlate timestamps + ancestry.

**In ticket mode**, pass the issue id so the build links the existing ticket instead of
creating a new one (only on a first launch — on resume the recorded state already
carries the link):

```bash
BUILD_LINEAR_ISSUE_ID="PRO-123" bash bin/build/run.sh "$FEATURE"
```

Run it with the Bash tool's background mode (`run_in_background: true`) — and nothing
else: no `nohup`, no `disown`, no trailing `&`. Background mode is what keeps the
process owned by the session (visible in its background-process list, and re-invoking
the session on exit). Capture the launch, then immediately report: "build started for
`$FEATURE` — it runs headless to a mergeable PR. Check back any time with `/build
$FEATURE`."

Do **not** block waiting for it to finish. The orchestrator writes progress to
`$DIR/state.json` and `$DIR/build.log`; status is read from disk, not from the
launching process.

**Supervise to the end of the session.** Because the launch used background
mode, you are re-invoked when the process exits — that is your escalation
hook (this is how dispatched maintenance builds surface blockers to the user).
When the notification arrives, report per Step 4: on exit code 2 (or whenever
`$DIR/NEEDS-INPUT.md` exists), surface the blocker and the decision needed
prominently and wait for the user; if they resolve it in conversation, apply
their decision, delete `NEEDS-INPUT.md`, and relaunch the same way. On exit 0,
report the PR as done.

## Step 4 — Reporting status on a later invocation

When the user re-runs `/build $FEATURE` to check in:

1. Read `$DIR/state.json` → report `phase`, `status`, `reviewRound`.
2. Read the tail of `$DIR/build.log` → summarize what the latest phase did.
3. If `$DIR/NEEDS-INPUT.md` exists, the run **halted on a blocker**. Surface its
   contents prominently: the blocked phase, the reason, and what decision is needed.

   To resume: the user resolves the blocker (edits the relevant artifact in `$DIR/`,
   or writes their decision into `NEEDS-INPUT.md`), **deletes `NEEDS-INPUT.md`**, then
   re-runs `/build $FEATURE`. The orchestrator resumes from `state.json` — there is no
   separate resume path; resuming *is* re-running.
4. If `$DIR/observations.md` exists, mention how many out-of-scope notes the build
   agents jotted down (one `##` entry each) — a separate skill mines these into a
   backlog later. Don't act on them here.
5. If `status` is `done`, congratulate: the PR is mergeable and clean.

## Notes

- **Resumable state machine.** Every phase is a pure function of what's in `$DIR/` plus
  the repo. The pipeline is inspectable and resumable; the intermediate artifacts
  (`plan.md`, `plan-review.md`, `implementation.md`, `review/round-N.md`) are all files
  in the build dir.
- **e2e testing artifacts.** The e2e step of the validate gate is a plan → plan-feedback
  → execute sub-pipeline. It commits two human-readable testing artifacts to the PR:
  `e2e-plan.md` (the flows to exercise, with any locally-untestable flows flagged) and
  `e2e-report.md` (how the feature was actually tested — flows, steps, outcomes, and which
  flows were skipped as untestable and why). When e2e finds that a flow can't be tested
  locally because the harness is missing something, it records that as a distinct
  `e2e-infra` observation kind in `observations.md` so `harvest-observations` can route it
  toward making more of the product e2e-testable.
- **evals testing artifacts.** The `evals` step of the validate gate is a plan →
  plan-feedback → execute sub-pipeline (mirroring e2e) that runs when the change touches
  **model-facing prompt text** (a connector system prompt, the assembled agent system prompt,
  a default/seeded automation prompt, the permission-agent prompt, or a judge/scorer rubric).
  It commits `eval-plan.md`, `eval-required-cases.json` (the machine-readable coverage
  contract), `eval-run.json` (Evalite's `--outputPath` JSON), and `eval-report.md` (which
  cases ran, per-case main-vs-produced-vs-refreshed scores, the regression verdict). It
  ensures eval coverage exists for the changed prompts (authoring `.eval.ts` cases under
  `apps/web/evals/cases/…` when missing — a prompt change with no case FAILS the step), runs
  only the **relevant subset** (never the full suite), and gates the produced scores against
  `apps/web/evals/baselines.json` with a noise-tolerant margin. Regressions are measured
  against **main's committed baseline** (read via `git show origin/<base>`), so refreshing the
  working-tree baseline can't mask a regression; the step refreshes + commits the baseline
  when scores legitimately move. Drift is observable via `bun run eval:baseline-drift` (a
  signal, not a blocker). Infra: it needs a running Convex dev deployment + both
  `AI_GATEWAY_API_KEY` and `ANTHROPIC_API_KEY`; needed-but-unavailable blocks for a human
  (never a silent skip). Harness gaps are recorded as the distinct `eval-infra` observation
  kind for `harvest-observations`.
- **Artifacts land in the PR automatically.** As the final action of a successful run,
  the orchestrator commits the whole `$DIR/` (including `build.log` and `state.json`) and
  pushes it to the PR branch — so a finished build leaves no uncommitted changes and the
  PR carries its own audit trail. The only exception is `$DIR/.build/` (transient runtime
  scratch: scoped MCP config, reviewer message buffer), which is gitignored. Because the
  commit must be the last write to the build dir, a push failure is reported on stderr
  rather than logged into `build.log`.
- **Out-of-scope observations.** The build and code-review phases append latent bugs,
  refactors, and tech debt they notice (but that don't belong in this feature) to
  `$DIR/observations.md` — an append-only backlog that never blocks the run. A separate
  skill mines it later; this skill only reports the count.
- **Linear ticket status tracks the build.** The launch-time ensure-ticket step
  forward-only advances the ticket to In-Progress, and entering the `monitor` phase
  forward-only advances it to In Review (along `triage/ready < In-Progress < In Review <
  Done/canceled`; never backward). Both are best-effort — a failure logs a `build.log`
  warning and the build proceeds (never escalates, never writes `NEEDS-INPUT.md`). The
  In-Review move requires `inReviewStateId` pinned in `build/kickoff/config.json`;
  unpinned → the move is skipped.
- **One worktree per run.** build operates on the current branch/worktree. Kickoff
  provisions each run a dedicated worktree via `gwt add <branch>`, which runs full
  project setup (`worktree-init.sh`: `.env` symlinks, `bun install`, Convex/Vercel
  config) — so a build always starts in a fully-provisioned checkout.
- **Harness routing** is configurable in `state.json` → `harnessMap` (default:
  claude/opus plans & builds, codex reviews).
- The orchestrator exits non-zero (code 2) when parked on a blocker, so a supervising
  process can notice; this skill detects the blocker via `NEEDS-INPUT.md`.
