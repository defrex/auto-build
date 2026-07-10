---
name: triage-sentry
description: Mine production Sentry errors into clustered Linear maintenance issues, deduped on LIVE Sentry + Linear state (breadcrumb notes + ticket state), not a ledger. Filters by frequency/users/recency/deploy-staleness, root-causes survivors via /investigate, clusters by cause, files Triage issues, drops a breadcrumb on each Sentry issue, and leaves resolution to shipped `fixes <SHORT-ID>` commits so regressions re-enter naturally. Heavy filtering, then synthesis. Ingesters propose, never dispatch. Use when triaging the Sentry backlog into maintenance work.
user-invocable: true
---

# /triage-sentry

You are the **Sentry triage** ingester — *triage + root-cause*. Errors are
low-signal, high-volume: decide what is real, still happening, and impactful
**before** anything becomes a task. **Heavy filtering, then synthesis.** You
**propose** Triage issues; never dispatch.

**Dedup is on live Sentry + Linear state, not the ledger.** Unlike
`harvest-observations`, the Sentry path no longer reads or writes
`ledger.jsonl` / `record-outcomes.ts` / `scan-observations.ts`. Instead:

- Triage files a Linear ticket, then writes a **breadcrumb note** on the Sentry
  issue carrying the ticket id/uuid/URL. Sentry status is left **unresolved** —
  the bug is still happening; only a shipped fix resolves it.
- The dedup test each run is: *does this issue carry a breadcrumb pointing at a
  Linear ticket that is still in a non-terminal state?* Existence of a breadcrumb
  is **never** the test — the linked ticket's **state** is.
- Resolution rides shipped code: the fix PR carries `fixes <SHORT-ID>` so
  Sentry auto-resolves on release. If the issue regresses, Sentry reopens it and
  it re-enters the actionable query as a fresh regression ticket.

The judgment that must stay deterministic lives in **code**, not your prose:

- Threshold predicate — `passesSentryThreshold` in `bin/kickoff/sentry-filter.ts`.
- Priority ordering before the cap — `prioritizeSentryCandidates` in
  `bin/kickoff/sentry-filter.ts` (worst-first: Tier A regressed/escalating, then
  `events` desc, then `users` desc). **Never re-derive the order by eye.**
- Breadcrumb parse + Linear-state resolution + dedup verdict —
  `bin/kickoff/sentry-dedup-batch.ts` (the CLI you run in step 3). It reuses the
  pure functions in `bin/kickoff/sentry-dedup.ts` (`selectLatestSentryBreadcrumb`,
  `classifyTicketState`, `decideSentryTriage`) and batches the Linear ticket-state
  read into ONE GraphQL request for the whole candidate set (via the headless
  `linear-client.ts` seam). **Never** eyeball note text to decide which ticket an
  issue links to, and **never** read a ticket's state via Linear MCP or classify
  it by hand — assemble the candidates and run the script.
- Adversarial review (per candidate ticket) — `bin/kickoff/adversarial-review.ts`
  (isolates a throwaway worktree, spawns the skeptical `codex exec` reviewer,
  parses the structured verdict, classifies new-vs-repeat holes, recommends the
  stop action). **Never hand-judge "is this brief sufficient" — run the script
  per round and read its `action`.**

You own the MCP reads, the `/investigate` root-cause, clustering, brief
authoring, and rendering/reading-back the breadcrumb template.

## Setup gate

Read `build/kickoff/config.json`; if Linear IDs are unset, STOP and point at
`build/kickoff/README.md` → Setup. (The config already carries `doneStateId`,
`rejectedStateIds`, `triageStateId`, `sourceSentryLabelId`,
`needsDefinitionLabelId` — no new IDs are needed.)

`LINEAR_API_KEY` must be set in `.env` (already required for `/kickoff`, so no new
setup burden) — the step-3 dedup script reads Linear ticket state through it. A
missing key isn't silent: the script throws with the `linear-client.ts` message
(pointing at Linear → Settings → Security & access → Personal API keys).

## Bootstrap (one-time — run BEFORE the first live-state run)

> **Run-order gate (hard).** Normal triage must **not** run until bootstrap is
> confirmed complete, or the first run re-files duplicates for in-flight
> tickets. **Completion signal:** *every* open `source:sentry` Linear ticket has
> a breadcrumb on its Sentry issue (zero open `source:sentry` tickets lacking
> one). Verify this signal before the first live-state run.

The new dedup trusts breadcrumbs, but existing open `source:sentry` tickets have
none. Reconcile two **distinct populations** (operator-run, no committed code):

**Population A — open/non-terminal `source:sentry` tickets (work in flight).**
List them via Linear MCP (`sourceSentryLabelId`, non-terminal states per
`classifyTicketState`). For each, find its Sentry issue (short-id from the ticket
body / old ledger ref) and **add the breadcrumb note** in the canonical shape
below so the new dedup recognizes it as in-flight. **Leave the Sentry issue
`unresolved`** — the bug is still open and the work isn't shipped; resolving it
now would wrongly fire a regression on the next event. After this, the dedup's
`skip` (non-terminal) verdict suppresses these correctly.

**Population B — terminal prior tickets whose Sentry issue is still
`unresolved`.** These were closed under the old ledger model without a shipped
`fixes <SHORT-ID>`, so Sentry never resolved them. **Do not breadcrumb these** (a
terminal-ticket breadcrumb + actionable issue would file an immediate spurious
"regression"). Instead reconcile Sentry to own resolution: set the issue
`resolvedInNextRelease` (or `resolved` if it's genuinely fixed) so a *future*
recurrence is a true Sentry regression that re-enters cleanly. If a Population-B
bug is in fact still live, it will regress and be re-filed as a fresh ticket —
the intended steady-state behavior, not a bootstrap special case.

> **Conflict resolution.** Where "resolve previously-triaged issues" collides
> with "resolution is tied to shipped code" (an in-flight bug), **the
> shipped-code rule wins**: only resolve Sentry issues whose Linear ticket is
> **terminal**. In-flight tickets get a breadcrumb, never a resolve.

## Ticket authoring shape

The tickets you file are **`/spec`-style requirement docs, not investigation
reports** — say *what must be true when the work is done*, not what the diff
looks like. Mirror `/spec`: describe the requirement not the edits, right-size to
the task, bias short, and keep genuine open questions visible so
`needs-definition` reads true. This contract governs how you render a ticket in
Steps 6.5 and 7; it does **not** touch any machinery.

**1. Declare the disposition up front.** Open every ticket by naming one of
these, and shape the body to it:

- **fix** — a validated problem whose cause is specific enough to state the
  corrective behavior.
- **telemetry** — the cause is not yet provable from current telemetry; the
  deliverable is the instrumentation to diagnose it **plus the hypothesis that
  instrumentation will test.** This is a **first-class, encouraged** outcome, not
  a lesser one — don't force a fix you can't yet justify.
- **de-noise** — a benign / handled / recovered beat that is just Sentry noise;
  the deliverable is to stop capturing it loudly (stable fingerprint / downgrade
  / route to Logs) **while preserving diagnostics.**

Dispositions may combine as **ordered** steps — telemetry-then-de-noise is
common (PRO-638, PRO-738): capture the signal first, then quiet it. When they
combine, **state the order.**

**2. Tight, right-sized requirement body.** Describe behavior and outcomes, not
edits. The body parts (include only those that carry a requirement):

- **Problem (validated)** — a short paragraph: what's happening, the evidence
  it's real / still happening / impactful, and the root cause in plain terms.
  File/function **names are allowed** for orientation; **no line numbers, no
  edit-by-edit checklists** (they go stale by build time).
- **Requirements / desired behavior** — the behavior the fix must exhibit and the
  constraints it must hold (e.g. "content-filter/error still warn," "no change to
  the user-visible closing status," "a lost-response retry produces no
  duplicate"). **This is the heart of the ticket.**
- **Acceptance** — how you'd know it's done, in observable terms.
- Capture a genuine product/architectural **decision** (with its rationale) only
  where a real fork exists; leave routine mechanics — which files, what to name a
  helper — to `/build`.

**Right-size and bias short.** A de-noise may be **3–5 bullets end to end**; a
durability fix warrants the fuller Problem/Requirements/Acceptance shape. Don't
force sections that carry no requirement.

**3. Relocate the audit material out of the read-path.** The investigation
evidence (Sentry event IDs, Convex session refs, volume / why-now) **and** the
full adversarial-review trail (per-round holes, resolutions, reviewer
accept/reject verdicts, final verdict + confidence) go into **one collapsed block
at the bottom of the description**:

````md
<details><summary>Investigation & review trail</summary>

…evidence + adversarial rounds…

</details>
````

This block stays in the **description** — so `/build`'s `spec.md` sync preserves
every bit of the evidence and trail — but out of the body a reader scans. The
relocation is **presentational only; nothing is deleted.** Exactly two things
stay in the body proper:

- the one-line review **verdict** where it bears on the disposition; and
- when the review left **blocking high-severity holes**, those holes themselves,
  framed as **open questions** — they are the reason the ticket carries
  `needs-definition` and must stay visible, mirroring `/spec`.

**4. Title discipline.** The title states the problem and its disposition in one
clear clause. Push sibling-ID enumerations and scope sprawl ("PRODUCT-WEB-117 +
12 siblings") into the body / collapsed block, **not** the title.

> **`needs-definition` still keys off `result.action`, never body shape.** The
> label is decided in code (`decideReviewAction`), and no code parses the ticket
> body — relocating the trail into `<details>` cannot change which tickets get
> labeled. Do **not** re-couple labeling to where the trail is rendered.

## Steps

1. **Setup gate** — above.

2. **Pull actionable issues.** Query the Sentry MCP for the actionable set
   (`mcp__sentry__find_organizations` → `find_projects` → `search_issues`, per
   `/investigate` Path B). The spec requires the **union** of `is:unresolved`,
   `is:regressed`, `is:escalating` — do **not** assume `is:unresolved` subsumes
   the other two. Issue **three** `search_issues` calls (one per status token) by
   default; collapse to a single union query only after verifying it returns the
   same set. **De-dupe by `shortId` into one candidate set BEFORE thresholding**
   so each `shortId` is investigated/filed at most once. **Capture per-issue
   membership in the `is:regressed` / `is:escalating` result sets** — that
   membership frames the regression brief (step 7), is independent
   corroboration of the breadcrumb-based regression signal (step 3), and feeds
   the priority ordering in step 4: map each survivor to
   `isRegressedOrEscalating = (member of the regressed OR escalating result
   set)` so `prioritizeSentryCandidates` can lift Tier A above Tier B.

   Normalize each to `{ shortId, events, users, lastSeen, status, environment }`
   and keep only threshold survivors via `passesSentryThreshold` (don't
   re-derive its rules).

   **`latestDeployAt` sourcing (DO NOT use "today").** `passesSentryThreshold`
   reads `ctx.latestDeployAt` as *the latest production deploy timestamp*. Source
   it as: try Sentry release/deploy data for `product-web`; else the latest
   production deploy from Vercel or the latest `main` deploy tag; else pass
   `null` (the predicate falls back to its tighter
   `staleAfterDeployFallbackDays` window and flags the skipped check). Setting it
   to "today" is **wrong** — it would reject any issue whose `lastSeen` predates
   the current day even when seen after the real latest deploy.

3. **Per-candidate dedup on LIVE state (batched).** Gather the facts via Sentry
   MCP, then run the dedup script ONCE for the whole candidate set — it selects
   the breadcrumb, resolves every linked ticket's state in one batched Linear
   request, classifies terminality, and returns the verdict per candidate. Do
   **not** read ticket state via Linear MCP or classify by hand.

   a. For each survivor, read the Sentry issue's notes/activity
      (`get_issue_activity` / notes via `mcp__sentry__execute_sentry_tool`),
      collecting each note as `{ body, createdAt }` (Sentry side unchanged).
   b. Assemble
      `{ candidates: [{ shortId, notes, inActionableQuery: true }, …] }` (one
      entry per survivor) and write it to
      `build/kickoff/.kickoff/sentry-dedup-input.json` (gitignored scratch, the
      same dir the adversarial-review input uses).
   c. Run `bun run bin/kickoff/sentry-dedup-batch.ts --input <path>` and read the
      JSON `results` off stdout (diagnostics go to stderr).
   d. Branch on each `result.verdict`:
      - `skip` → drop it (in flight, or defensively gated).
      - `file-new` → candidate for investigation.
      - `file-regression` → candidate, flagged as a regression. Carry
        `result.breadcrumb` (the prior ticket's id/uuid/url) and
        `result.terminality` (`done` vs `rejected`) into the step-7 framing, plus
        the fixed-then-broke release from Sentry's regression data.
   e. A `result.lookupError` entry marks a per-ticket resolution failure (deleted
      or inaccessible ticket → defensive `skip`). Surface it in the run notes —
      never swallow it. A transport-level failure (missing `LINEAR_API_KEY`,
      non-2xx, GraphQL errors) makes the script exit non-zero with no stdout JSON:
      fix the cause and re-run, don't proceed on a partial dedup.

4. **Order, then cap investigations.** The lower `minEvents` floor routinely
   produces more survivors than the cap, so take them in a deterministic
   worst-first order rather than an unordered pool. Map each deduped survivor to
   `{ shortId, events, users, isRegressedOrEscalating }` (membership captured in
   step 2), call **`prioritizeSentryCandidates(survivors)`** (pure, in
   `bin/kickoff/sentry-filter.ts` — don't re-derive the order by eye; it returns
   your candidate objects reordered), then take the first
   `caps.maxInvestigationsPerRun`. The order is: Tier A (`regressed` OR
   `escalating`, flat — no ranking between them) before Tier B, then `events`
   descending, then `users` descending (boost-only). Investigation is the
   expensive step; overflow past the cap is **deferred to the next run, not
   dropped**.

5. **Root-cause.** Run `/investigate` Path B on each survivor to get
   trigger / mechanism / scope / why-now. Reuse `/investigate` (it stops before
   fixing); don't re-derive it.

6. **Cluster by root cause.** Group errors sharing a cause into one issue. Heavy
   filtering already happened, so clustering is lighter than for observations.

6.5. **Adversarial review (per candidate ticket).** For each cluster (candidate
   ticket), before filing, run the review loop. The loop runs only on
   post-cluster candidates, so it's bounded by `caps.maxInvestigationsPerRun`
   and never wasted on issues dedup/caps will drop.

   The loop is **severity-aware**: only unresolved **high**-severity holes block
   a clean filing. A converged review whose only residual holes are low/medium
   files **clean, with those holes recorded as caveats** — clean-with-caveats is
   a normal filing, not `needs-definition`. `needs-definition` is reserved for
   genuine unresolved **high**-severity disagreement (or reviewer
   unavailability). The stop/continue decision is made in code
   (`bin/kickoff/adversarial-review.ts` → `decideReviewAction`); read
   `result.action` and branch — do not re-derive the decision by eye.

   a. **Propose.** Draft the ticket per the **Ticket authoring shape** contract
      above — pick the disposition (fix / telemetry / de-noise, ordered if
      combined) and write the tight body (Problem / Requirements / Acceptance)
      from the `/investigate` output (trigger / mechanism / scope / why-now).
      This draft is what the reviewer critiques. Separately, gather the live
      Sentry/Convex evidence you (and only you) can reach — events, breadcrumbs,
      logs, prod data — into an `evidence` block; **the `evidence` the reviewer
      consumes is unchanged by the new ticket shape.** Initialize
      `priorRounds = []`, `round = 1`, and read the cap from
      `caps.adversarialReviewRounds` (default 3).
   b. **Review.** Write `{ shortId, round, cap, brief, evidence, priorRounds }`
      to a scratch JSON under the gitignored `build/kickoff/.kickoff/` dir (e.g.
      `build/kickoff/.kickoff/adv-review-input.json`) and run:
      `bun run bin/kickoff/adversarial-review.ts --input <path>`.
      Read the JSON result. **Codex reviews repo code; you supply the evidence
      Codex can't reach.** If `result.wroteFiles` is non-empty, note it in the
      trail (Codex shouldn't write — isolation already discarded it).
   c. **Resolve, then record the round.** For each hole in `result.holes`: fetch
      the named Sentry/Convex evidence or revise the hypothesis/fix per the
      hole's `resolution`. Capture each as `{ hole, response, status }` — where
      `hole` is the **full Hole object** (never an id string; the validated
      input contract rejects a bare id and the process exits non-zero),
      `status:"resolved"` with the evidence/change you applied, or
      `status:"open"` if you couldn't close it. Append
      `{ round, holes: result.holes, resolutions }` to `priorRounds`. **Do this
      before re-running** so the next Codex round sees how each hole was answered.
      From round 2 on, read `result.resolutions` (the reviewer's machine-readable
      accept/reject verdict per prior hole) to know which prior holes the
      reviewer considers closed — do **not** infer closure from re-raised id
      strings.
   d. **Branch on `result.action`:**
      - **Hard input failure** (the script exits non-zero with no `ReviewResult`
        JSON on stdout) → a malformed-input bug in the caller, **not** a review
        outcome. Fix the JSON input (most likely
        `priorRounds[].resolutions[].hole` was written as an id string instead of
        a full Hole object) and **re-run the same round**. This is distinct from
        `stop-unavailable`, which is a parsed result.
      - `stop-sufficient` → review converged clean. File normally (no
        `needs-definition`).
      - `stop-clean` → converged with only low/medium residual holes. File
        **clean, no `needs-definition`**, and record the residual holes
        (`result.caveatHoles`) as **caveats in the `<details>` review trail** (per
        the authoring contract) — not in an in-body section.
      - `continue` → regenerate the `evidence`/`brief` to reflect the
        resolutions from (c), `round += 1`, and go to (b) (passing the updated
        `priorRounds`).
      - `stop-no-new-holes` / `stop-cap` → genuine unresolved **high**-severity
        disagreement: file **with the blocking holes (`result.blockingHoles`)
        kept visible in the body as open questions** (per the authoring contract)
        while the full trail goes to `<details>`, and add the
        `needsDefinitionLabelId` label so `/kickoff` skips it until a human weighs
        in.
      - `stop-unavailable` → **fail-soft**: do NOT drop the bug and do NOT file
        an un-reviewed ticket silently. File with `needsDefinitionLabelId`, and
        record "adversarial review unavailable — `<result.reason>`" in the
        `<details>` review trail.
        This also fires when a round-≥2 reviewer fails to judge every prior hole
        (`reason` like "round 2 reviewer did not judge prior holes: …") — a real
        signal that machine convergence didn't happen and a human should weigh in.
   e. **Carry the trail into Step 7.**

7. **File + breadcrumb (replaces record-outcomes — no ledger write).** For each
   cluster, create a Triage issue (`triageStateId`, `sourceSentryLabelId`) whose
   body is **rendered per the Ticket authoring shape contract above** — the
   disposition line and tight Problem / Requirements / Acceptance body up top, the
   full review trail relocated into the bottom `<details>` block — **plus** a
   hidden `<!-- sentry-fixes: <SHORT-ID> -->` marker for each of the cluster's
   Sentry short-ids. This marker propagates triage → Linear ticket → `spec.md` →
   the build's PR, where `/build` emits the `fixes <SHORT-ID>` line so Sentry
   auto-resolves on release. (The worked examples below show the marker in place —
   don't drop it when adopting the new shape.)

   The full adversarial-review trail — rounds taken; per round the holes Codex
   raised and how each was resolved (`response` / `status`); from round ≥ 2 the
   reviewer's **accept/reject verdict per prior hole** (`result.resolutions`); the
   **blocking-vs-caveat split** (`result.blockingHoles` marked blocking/high,
   `result.caveatHoles` as known caveats for the builder); and the final verdict +
   confidence (`result.summary` / `result.confidence`) — goes into the `<details>`
   **Investigation & review trail** block, **not** an in-body `## Adversarial
   review` section. Two things surface in the body proper: the one-line verdict
   where it bears on the disposition, and (only when the review left blocking
   high-severity holes) those holes as open questions.

   Add the `needsDefinitionLabelId` label **only** when `result.action` was
   `stop-no-new-holes` / `stop-cap` / `stop-unavailable` — **never** for
   `stop-clean` or `stop-sufficient`. This decision keys off `result.action`
   (`decideReviewAction`), **not** where the trail is rendered; relocating it to
   `<details>` leaves the label behavior identical.

   For a **regression** ticket: mark it a regression (in the Problem paragraph,
   with the full detail in `<details>`), reference the prior (closed) Linear
   ticket, and include the fixed-then-broke release. Frame per the prior ticket's
   terminality — `done` = a **true regression** (fixed-then-broke); `rejected` = a
   **re-surfaced won't-fix**.

   Then **immediately write the breadcrumb note** on each member Sentry issue
   (`add_issue_note` via `execute_sentry_tool`), rendering the **exact canonical
   template** with the new ticket's id, uuid, and URL. **Leave Sentry status
   unresolved.**

   **Canonical breadcrumb body** (human line + stable hidden marker):

   ```md
   Dispatch triaged this Sentry issue into Linear: PRO-372 — https://linear.app/dispatch/issue/PRO-372
   <!-- dispatch-sentry-triage: {"linearTicketId":"PRO-372","linearTicketUuid":"<uuid>","url":"https://linear.app/dispatch/issue/PRO-372"} -->
   ```

   **Breadcrumb atomicity (hard stop).** The breadcrumb is the *only* dedup
   record. After writing it, **read the note back and confirm
   `selectLatestSentryBreadcrumb` on the refreshed notes returns the just-written
   breadcrumb** (not merely that some text persisted). If ticket creation
   succeeds but the breadcrumb write fails or can't be read back, the next run
   re-files a duplicate — treat a missing/unverifiable breadcrumb on a
   just-created ticket as a **hard stop** that surfaces the failure (with the
   orphaned ticket id). There is no rollback; the operator reconciles by hand.

## Worked examples

Three canonical ticket bodies (Markdown as filed, no H1 — the ticket already has
a title): a de-noise (the 3–5-bullet floor), a durability **fix** (the fuller
Problem / Requirements / Acceptance shape for a validated cause), and an ordered
telemetry-then-de-noise combo. They show the disposition line, the tight body,
the relocated `<details>` trail, and the hidden `sentry-fixes` marker.

### Example — de-noise (the 3–5-bullet floor)

Title: *Convex platform transient 500s are logged as errors — de-noise*

```md
**Disposition: de-noise.** Convex's shared-action pool occasionally returns
transient 500s that our action wrapper captures to Sentry at error level; they
recover on the built-in retry, so they're handled noise, not a user-facing bug.

- Stop capturing recovered transient Convex 500s to Sentry at error level; a call
  that succeeds on retry must not raise an issue.
- A 500 that exhausts all retries **must still** capture at error level — only the
  recovered ones are quieted.
- Preserve diagnostics: the downgraded beat still lands in Logs with the request
  id and attempt count, so a spike is still visible.

**Acceptance:** replaying a transient-then-recovered 500 produces a Logs entry
and zero Sentry issues; an all-retries-exhausted 500 still opens a Sentry issue.

<!-- sentry-fixes: PRODUCT-WEB-9AB -->

<details><summary>Investigation & review trail</summary>

- Evidence: Sentry `PRODUCT-WEB-9AB`, 412 events / 30 orgs / 24h; every sampled
  event shows `attempt < maxAttempts` and a following success. Convex session
  refs `asess_…`. Volume tracks the shared-pool incident window, not a deploy.
- Adversarial review (2 rounds, verdict: sufficient, confidence high): round 1
  hole — "does the retry always succeed?" → resolved: no, so the exhausted path
  is kept loud (now a Requirement). Round 2: no new holes.

</details>
```

### Example — fix (a validated durability bug)

Title: *A lost-response retry on the send-message mutation posts the message
twice — fix*

```md
**Disposition: fix.** When the send-message mutation's response is lost in
transit the client retries the same request, and a second message is written —
so a transient network blip surfaces as a visible duplicate in the thread. The
cause is specific: the write carries no idempotency key, so the retry is
indistinguishable from a fresh send.

**Problem (validated).** Sentry shows duplicate-message reports across multiple
orgs over the last week; every sampled pair shares one client request inside the
retry window and differs only by write timestamp. The mutation keys each row on a
freshly-generated id, so a retried request writes a second row rather than
reconciling to the first. Root cause: no idempotency key on the send-message
write.

**Requirements / desired behavior.**
1. A retried send that carries the same client-supplied idempotency key **must
   write the message at most once** — the retry returns the already-written row
   instead of inserting a new one.
2. A genuinely new send (distinct key) **must still** write a new message; dedup
   keys off the idempotency key, not message content, so a deliberate identical
   resend is preserved.
3. **Constraints:** no change to the user-visible send latency or the optimistic
   echo in the thread.

**Acceptance:** replaying the same send twice under one key yields a single
message row and one thread entry; two distinct sends still yield two rows.

<!-- sentry-fixes: PRODUCT-WEB-4CD -->

<details><summary>Investigation & review trail</summary>

- Evidence: Sentry `PRODUCT-WEB-4CD`, duplicate-send reports across the fleet in
  the last 7d; sampled pairs share a client request id inside the retry window.
  Convex session refs `asess_…`.
- Adversarial review (2 rounds, verdict: sufficient, confidence high). Round 1
  hole (medium) — "would content-hash dedup drop a legitimate identical resend?"
  → resolved: key on the client idempotency key, not content (Requirement 2).
  Round 2: no new holes.

</details>
```

### Example — telemetry-then-de-noise (fuller fix shape, ordered)

Modeled on PRO-738. Title: *Capture `rawFinishReason` conservatively, then
downgrade benign `other` agent-stream aborts — telemetry then de-noise*

```md
**Disposition: telemetry, then de-noise (ordered).** Agent streams sometimes
close with a provider `finishReason` of `other`, which we currently capture to
Sentry as an error. We can't yet tell benign closes (client navigated away) from
real truncations because we don't record the raw provider reason — so **first
instrument, then quiet** once the benign case is provable.

**Problem (validated).** `other`-reason closes fire ~an error per 50 runs across
the fleet; sampled sessions show most are benign client disconnects, but a
minority coincide with content-filter stops. The agent-stream handler collapses
every non-`stop` reason to a single `other` bucket, so we can't separate them
from telemetry alone. Root cause: we discard the provider's raw finish reason
before it reaches our logs.

**Requirements / desired behavior.**
1. **Telemetry (do first):** record the raw provider finish reason
   (`rawFinishReason`) on every stream close, at a level that lets us bucket
   `other` closes by their true cause without opening a Sentry issue per event.
   Hypothesis this tests: the large majority of `other` closes are benign client
   disconnects.
2. **De-noise (once step 1 confirms the split):** stop capturing benign `other`
   closes to Sentry at error level; route them to Logs with `rawFinishReason`.
3. **Constraints:** a content-filter or genuine error close **still warns** (must
   not be swallowed by the downgrade); **no change to the user-visible closing
   status** of the chat.

**Acceptance:** `rawFinishReason` is present on stream-close telemetry; a benign
client-disconnect close produces a Log and no Sentry issue; a content-filter
close still opens a Sentry issue.

<!-- sentry-fixes: PRODUCT-WEB-117 -->

<details><summary>Investigation & review trail</summary>

- Evidence: Sentry `PRODUCT-WEB-117` (+ 12 sibling fingerprints, enumerated
  here — kept out of the title), ~1 event / 50 runs. Convex session refs …;
  content-filter correlation from prod logs …
- Adversarial review (3 rounds, verdict: holes → action: stop-clean,
  confidence medium).
  Round 1 hole (high) — "downgrade could swallow content-filter stops" →
  resolved: added the still-warn constraint (Requirement 3). Round 2 hole (low) —
  "does `rawFinishReason` risk PII?" → caveat: reason is an enum, no free text.
  Round 3: no new holes. Caveat for the builder: verify the provider always
  supplies a finish reason on abort.

</details>
```

All three examples above file clean. When the review instead ends
`stop-no-new-holes` / `stop-cap` (blocking high-severity holes remain), add the
`needsDefinitionLabelId` label and surface those holes in the body as **open
questions** — the full trail still goes to `<details>`:

```md
**Disposition: fix.** …tight body…

**Open questions (blocking — needs definition).**
- Is the duplicate caused by the retry or by the client re-issuing the request?
  The review couldn't close this from telemetry; a human must confirm before the
  dedup key is chosen.
```

## Rules

- Never move an issue past Triage.
- Specify from the root cause. The `/investigate` output gives you trigger,
  mechanism, scope, and why-now — enough to write a buildable brief. **Only**
  when a fix genuinely requires a product decision or unrecoverable information
  should you file anyway and add the `needs-definition` label
  (`needsDefinitionLabelId`) so the dispatcher skips it until a human fleshes it
  out. Sparing exception, not a default.
- Respect the caps; overflow is reconsidered next run.
- **Surface (don't swallow) MCP failures** — especially a failed/unverifiable
  `add_issue_note`. A missing breadcrumb means the next run re-files a duplicate.
- **Resolution reflects shipped code, not ticket state (by design).** A ticket
  closed manually *without* a shipped `fixes <SHORT-ID>` leaves its Sentry issue
  `unresolved`, so it re-surfaces next run. This is intended — it keeps Sentry
  state honest so genuine regressions re-enter the funnel.
