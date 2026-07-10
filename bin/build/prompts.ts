/**
 * Phase prompt builders for build.
 *
 * Every prompt references the feature's build dir by path (cwd is the repo root,
 * so it's already in scope — no `--add-dir` needed) and ends with an explicit
 * instruction to emit a verdict sentinel the orchestrator parses. `spec.md`
 * is the canonical target for every downstream phase (resolved once by the
 * orchestrator and passed in as `specPath`).
 *
 * Prompts deliberately avoid memory of prior phases: each runs in a fresh
 * subprocess, so the build dir is the only shared context.
 */

import { join } from "node:path"
import type { StateBucket } from "./linear-state-order"
import { OPTIONAL_STEPS_FILENAME, optionalStepDefs } from "./optional-steps"

/**
 * Render the shared forward-only state-advance rule for a Linear-MCP prompt.
 *
 * It prints the ranked buckets (rank → ids) and then a deliberately mechanical
 * instruction: read the issue's CURRENT `state.id`, then advance ONLY if that id
 * is listed in a bucket with `rank < targetRank`. The agent does a lookup
 * against the explicit id lists, never a judgment from state names.
 */
function forwardOnlyRuleText(args: {
  ordering: StateBucket[]
  targetStateId: string
  targetRank: number
  targetLabel: string
}): string {
  const { ordering, targetStateId, targetRank, targetLabel } = args
  const bucketLines = ordering.map(
    (b) => `   - rank ${b.rank} (${b.label}): ${b.stateIds.join(", ")}`,
  )
  return [
    "Forward-only state advance — ranked buckets of CONFIGURED state ids:",
    ...bucketLines,
    `First, read the issue's CURRENT workflow state id from Linear (the \`state.id\` field — NOT the state name).`,
    `Then advance the issue to ${targetStateId} (the ${targetLabel} state) ONLY if that current state id appears in a bucket above with rank < ${targetRank}.`,
    "Compare ids ONLY against the bucket lists above — do not infer order from state names or your own knowledge of Linear workflows.",
    `If the current state id is at rank >= ${targetRank}, or is not listed in ANY bucket above (unrecognized), DO NOT change the state — leave it exactly as is.`,
  ].join("\n")
}

/**
 * Standing instruction (shared by the build + code-review phases) inviting the
 * agent to jot down OUT-OF-SCOPE observations — latent bugs, refactors, tech
 * debt, missing tests, perf issues it happens to notice — into an append-only
 * `observations.md` in the build dir. A later skill mines these into a backlog.
 *
 * The hard rule is that observations never affect the current run: the agent
 * must not act on them, let them block, or expand scope. An absent/empty file
 * is the normal case.
 */
function observationsInstruction(buildDir: string): string {
  const observations = join(buildDir, "observations.md")
  return [
    "While working you may notice problems that are OUT OF SCOPE for this feature —",
    "pre-existing latent bugs, refactors worth doing, tech debt, missing tests, or",
    'perf issues in code you happen to read. "Out of scope" means not required by the',
    `approved plan/design for this feature. Capture each in ${observations} (create it`,
    "if absent; skim the existing entries first and skip anything already recorded) by",
    "appending a Markdown entry:",
    "",
    "## <short title>",
    "- **kind:** bug | refactor | tech-debt | test-gap | perf",
    "- **where:** path/to/file.ts:42",
    "- **why out of scope:** <one line>",
    "- **suggestion:** <what a future engineer should do>",
    "",
    "Rules: do NOT act on them, do NOT let them block or expand the current task, and",
    "only record things genuinely worth a future engineer's time. If nothing stands",
    `out, leave ${observations} untouched — an absent or empty file is normal.`,
  ].join("\n")
}

/**
 * Standing guardrail for every builder-phase prompt. Builder phases run
 * single-turn via `claude --print` (bin/build/harness.ts builderArgs), so
 * background-task notifications, waiter tasks, and scheduled wakeups NEVER
 * fire — the process exits the moment the turn ends. This block tells the
 * agent to finish long work in-turn, in the foreground, chunked to fit the
 * Bash timeout. See PRO-639.
 */
function singleTurnGuardrail(): string {
  return [
    "SINGLE-TURN EXECUTION — READ THIS:",
    "You run as a single-turn `claude --print` invocation. Background-task notifications,",
    "waiter/monitor tasks, and scheduled wakeups will NEVER fire — the process exits the",
    "instant your turn ends. Do NOT background a long-running command (an eval run, smoke",
    "test, dev-server wait, or any multi-minute job) and end your turn expecting to be",
    "re-invoked when it finishes: that kills the run and loses all in-flight work.",
    "Instead, run long commands SYNCHRONOUSLY in the FOREGROUND and wait for them in this",
    "same turn. If a single run would exceed the Bash tool's timeout ceiling, split it into",
    "smaller chunks that each fit, checking intermediate output between chunks — results",
    "accumulate on disk, so chunking is safe and resumable. Finish the work and emit your",
    "completion sentinel before yielding.",
  ].join("\n")
}

/**
 * Standing instruction (shared by the e2e plan + execute stages) inviting the
 * agent to record e2e-INFRASTRUCTURE gaps into the build dir's `observations.md`:
 * a flow that genuinely CANNOT be seeded/tested locally — an un-mockable third
 * party, an external OAuth/webhook callback with no local stand-in, or state
 * whose seeder would be disproportionately large relative to the flow.
 *
 * PRO-729: a flow merely blocked by missing data/state that CAN be seeded is NOT
 * this case — the SEED DATA instruction (rendered above this block) makes the
 * default "build the seeder + exercise the real flow," so those gaps no longer
 * belong in this stream. This block is now reserved for the genuinely-un-seedable
 * remainder.
 *
 * These follow the same append-only convention as `observationsInstruction`, but
 * are pinned to the distinguishable `e2e-infra` kind so the downstream
 * `harvest-observations` skill can route them toward making more of the product
 * e2e-testable. The standing rule still holds: observations never affect the
 * current run (don't act on them, don't block, don't expand scope); an
 * absent/empty file is normal.
 */
function e2eInfraObservationsInstruction(buildDir: string): string {
  const observations = join(buildDir, "observations.md")
  return [
    "While planning/running e2e you may find that a flow genuinely CANNOT be seeded",
    "or tested locally — an un-mockable third party, an external OAuth/webhook",
    "callback with no local stand-in, or state whose seeder would be",
    "disproportionately large relative to the flow. (A flow merely blocked by",
    "missing data/state that CAN be seeded is NOT this case — build the seeder per",
    "the SEED DATA instruction above and exercise the real flow; do not record it",
    `here.) Capture each genuinely-un-seedable gap in ${observations}`,
    "(create it if absent; skim existing entries first and skip anything already",
    "recorded) by appending a Markdown entry with the FIXED e2e-infra kind:",
    "",
    "## <short title>",
    "- **kind:** e2e-infra",
    "- **where:** path/to/file.ts:42 (or the flow / service that can't be tested)",
    "- **why out of scope:** <one line>",
    "- **suggestion:** <what would make this flow e2e-testable next time>",
    "",
    "Rules: do NOT act on them, do NOT let them block or expand the current run, and",
    "only record things genuinely worth a future engineer's time. If nothing stands",
    `out, leave ${observations} untouched — an absent or empty file is normal.`,
  ].join("\n")
}

/**
 * Standing instruction (shared by the evals plan + execute stages) inviting the
 * agent to record eval-INFRASTRUCTURE gaps into the build dir's `observations.md`:
 * a model-facing prompt change that is hard to eval-cover because the harness
 * lacks a driver, fixture, or seed for that automation surface.
 *
 * Pinned to the distinguishable `eval-infra` kind (mirroring `e2e-infra`) so the
 * downstream `harvest-observations` skill can route them toward making more of
 * the agent eval-coverable. The standing rule still holds: observations never
 * affect the current run; an absent/empty file is normal.
 */
function evalInfraObservationsInstruction(buildDir: string): string {
  const observations = join(buildDir, "observations.md")
  return [
    "While planning/running evals you may find that a changed model-facing prompt is",
    "hard or impossible to eval-cover because the harness is missing something — no",
    "driver for that automation/session surface, a missing fixture or seed, an",
    "un-mockable dependency the case would need. Capture each in",
    `${observations} (create it if absent; skim existing entries first and skip`,
    "anything already recorded) by appending a Markdown entry with the FIXED",
    "eval-infra kind:",
    "",
    "## <short title>",
    "- **kind:** eval-infra",
    "- **where:** path/to/file.ts:42 (or the prompt / automation surface that can't be eval-covered)",
    "- **why out of scope:** <one line>",
    "- **suggestion:** <what would make this prompt eval-coverable next time (e.g. add an eval driver for <automation> sessions)>",
    "",
    "Rules: do NOT act on them, do NOT let them block or expand the current run, and",
    "only record things genuinely worth a future engineer's time. If nothing stands",
    `out, leave ${observations} untouched — an absent or empty file is normal.`,
  ].join("\n")
}

/**
 * Standing instruction (build phase primarily, code-review phase as a backstop)
 * inviting the agent to record the DEFERRED NARROW of a Convex
 * widen→migrate→narrow migration into the build dir's `observations.md`.
 *
 * Dispatch agents reliably do widen + migrate but routinely skip narrow — the
 * follow-up PR that drops the now-dead field / old union literal and closes out
 * the `@deprecated` / "narrow to required in a follow-up deploy" comment planted
 * in `convex/schema.ts`. This pins the distinguishable `schema-narrow` kind so
 * `harvest-observations` can route it into a "complete the narrow" Triage ticket.
 *
 * The entry carries more than the generic `where/why/suggestion`: it names what
 * to remove, the widen+migrate origin, and the safety precondition the narrow PR
 * must satisfy. Those extra bullets ride inside the entry's `raw` text (the
 * scanner only structurally parses `where`/`why out of scope`/`suggestion`) and
 * are read by the downstream harvester agent — same as how `e2e-infra` entries
 * carry their reasoning. `where` stays pointed at the `convex/schema.ts`
 * deprecation comment so harvest staleness re-validation has a real file:line.
 *
 * Same append-only convention as `observationsInstruction`: never affects the
 * current run (don't act, don't block, don't expand scope); absent/empty is
 * normal.
 */
function schemaNarrowObservationsInstruction(buildDir: string): string {
  const observations = join(buildDir, "observations.md")
  return [
    "Dispatch uses the widen→migrate→narrow pattern for Convex schema changes (CLAUDE.md): add",
    "the new shape, backfill, then DROP the deprecated field / old union literal once nothing reads",
    "it. Agents reliably widen+migrate but skip the narrow. So: whenever you perform a widen+migrate",
    "that defers the narrow — or notice a pre-existing un-narrowed migration (an orphaned deprecated",
    `field or dead union literal still in apps/web/convex/schema.ts) — append an entry to ${observations}`,
    "(create it if absent; skim existing entries first and skip anything already recorded) with the",
    "FIXED schema-narrow kind:",
    "",
    "## <short title>",
    "- **kind:** schema-narrow",
    "- **where:** apps/web/convex/schema.ts:NNN (the deprecated field / union literal + its deprecation comment)",
    "- **what to remove:** the table+field, or the validator union + the specific literal(s)",
    "- **widen+migrate origin:** the PR/commit/migration that introduced the new shape and backfilled",
    "- **safety precondition:** verify nothing still reads/writes the deprecated field and the backfill completed before deleting",
    "- **suggestion:** delete the field/literal and close out the deprecation comment; optionally clean up deprecated-field readers / dual-write shims when obvious",
    "",
    "Keep `where` pointed at the convex/schema.ts deprecation comment (the harvester re-opens it to",
    "re-validate staleness). Riding code cleanup (deprecated-field readers, dual-write shims) is at",
    "your judgment — capture it when obvious, don't mandate it. Rules: do NOT act on them, do NOT let",
    "them block or expand the current run, and only record genuine narrows. If nothing stands out,",
    `leave ${observations} untouched — an absent or empty file is normal.`,
  ].join("\n")
}

/**
 * Standing instruction for the e2e PLAN/EXECUTE stages: name the discoverable,
 * reachable seed-data path so the agent stops marking flows "untestable" merely
 * because they need a person/connection/meeting that isn't in the workspace yet
 * (PRO-554). The dev-login workspace comes pre-seeded with these fixtures, and
 * the underlying internal seeds are reachable from `apps/web` via `bunx convex
 * run` for any additional data a flow needs.
 *
 * PRO-729 flips the default one step further: when a flow is blocked by missing
 * data/state and NO existing seed path covers it, the agent BUILDS the durable,
 * discoverable seeder (per the `seeding` skill's no-orphan checklist) in this
 * same PR and exercises the real flow — rather than recording an e2e-infra
 * observation and skipping. The observation stream survives, but narrows to gaps
 * that genuinely can't be seeded locally (un-mockable third parties, external
 * OAuth/webhook callbacks, or a seeder disproportionately large relative to the
 * flow). Seedable-vs-genuinely-un-seedable is the deciding line, not "does a seed
 * already exist."
 *
 * Gating-wording precision: the seeds are `assertDevEnvironment()`-gated, so
 * they are production-blocked / dev-only. The dev-login *route* is reachable on
 * a preview deploy too, but the seeds only ever *execute* locally (on preview
 * they throw and are swallowed best-effort) — so this block says "dev-only",
 * never "dev/preview-only".
 */
function devSeedDataInstruction(devUrl?: string): string {
  const loginUrl = devUrl
    ? `${devUrl}/api/auth/dev-login`
    : "the dev-login endpoint (/api/auth/dev-login)"
  return [
    "SEED DATA — the dev-login workspace is pre-seeded; do not pre-mark seedable flows untestable:",
    `- Authenticating via ${loginUrl} lands you in a workspace pre-seeded with: comped billing, a user profile, a Gmail-stub connection, a meeting fixture (transcript + recording), and a set of people with email connections (person-detail and the people list have real data to render).`,
    "- These seeds are idempotent (safe to re-run on every bring-up) and production-blocked / dev-only — they run only when Convex ENVIRONMENT=development. (The dev-login route is also reachable on a preview deploy, but the seeds only execute locally.)",
    "- Need data a flow requires that isn't pre-seeded? The `seeding` skill (.agents/skills/seeding/SKILL.md) is the catalogue of every seed entrypoint — read it. It lists what each seeds and the exact `bunx convex run <module>:<fn> '<json-args>'` recipe (Bash is available); resolve the org id with `bunx convex data organization --limit 10`. The dev-login baseline it documents is orchestrated by apps/web/src/app/api/dev/ensure-org/_lib/ensure-dev-workspace.ts (seeds defined in apps/web/convex/devSeed.ts, e.g. seedPeopleFixture; people.seedMany is the related bulk people-insert primitive).",
    "- REFRAME (seed exists): a flow blocked ONLY by missing data (people, connections, meetings, booking pages, …) that has a seed path in the `seeding` skill must NOT be marked untestable or skipped — seed it and exercise the real flow.",
    '- REFRAME (no seed path yet → BUILD it): if a flow is blocked by missing data/state and NO existing seed path covers it, the DEFAULT is to build the seeder needed to exercise this flow, then test the real flow — NOT to record an observation and skip. Follow the `seeding` skill\'s "Adding a new dev seed — the no-orphan checklist": define an idempotent `assertDevEnvironment()`-gated `internalMutation` in apps/web/convex/devSeed.ts; register it in apps/web/convex/serverGateway.ts + apps/web/src/lib/convex/server-gateway-registry-types.ts if reached via serverConvex; add a catalogue row so it stays discoverable; and add a red/green smoke test in apps/web/convex/devSeed.test.ts asserting the seeded state reaches the target flow. This seeder is committed code in THIS PR and clears the same bars as any other change — code review + its smoke test; not throwaway setup.',
    '- BOUNDARY (still record an e2e-infra observation): only when the gap genuinely CANNOT be seeded locally — an un-mockable third party, an external OAuth/webhook callback with no local stand-in (e.g. a Gmail-trigger stub), or state whose seeder would be disproportionately large relative to the flow. Seedable-vs-genuinely-un-seedable is the deciding line, not "does a seed already exist."',
  ].join("\n")
}

/**
 * Standing instruction for the BUILD phase: update the weekly changelog when the
 * change is user-facing. The docs skill (`.claude/skills/docs/SKILL.md`,
 * "Writing changelog entries") is the single source of truth for the full
 * convention; this step points at it and restates only the load-bearing entry
 * points (file path, create-vs-edit, registration) so the agent can act without
 * always opening the skill.
 */
function changelogStep(buildDir: string): string {
  const impl = join(buildDir, "implementation.md")
  return [
    "Update the weekly changelog if this change is user-facing:",
    "- Decide whether the change is user-facing (visible behavior, UI, or capability a customer would notice). Non-user-facing changes (refactors, infra, tests, build tooling) get NO changelog entry — skip this and record one line of why in implementation.md.",
    '- If user-facing, follow the weekly-changelog conventions in .claude/skills/docs/SKILL.md ("Writing changelog entries"): compute the current week\'s Monday and create-or-update apps/docs/content/docs/changelog/<monday>.mdx.',
    "  - First qualifying change of the week: create the file with valid frontmatter plus this change's content, and register it (newest first) in apps/docs/content/docs/changelog/index.mdx and apps/docs/content/docs/changelog/meta.json.",
    "  - Later change in an existing week: append a featured ## section (larger launch) or a `## Smaller changes` bullet (minor change) to the existing week's post — no registration change needed.",
    `- Record in ${impl} whether a changelog update was made (and at what level) or skipped (with the one-line reason).`,
  ].join("\n")
}

/**
 * Standing instruction for the CODE-REVIEW phase: verify changelog coverage for a
 * user-facing diff. A missing or under-leveled published entry for a user-facing
 * change is a [blocking] finding; non-user-facing changes correctly carry none.
 */
function changelogVerification(): string {
  return [
    "Verify weekly changelog coverage. If the diff is user-facing, confirm all of:",
    "- the current week's post exists at apps/docs/content/docs/changelog/<monday>.mdx;",
    "- it is published — registered in both apps/docs/content/docs/changelog/index.mdx and apps/docs/content/docs/changelog/meta.json;",
    "- the content level matches the change size (larger launch → featured ## section with description and a feature link / media; minor change → a single scannable `## Smaller changes` bullet);",
    "- frontmatter is valid, with `date` equal to the week's Monday;",
    "- the entry links the affected feature page where one applies (a cross-cutting change with no single feature page need not invent a link).",
    "Raise a [blocking] finding when a user-facing change lacks an appropriately-leveled, published entry. A non-user-facing change correctly carries no entry.",
  ].join("\n")
}

export type PlanPromptArgs = {
  feature: string
  buildDir: string
  /** Resolved path to the canonical input spec (spec.md, or legacy design.md). */
  specPath: string
  /** True when re-planning after a NEEDS_REVISION verdict. */
  revising: boolean
}

/**
 * Instruct the plan agent to emit the optional-steps declaration. The criteria are
 * rendered from the registry (`optional-steps.ts`) so it stays the single source.
 * Iterates with `optionalStepDefs()` (the registry is a keyed map, not a list).
 */
function optionalStepsDeclarationStep(buildDir: string): string {
  const out = join(buildDir, OPTIONAL_STEPS_FILENAME)
  const criteria = optionalStepDefs().map(
    (s) => `   - "${s.id}": needed when ${s.appliesWhen}`,
  )
  return [
    "Declare which OPTIONAL build steps this ticket needs. For EACH step below, decide whether",
    "the change calls for it, with a one-line rationale. Default to NEEDED when unsure (fail-safe).",
    "Optional steps:",
    ...criteria,
    `Write ${out} as JSON mapping each step id to {"needed": <bool>, "rationale": "<one line>"}, e.g.:`,
    `   {"e2e": {"needed": true, "rationale": "adds a new settings page users interact with"}}`,
    "Include an entry for every step id listed above. This declaration is durable and gates the build.",
  ].join("\n")
}

export function planPrompt({
  feature,
  buildDir,
  specPath,
  revising,
}: PlanPromptArgs): string {
  const spec = specPath
  const planReview = join(buildDir, "plan-review.md")
  const plan = join(buildDir, "plan.md")
  return [
    `You are the PLAN phase of an autonomous build pipeline for the "${feature}" feature.`,
    "You run headless in a fresh context; the build dir on disk is your only shared state.",
    "",
    singleTurnGuardrail(),
    "",
    `1. Read the approved spec at ${spec} — it is the canonical target. Everything you plan must serve it.`,
    revising
      ? `2. This is a revision. Read the reviewer's critique at ${planReview} and address every point it raises.`
      : "2. Explore the codebase to ground the plan in real files, patterns, and conventions.",
    `3. Write a concrete, step-by-step coding plan to ${plan}. Reference actual files (path:line), describe the changes, call out tests (red/green TDD), and note any risks or sequencing constraints.`,
    "",
    optionalStepsDeclarationStep(buildDir),
    "",
    "Do NOT write production code in this phase — only the plan.",
    "",
    "When the plan is complete and faithful to the spec, output the exact line:",
    "PLAN_DONE",
    "If you genuinely cannot produce a plan (the spec is internally contradictory, or a decision needs human product judgment), instead output:",
    "ESCALATE: <one-line reason>",
  ].join("\n")
}

export type PlanReviewPromptArgs = {
  feature: string
  buildDir: string
  /** Resolved path to the canonical input spec (spec.md, or legacy design.md). */
  specPath: string
}

export function planReviewPrompt({
  feature,
  buildDir,
  specPath,
}: PlanReviewPromptArgs): string {
  const spec = specPath
  const plan = join(buildDir, "plan.md")
  const out = join(buildDir, "plan-review.md")
  const decl = join(buildDir, OPTIONAL_STEPS_FILENAME)
  return [
    `You are the PLAN-REVIEW phase of an autonomous build pipeline for the "${feature}" feature.`,
    "You are a fresh, independent reviewer with no knowledge of how the plan's author reasoned — that independence is the point.",
    "",
    `1. Read ${spec} — this is the CANONICAL target. Judge strictly against it.`,
    `2. Read the coding plan at ${plan}.`,
    `3. Critique the plan: does it fully and faithfully realise the spec? Look for missing steps, hidden dependencies, incorrect assumptions, scope creep, untested paths, and simpler alternatives.`,
    `4. Sanity-check the optional-step declaration at ${decl} against the plan and spec. Each step`,
    "   records whether it's needed. Flag a CLEARLY-WRONG call — e.g. e2e marked not-needed for a change",
    "   that plainly touches user-facing UI, or needed for a pure-backend change with no user surface, or",
    "   evals marked not-needed for a change that edits a connector system prompt or a judge/scorer rubric —",
    "   and bounce the plan (NEEDS_REVISION) so it is corrected, exactly like any other plan defect.",
    "   When unsure, prefer leaving the step needed (fail-safe) rather than bouncing.",
    `5. Write your critique to ${out}.`,
    "",
    "This is a hard gate: no code is written until the plan is APPROVED.",
    "",
    "End your output with exactly one of these lines:",
    "APPROVED            — the plan faithfully realises the design and is ready to build",
    "NEEDS_REVISION      — the plan must change first (your critique file says how)",
    "ESCALATE: <reason>  — you cannot judge without human input (genuine ambiguity / product call)",
  ].join("\n")
}

export type BuildPromptArgs = {
  feature: string
  buildDir: string
  /** Resolved path to the canonical input spec (spec.md, or legacy design.md). */
  specPath: string
  /** Present when re-entering build after a failed validate gate. */
  validateFailuresPath?: string
}

export function buildPrompt({
  feature,
  buildDir,
  specPath,
  validateFailuresPath,
}: BuildPromptArgs): string {
  const spec = specPath
  const plan = join(buildDir, "plan.md")
  const impl = join(buildDir, "implementation.md")
  return [
    `You are the BUILD phase of an autonomous build pipeline for the "${feature}" feature.`,
    "You run headless in a fresh context; the build dir on disk is your only shared state.",
    "",
    singleTurnGuardrail(),
    "",
    `1. Read the approved plan at ${plan} and the canonical spec at ${spec}.`,
    validateFailuresPath
      ? `2. The validation gate FAILED on the last build. Read the captured failure output at ${validateFailuresPath} and fix the root cause — do not weaken tests or silence errors.`
      : "2. Implement the plan. Follow the repo's conventions (red/green TDD, Biome style, CLAUDE.md rules).",
    `3. Record what you built and any divergences from the plan in ${impl}.`,
    "",
    changelogStep(buildDir),
    "",
    `4. Commit ALL of your work with clear messages — implementation code, ${impl}, and any changelog files (apps/docs/content/docs/changelog/...). Leave nothing uncommitted, or the changelog update will be missing from the PR.`,
    "",
    observationsInstruction(buildDir),
    "",
    schemaNarrowObservationsInstruction(buildDir),
    "",
    "When the implementation is complete, output the exact line:",
    "BUILD_DONE",
    "If you are genuinely blocked (the plan is unbuildable as written, or a decision needs human judgment), instead output:",
    "ESCALATE: <one-line reason>",
  ].join("\n")
}

// --- e2e sub-pipeline prompts ----------------------------------------------
//
// The e2e step of the validate gate is a plan → plan-feedback → execute
// sub-pipeline. plan/plan-feedback run once per build (bounded, never blocking
// on a human); execute re-runs on every build↔validate revisit. The plan loop
// reuses the existing PlanReviewVerdict (APPROVED / NEEDS_REVISION / ESCALATE);
// execute emits its own E2E_PASS / E2E_FAIL sentinel (see verdicts.ts).

export type E2ePlanPromptArgs = {
  feature: string
  buildDir: string
  /** Resolved path to the canonical input spec (spec.md, or legacy design.md). */
  specPath: string
  /** True when re-planning after a NEEDS_REVISION verdict. */
  revising: boolean
}

/**
 * The e2e PLAN stage (builder/claude): author a concrete e2e test plan from the
 * settled artifacts. Planning only — no production code, no browser. Always
 * leaves a best-effort `e2e-plan.md` so execute has something to follow; the
 * loop installs a fallback if no plan is written, so neither sentinel routes to
 * a human.
 */
export function e2ePlanPrompt({
  feature,
  buildDir,
  specPath,
  revising,
}: E2ePlanPromptArgs): string {
  const spec = specPath
  const impl = join(buildDir, "implementation.md")
  const plan = join(buildDir, "e2e-plan.md")
  const planReview = join(buildDir, "e2e-plan-review.md")
  return [
    `You are the e2e PLAN stage of an autonomous build pipeline for the "${feature}" feature.`,
    "You run headless in a fresh context; the build dir on disk is your only shared state.",
    "This stage plans how the feature will be e2e-tested. It NEVER blocks on a human.",
    "",
    singleTurnGuardrail(),
    "",
    `1. Read the canonical spec at ${spec}, and the implementation record at ${impl} when available (it records what was actually built).`,
    revising
      ? `2. This is a revision. Read the reviewer's critique at ${planReview} and address every point it raises.`
      : "2. Ground the plan in the real flows the feature introduces or changes.",
    `3. Write a concrete e2e test plan to ${plan}. Enumerate the user flows to exercise — the HAPPY PATH and every spec-called-out flow — with concrete steps (navigations, interactions, what to assert). For any required flow that CANNOT be e2e-tested in the local harness, flag it explicitly with the reason (un-mockable third party, external webhook, OAuth callback, or seed state with no local seam — see SEED DATA below: a flow merely missing seedable data is NOT untestable, plan to build the seeder) and the word "untestable".`,
    "4. Record e2e-infra gaps as instructed below.",
    "5. Do NOT write production code and do NOT run a browser — this is planning only.",
    "",
    devSeedDataInstruction(),
    "",
    e2eInfraObservationsInstruction(buildDir),
    "",
    `ALWAYS write ${plan} before finishing, even if the plan is partial or you conclude little can be tested locally — a best-effort plan (e.g. "flow X untestable because Y; recorded an e2e-infra observation and proceed") is still a usable artifact for the execute stage. Then output the exact line:`,
    "PLAN_DONE",
    "Reserve the following ONLY for a genuine inability to author ANY plan at all (prefer a partial plan + PLAN_DONE):",
    "ESCALATE: <one-line reason>",
    "Neither sentinel routes to a human: this loop never blocks. On ESCALATE the pipeline installs a fallback plan and proceeds.",
  ].join("\n")
}

export type E2ePlanReviewPromptArgs = {
  feature: string
  buildDir: string
  /** Resolved path to the canonical input spec (spec.md, or legacy design.md). */
  specPath: string
}

/**
 * The e2e PLAN-FEEDBACK stage (reviewer/codex): an independent critique of the
 * e2e plan against the spec. Reuses the plan-review verdict vocabulary
 * (APPROVED / NEEDS_REVISION / ESCALATE). This loop never blocks on a human —
 * an ESCALATE or absent verdict simply proceeds with the best plan.
 */
export function e2ePlanReviewPrompt({
  feature,
  buildDir,
  specPath,
}: E2ePlanReviewPromptArgs): string {
  const spec = specPath
  const impl = join(buildDir, "implementation.md")
  const plan = join(buildDir, "e2e-plan.md")
  const out = join(buildDir, "e2e-plan-review.md")
  return [
    `You are the e2e PLAN-FEEDBACK stage of an autonomous build pipeline for the "${feature}" feature.`,
    "You are a fresh, independent reviewer with no knowledge of how the plan's author reasoned — that independence is the point.",
    "",
    `1. Read ${spec} — the CANONICAL target — and the implementation record at ${impl} when available.`,
    `2. Read the e2e test plan at ${plan}.`,
    "3. Critique it: is it complete against the spec; are the listed flows actually exercisable in the local harness; is anything marked untestable that IS in fact testable (or vice versa); is the happy path covered?",
    `4. Write your critique to ${out}.`,
    "",
    "End your output with exactly one of these lines:",
    "APPROVED            — the plan covers the spec's flows and correctly scopes what is/isn't testable",
    "NEEDS_REVISION      — the plan must change first (your critique file says how)",
    "ESCALATE: <reason>  — you cannot judge without input (genuine ambiguity)",
    "This loop never blocks on a human: NEEDS_REVISION triggers a bounded revision, and on ESCALATE (or no verdict) the pipeline proceeds with the best plan it has.",
  ].join("\n")
}

export type E2eExecutePromptArgs = {
  feature: string
  buildDir: string
  /** Resolved path to the canonical input spec (spec.md, or legacy design.md). */
  specPath: string
  /** The reachable dev-server URL to drive the browser against. */
  devUrl: string
  /** Base branch (e.g. "main"); the marketing-detection diff is taken against `origin/<base>`. */
  baseBranch: string
}

/**
 * The e2e EXECUTE stage (builder/claude, strict next-devtools MCP): drive the
 * real browser against the dev server following the approved plan, writing an
 * `e2e-report.md` that documents how the feature was tested. Distinguishes a
 * BROKEN flow (real defect → E2E_FAIL → builder) from an UNTESTABLE flow
 * (skip → record observation → continue) — the two must not be conflated.
 */
export function e2eExecutePrompt({
  feature,
  buildDir,
  specPath,
  devUrl,
  baseBranch,
}: E2eExecutePromptArgs): string {
  const spec = specPath
  const plan = join(buildDir, "e2e-plan.md")
  const report = join(buildDir, "e2e-report.md")
  const screenshotsDir = join(buildDir, "screenshots")
  return [
    `You are the e2e EXECUTE stage of an autonomous build pipeline for the "${feature}" feature.`,
    "You drive a real browser via the next-devtools MCP (mcp__next-devtools__browser_eval). Only that MCP server is available.",
    "",
    singleTurnGuardrail(),
    "",
    `1. Read the approved e2e plan at ${plan} (the plan to follow) and the canonical spec at ${spec}.`,
    `2. Authenticate by navigating to ${devUrl}/api/auth/dev-login, then drive each planned flow with mcp__next-devtools__browser_eval against ${devUrl}.`,
    "3. DISTINGUISH, do not conflate, two outcomes:",
    "   - A flow that is exercisable but BROKEN — a real defect in the diff under review — is an e2e failure: end with `E2E_FAIL: <what broke>`.",
    "   - A flow that is genuinely UNTESTABLE in the local harness is NOT a failure: skip it, record an e2e-infra observation (below), note it as skipped in the report, and continue.",
    `4. Write ${report} documenting HOW the feature was tested: which planned flows were exercised, the concrete navigations/interactions taken, what was observed, the pass/fail outcome, and which flows were skipped as untestable with reasons. Produce the report even when some or all flows couldn't be exercised ("could not test X because Y" is a valid report). It must be specific enough that a human reading only the report understands the coverage achieved.`,
    "5. Record e2e-infra gaps as instructed below.",
    "",
    devSeedDataInstruction(devUrl),
    "",
    verificationScreenshotInstruction(buildDir, screenshotsDir),
    "",
    marketingScreenshotInstruction(baseBranch),
    "",
    e2eInfraObservationsInstruction(buildDir),
    "",
    "End with exactly one of these lines:",
    "E2E_PASS            — every exercisable flow passed; untestable flows were recorded + skipped",
    "E2E_FAIL: <what broke>  — an exercisable flow is broken (a real defect in the diff under review)",
  ].join("\n")
}

/**
 * Verification-screenshot capture block for the e2e execute prompt. The execute
 * stage is the ONLY pipeline stage with a guaranteed dev server + browser, so
 * all capture lives here. Gate-enforced by `runE2eExecute` (e2e.ts): a UI run's
 * `E2E_PASS` requires ≥1 screenshot under `screenshots/` AND every captured PNG
 * referenced inline in the report; a genuinely headless change records the
 * `E2E_NO_UI_SURFACE` marker plus a prose rationale instead.
 */
function verificationScreenshotInstruction(
  buildDir: string,
  screenshotsDir: string,
): string {
  const report = join(buildDir, "e2e-report.md")
  return [
    "VERIFICATION SCREENSHOTS (visual evidence the feature works):",
    "- Decide WHAT to capture by reading the spec — the key screens/states that demonstrate this feature working. Do not use a hardcoded shot list.",
    `- Capture each shot with mcp__next-devtools__browser_eval (action: "screenshot"), then SAVE the resulting PNG into ${screenshotsDir}/<descriptive-kebab-name>.png using your normal file tools (Bash/Read/Write are available). This exact directory is the committable path — never save under a .build/ scratch dir.`,
    `- Reference each saved screenshot inline in ${report}, tying each shot to the flow it evidences, using the build-dir-relative path screenshots/<name>.png — e.g. a markdown image \`![login](screenshots/login.png)\`.`,
    "- GATE-ENFORCED: every PNG you save under the screenshots dir MUST appear in the report as `screenshots/<name>.png`, or E2E_PASS is rejected and the run routes back here. Don't save a shot you don't reference, and don't reference a shot you didn't save.",
    "- HARD GATE: if the feature has ANY user-facing UI surface, you MUST capture at least one verification screenshot before emitting E2E_PASS.",
    "- BACKEND-ONLY EXEMPTION: if the change is genuinely headless/backend-only (no UI surface), do not invent a shot. Instead BOTH (a) record the exemption on its OWN line in the report as exactly E2E_NO_UI_SURFACE: <one-line reason> — plain text, NOT wrapped in backticks, bold, or any other markdown — AND (b) explain in the report prose (using the report's normal skipped/untestable-flow language) WHY no UI screenshot applies. The marker is the deterministic gate signal; the prose rationale keeps it from being a bare, unexplained line. This recording lives in the report itself — do NOT route it into the e2e-infra observation stream.",
  ].join("\n")
}

/**
 * Marketing-screenshot capture block (featured changelog sections only). Keys
 * off THIS build's changelog change, detected via the same two-dot
 * `origin/<base>..HEAD` diff the deterministic gate uses, so prompt and gate
 * agree on what counts as "introduced by this build". Gate-enforced by
 * `validateMarketingScreenshots` (marketing-screenshots.ts).
 */
function marketingScreenshotInstruction(baseBranch: string): string {
  const changelogContentDir = "apps/docs/content/docs/changelog/"
  return [
    "MARKETING SCREENSHOTS (featured changelog sections only):",
    `- Detect THIS build's featured changelog sections deterministically: \`git diff origin/${baseBranch}..HEAD -- ${changelogContentDir}\` (two-dot tip-vs-tip — the same diff the gate reads). A newly-added \`##\` heading that is NOT \`## Smaller changes\` is a featured section this build introduced.`,
    "- If the diff adds only `## Smaller changes` bullets, or no changelog change at all → produce NO marketing screenshots; skip this block entirely.",
    "- For EACH new featured section: capture a POLISHED, marketing-ready shot — clean/representative data, sensible framing, calm public-docs register (no debug UI, no obvious test data). This is distinct from a verification shot.",
    "- IDEMPOTENCY (structural): before capturing, check whether the section already references `/changelog/<name>.png` AND that file already exists under apps/docs/public/changelog/. If so, skip (a re-run/resume already wired it).",
    "- NON-CLOBBERING: choose a descriptive kebab-case `<name>`; if apps/docs/public/changelog/<name>.png already exists for a DIFFERENT section, pick a non-colliding name.",
    "- PLACE + WIRE: save to apps/docs/public/changelog/<name>.png; edit the featured section in the week's apps/docs/content/docs/changelog/<monday>.mdx to reference it via `/changelog/<name>.png` (per .claude/skills/docs/SKILL.md, 'Writing changelog entries' → 'Body shape').",
    "- COMMIT ATOMICALLY: `git add` the PNG AND the edited .mdx and commit them together in one commit; leave nothing uncommitted under apps/docs/. These paths are outside build/<feature>, so the pipeline's artifact commit will NOT stage them — you must self-commit. The commit also makes the change visible to the two-dot diff the gate reads.",
    "- CONSEQUENCE: if a featured changelog section is introduced but its marketing screenshot is not captured, placed, and wired, the e2e gate FAILS the run and routes back here — so this is required, not optional.",
  ].join("\n")
}

/**
 * The CONTENT of a minimal `e2e-plan.md` the orchestrator writes when the plan
 * loop fails to produce one (planner escalated or crashed without writing the
 * file). Not a prompt — a static template with `reason` interpolated, so the
 * execute stage (which DOES read it as its plan) does the planning work the
 * planner couldn't.
 *
 * Critically, a planner failure is a PLANNING/PIPELINE limitation, NOT evidence
 * the feature's flows are untestable. The template therefore does not pre-declare
 * the feature untestable; it instructs execute to derive the test scope itself
 * from the spec and make a concrete best-effort pass before any verdict.
 */
export function fallbackE2ePlanArtifact(reason: string): string {
  return [
    "# e2e plan (fallback)",
    "",
    `**No reviewed e2e plan could be authored.** Reason: ${reason}`,
    "",
    "This is an e2e PLANNING/PIPELINE limitation — it is NOT proof that any product",
    "flow is untestable. Do not treat it as a free pass.",
    "",
    "## What the execute stage must do",
    "",
    "1. Derive the test scope yourself from the spec (spec.md) and the implementation",
    "   record (implementation.md) when present: identify the HAPPY PATH and every",
    "   spec-called-out flow.",
    "2. Make a concrete best-effort pass exercising each derived flow against the dev",
    "   server before reaching any verdict. Do NOT declare E2E_PASS without having",
    "   actually attempted these flows.",
    "3. Apply the same broken-vs-untestable rule as a normal run:",
    "   - a flow exercised and found BROKEN → `E2E_FAIL: <what broke>`;",
    "   - a flow you independently determine is genuinely UNTESTABLE in the local",
    "     harness → skip it, record an e2e-infra observation with the reason, note it",
    "     skipped in the report, and continue.",
    "4. In e2e-report.md keep these two things SEPARATE — do not merge them into a",
    '   single "couldn\'t test, passing" line:',
    `   (a) the pipeline limitation: "the planner failed to produce a plan (reason: ${reason})";`,
    '   (b) any per-flow "flow X is untestable because Y" determinations you made.',
    "5. Only then: `E2E_PASS` if every exercised flow passed and the rest were",
    "   genuinely untestable (recorded), or `E2E_FAIL: <what broke>` if a flow broke.",
    "   A planning failure on its own never emits E2E_FAIL — but it also never grants",
    "   an E2E_PASS without a real attempt at the spec-derived flows.",
  ].join("\n")
}

// --- evals sub-pipeline prompts --------------------------------------------
//
// The evals step of the validate gate is a plan → plan-feedback → execute
// sub-pipeline mirroring e2e. plan/plan-feedback run once per build (bounded,
// never blocking on a human); execute re-runs on every build↔validate revisit.
// The plan loop reuses the existing PlanReviewVerdict (APPROVED / NEEDS_REVISION
// / ESCALATE); execute emits its own EVAL_PASS / EVAL_FAIL sentinel (verdicts.ts).
//
// The `eval` skill (.claude/skills/eval/SKILL.md) is the source of truth for the
// harness: Evalite + msw, the runFromOrigin / todo-session drivers, the three
// scorer families, per-run Convex isolation via `eval-` synthetic orgs.

export type EvalPlanPromptArgs = {
  feature: string
  buildDir: string
  /** Resolved path to the canonical input spec (spec.md, or legacy design.md). */
  specPath: string
  /** Base branch (e.g. "main"); the prompt-delta diff is taken against `origin/<base>`. */
  baseBranch: string
  /** True when re-planning after a NEEDS_REVISION verdict. */
  revising: boolean
}

/**
 * The evals PLAN stage (builder/claude): map the build's model-facing prompt
 * changes to eval coverage, list cases to author/update + the minimal relevant
 * subset to run, and write the machine-readable `eval-required-cases.json`
 * coverage contract the gate enforces. Planning only — no cases run here. Always
 * leaves a best-effort `eval-plan.md`; the loop installs a fallback if none is
 * written, so neither sentinel routes to a human.
 */
export function evalPlanPrompt({
  feature,
  buildDir,
  specPath,
  baseBranch,
  revising,
}: EvalPlanPromptArgs): string {
  const spec = specPath
  const impl = join(buildDir, "implementation.md")
  const plan = join(buildDir, "eval-plan.md")
  const planReview = join(buildDir, "eval-plan-review.md")
  const requiredCases = join(buildDir, "eval-required-cases.json")
  return [
    `You are the evals PLAN stage of an autonomous build pipeline for the "${feature}" feature.`,
    "You run headless in a fresh context; the build dir on disk is your only shared state.",
    "This stage plans how the changed model-facing prompts will be eval-covered. It NEVER blocks on a human.",
    "",
    singleTurnGuardrail(),
    "",
    `1. Read the canonical spec at ${spec} and the implementation record at ${impl} when available. Read the eval skill at .claude/skills/eval/SKILL.md — it is the source of truth for the harness (drivers, scorer families, .eval.ts layout under apps/web/evals/cases/).`,
    revising
      ? `2. This is a revision. Read the reviewer's critique at ${planReview} and address every point it raises.`
      : `2. Run \`git diff origin/${baseBranch}..HEAD\` to find the MODEL-FACING prompt text this build changed — a connector system-prompt section, the assembled agent system prompt (apps/web/src/lib/agent/system-prompt.ts), a default/seeded user-space or automation prompt, the permission-agent prompt, or a judge/scorer rubric.`,
    "3. Map each changed prompt to existing coverage under apps/web/evals/cases/… . List the cases to author/update and the MINIMAL relevant subset to run: the cases touching the changed prompt plus any newly-authored cases — NEVER the full suite (each case makes real paid dual-judge calls).",
    `4. Write ${requiredCases} — a machine-readable JSON list of the case-name substrings that MUST run for this change, shape [{ "pattern": "<case-name substring>", "reason": "<why this change requires it>" }]. This is the deterministic coverage contract the gate enforces; the plan-review stage sanity-checks it against the diff.`,
    `5. Write a concrete eval plan to ${plan}: which prompts changed, the cases to author/update (covering both the intended quality and the regressions to catch), and the exact relevant subset to run.`,
    "6. Record eval-infra gaps as instructed below.",
    "7. Do NOT write production code and do NOT run any eval — this is planning only.",
    "",
    evalInfraObservationsInstruction(buildDir),
    "",
    `ALWAYS write ${plan} AND ${requiredCases} before finishing, even if partial. Then output the exact line:`,
    "PLAN_DONE",
    "Reserve the following ONLY for a genuine inability to author ANY plan at all (prefer a partial plan + PLAN_DONE):",
    "ESCALATE: <one-line reason>",
    "Neither sentinel routes to a human: this loop never blocks. On ESCALATE the pipeline installs a fallback plan and proceeds.",
  ].join("\n")
}

export type EvalPlanReviewPromptArgs = {
  feature: string
  buildDir: string
  /** Resolved path to the canonical input spec (spec.md, or legacy design.md). */
  specPath: string
}

/**
 * The evals PLAN-FEEDBACK stage (reviewer/codex): independent critique of the
 * eval plan + the coverage contract against the diff. Reuses the plan-review
 * verdict vocabulary. Never blocks on a human.
 */
export function evalPlanReviewPrompt({
  feature,
  buildDir,
  specPath,
}: EvalPlanReviewPromptArgs): string {
  const spec = specPath
  const impl = join(buildDir, "implementation.md")
  const plan = join(buildDir, "eval-plan.md")
  const requiredCases = join(buildDir, "eval-required-cases.json")
  const out = join(buildDir, "eval-plan-review.md")
  return [
    `You are the evals PLAN-FEEDBACK stage of an autonomous build pipeline for the "${feature}" feature.`,
    "You are a fresh, independent reviewer with no knowledge of how the plan's author reasoned — that independence is the point.",
    "",
    `1. Read ${spec} — the CANONICAL target — and the implementation record at ${impl} when available.`,
    `2. Read the eval plan at ${plan} and the coverage contract at ${requiredCases}.`,
    "3. Critique it: does the plan cover EVERY changed model-facing prompt; is eval-required-cases.json faithful to the diff (neither padded with irrelevant cases nor missing a changed prompt); is the chosen subset right (the touched + newly-authored cases, NOT the whole suite); are the cases-to-author real and exercisable in the harness?",
    `4. Write your critique to ${out}.`,
    "",
    "End your output with exactly one of these lines:",
    "APPROVED            — the plan covers every changed prompt and the coverage contract is faithful to the diff",
    "NEEDS_REVISION      — the plan must change first (your critique file says how)",
    "ESCALATE: <reason>  — you cannot judge without input (genuine ambiguity)",
    "This loop never blocks on a human: NEEDS_REVISION triggers a bounded revision, and on ESCALATE (or no verdict) the pipeline proceeds with the best plan it has.",
  ].join("\n")
}

export type EvalExecutePromptArgs = {
  feature: string
  buildDir: string
  /** Resolved path to the canonical input spec (spec.md, or legacy design.md). */
  specPath: string
  /** Base branch (e.g. "main"); the gate reads its committed baseline via `git show origin/<base>`. */
  baseBranch: string
}

/**
 * The evals EXECUTE stage (builder/claude, DEFAULT MCP — needs Bash + file tools
 * + Convex CLI): author/update the planned cases, run the relevant subset,
 * refresh + commit the baseline, and write `eval-report.md`. A deterministic
 * gate (`runEvalExecute`) re-checks `eval-run.json` against main's committed
 * baseline, so a hand-waved EVAL_PASS without a real run + committed baseline is
 * rejected and routes back here via the validate gate.
 */
export function evalExecutePrompt({
  feature,
  buildDir,
  specPath,
  baseBranch,
}: EvalExecutePromptArgs): string {
  const spec = specPath
  const plan = join(buildDir, "eval-plan.md")
  const requiredCases = join(buildDir, "eval-required-cases.json")
  const report = join(buildDir, "eval-report.md")
  const runJson = join(buildDir, "eval-run.json")
  const baselines = "apps/web/evals/baselines.json"
  return [
    `You are the evals EXECUTE stage of an autonomous build pipeline for the "${feature}" feature.`,
    "You run headless in a fresh context; the build dir on disk is your only shared state.",
    "",
    singleTurnGuardrail(),
    "",
    `1. Read the approved eval plan at ${plan}, the coverage contract at ${requiredCases}, and the canonical spec at ${spec}. Read the eval skill at .claude/skills/eval/SKILL.md — the harness source of truth (drivers, scorer families, .eval.ts layout).`,
    "2. AUTHOR/UPDATE the .eval.ts cases the plan calls for under apps/web/evals/cases/… — real production code, TDD-authored per the harness conventions, covering both the intended quality and the regressions to catch. A changed model-facing prompt that ships with no associated eval case FAILS this step.",
    `3. Run the RELEVANT SUBSET ONLY (never the full suite), foreground/chunked (single-turn guardrail). \`bunx convex dev\` is already up (the infra guard ensured it). For each case pattern, run: \`cd apps/web && bunx evalite run <pattern> --outputPath=${runJson} --threshold=0\` (one pattern per child; loop + MERGE the JSON if multiple, mirroring evals/lib/bake-off.ts). The final ${runJson} must contain every case that ran.`,
    `4. REFRESH THE BASELINE: regenerate ${baselines} so every run case has an expected averageScore entry that reflects CLEARED scorers. Only baseline a score you confirmed represents the intended quality — do NOT baseline a case that fails its own scorers, and do NOT lower an existing case's baseline to mask a regression (the gate reads main's baseline via \`git show origin/${baseBranch}:${baselines}\`, so lowering the working-tree baseline cannot mask a regression — it will fail and route back here).`,
    `5. SELF-COMMIT ONLY the product/repo files the pipeline's build-artifact commit will NOT stage (these live OUTSIDE build/${feature}): the authored cases (apps/web/evals/cases/**/*.eval.ts) and the refreshed baseline (${baselines}). Do NOT self-commit the build-dir artifacts (eval-plan.md, eval-report.md, eval-run.json, eval-required-cases.json) — those live under build/${feature} and the pipeline commits them, exactly as it does e2e-report.md.`,
    `6. Write ${report} — which cases ran, per-case baselineBefore (main, via git show) vs produced (this run) vs baselineAfter (this build's refreshed baseline), and the regression verdict — the human-readable audit trail.`,
    "7. Record eval-infra gaps as instructed below.",
    "",
    evalInfraObservationsInstruction(buildDir),
    "",
    "End with exactly one of these lines:",
    "EVAL_PASS            — relevant/new cases clear their scorers AND no regression vs main beyond the noise margin AND required coverage met",
    "EVAL_FAIL: <what regressed / which case failed / missing coverage>",
    "Note: a deterministic gate re-checks eval-run.json against main's committed baseline — a hand-waved EVAL_PASS without a real run + committed baseline is rejected.",
  ].join("\n")
}

/**
 * The CONTENT of a minimal `eval-plan.md` the orchestrator writes when the plan
 * loop fails to produce one. Not a prompt — a static template with `reason`
 * interpolated. A planner failure is a PIPELINE limitation, NOT proof the prompt
 * is un-evaluable; instruct execute to derive the changed prompts + subset itself
 * and write its own `eval-required-cases.json` before any verdict.
 */
export function fallbackEvalPlanArtifact(
  reason: string,
  baseBranch = "main",
): string {
  return [
    "# eval plan (fallback)",
    "",
    `**No reviewed eval plan could be authored.** Reason: ${reason}`,
    "",
    "This is an eval PLANNING/PIPELINE limitation — it is NOT proof that the changed",
    "prompt is un-evaluable. Do not treat it as a free pass.",
    "",
    "## What the execute stage must do",
    "",
    "1. Derive the changed model-facing prompts yourself from the diff",
    `   (\`git diff origin/${baseBranch}..HEAD\`), the spec (spec.md), and the implementation`,
    "   record (implementation.md) when present.",
    "2. Map each changed prompt to existing coverage under apps/web/evals/cases/… and",
    "   author/update the cases needed to cover both the intended quality and the",
    "   regressions to catch. WRITE your own eval-required-cases.json coverage contract",
    '   (shape [{ "pattern", "reason" }]) naming the case substrings that must run.',
    "3. Run the RELEVANT SUBSET ONLY (never the whole suite), refresh + commit",
    "   apps/web/evals/baselines.json for every case that ran (only scores you confirmed",
    "   reflect cleared scorers), and write eval-run.json + eval-report.md.",
    "4. Only then: `EVAL_PASS` if the relevant/new cases clear their scorers and there is",
    "   no regression vs main beyond the noise margin and coverage is met, or",
    "   `EVAL_FAIL: <what regressed / which case failed / missing coverage>`.",
    "   A planning failure on its own never emits EVAL_FAIL — but it also never grants an",
    "   EVAL_PASS without a real run + committed baseline.",
  ].join("\n")
}

export type ReviewPromptArgs = {
  feature: string
  buildDir: string
  /** Resolved path to the canonical input spec (spec.md, or legacy design.md). */
  specPath: string
  round: number
  baseBranch: string
}

export function reviewPrompt({
  feature,
  buildDir,
  specPath,
  round,
  baseBranch,
}: ReviewPromptArgs): string {
  const spec = specPath
  const impl = join(buildDir, "implementation.md")
  const out = join(buildDir, "review", `round-${round}.md`)
  const prev = join(buildDir, "review", `round-${round - 1}.md`)
  return [
    `You are the CODE-REVIEW phase (round ${round}) of an autonomous build pipeline for the "${feature}" feature.`,
    "You are a fresh, independent reviewer — you did not write this code.",
    "",
    `1. Read the diff: \`git diff ${baseBranch}...HEAD\`.`,
    `2. Read the canonical spec at ${spec} and the build notes at ${impl}.`,
    round > 1
      ? `3. Read the previous round at ${prev}: the builder responded to each finding (fix + SHA, or pushback). Confirm fixes, weigh pushbacks fairly, and only re-raise what is still genuinely wrong.`
      : "3. Review the diff against the spec for correctness, faithfulness, and quality.",
    `4. Write your findings to ${out}. Tag each finding [blocking], [nit], or [question]. Be specific (file:line + why).`,
    `5. Make the verdict line below the LAST line of ${out} as well, so the run can recover it on resume.`,
    "",
    changelogVerification(),
    "",
    // The distinctness clause lives here, not in the shared helper, because only
    // the review phase produces gated [blocking] findings to keep observations apart from.
    `${observationsInstruction(buildDir)}\nThese are separate from your review findings — never promote an observation into a [blocking] finding to force it into this feature, and conversely never downgrade a real defect in THIS diff to an observation: anything wrong with the diff under review is a finding, not an observation.`,
    "",
    // Backstop for the build phase: if the diff widened+migrated a Convex schema
    // but recorded no narrow follow-up, the reviewer records the schema-narrow
    // observation. Like every observation, it never becomes a [blocking] finding.
    `${schemaNarrowObservationsInstruction(buildDir)}\nThis is a backstop — if the diff widened+migrated a Convex schema (added a field/union literal + backfill) but left no schema-narrow observation recorded, add one. Like every observation, it is never a [blocking] finding.`,
    "",
    "End your output (and the findings file) with exactly one of these lines:",
    "CLEAN               — no blocking findings remain; ready for PR",
    "BLOCKING            — at least one [blocking] finding the builder must address",
    "ESCALATE: <reason>  — you cannot converge (genuine disagreement / repeated thrash / product call)",
  ].join("\n")
}

export type ReviewResponsePromptArgs = {
  feature: string
  buildDir: string
  round: number
}

export function reviewResponsePrompt({
  feature,
  buildDir,
  round,
}: ReviewResponsePromptArgs): string {
  const roundFile = join(buildDir, "review", `round-${round}.md`)
  return [
    `You are the BUILDER responding to code-review round ${round} for the "${feature}" feature.`,
    "",
    singleTurnGuardrail(),
    "",
    `1. Read the reviewer's findings at ${roundFile}.`,
    "2. For each [blocking] finding, respond IN THE SAME FILE, immediately under the finding, with one of:",
    "   - FIX: make the change and commit it, then note the commit SHA.",
    "   - PUSHBACK: explain why it's intentional, wrong, or out of scope (be specific and respectful).",
    "3. Address [nit]s where cheap; you may note [question]s briefly. Blocking items are mandatory.",
    "",
    "Make real code changes and commit them — the validation gate re-runs after you finish.",
    "",
    "When you have responded to every blocking finding, output the exact line:",
    "BUILD_DONE",
    "If you cannot converge with the reviewer (genuine disagreement or repeated thrash on the same point), instead output:",
    "ESCALATE: <one-line reason>",
  ].join("\n")
}

/**
 * The PR phase reuses the existing /pr open skill, then signals completion.
 * When a `linearIssueId` is known, the PR body must carry `Closes <ID>` so
 * Linear's GitHub integration links the PR and auto-resolves the issue on merge.
 *
 * When `sentryShortIds` is non-empty (Sentry-triage builds carry
 * `<!-- sentry-fixes: <SHORT-ID> -->` markers in the spec), the PR must also
 * carry `fixes <SHORT-ID>` so Sentry auto-resolves the issue once the fix ships.
 * This repo squash-merges with `squash_merge_commit_message = COMMIT_MESSAGES`,
 * so the squash commit body is the concatenation of BRANCH commit messages and
 * the PR body is dropped — therefore the keyword must live in a branch commit
 * message, delivered via an empty commit. See plan.md D3.
 */
export function prPrompt(
  feature: string,
  linearIssueId?: string,
  sentryShortIds: string[] = [],
): string {
  return [
    `You are the PR phase of the autonomous build pipeline for the "${feature}" feature.`,
    "",
    singleTurnGuardrail(),
    "",
    "Open the pull request for this branch by running the /pr skill in open mode:",
    "",
    "/pr open",
    "",
    "It rebases/merges main, pushes, and opens (or updates) the PR.",
    ...(linearIssueId
      ? [
          "",
          `After it finishes, ensure the PR body contains the line \`Closes ${linearIssueId}\` so Linear's GitHub integration auto-resolves the issue on merge.`,
          `If the /pr skill's body omits it, add it with \`gh pr edit --body\` (append \`Closes ${linearIssueId}\`, preserving the existing body).`,
        ]
      : []),
    ...(sentryShortIds.length > 0
      ? [
          "",
          "This build fixes Sentry issue(s). This repo squash-merges with `squash_merge_commit_message = COMMIT_MESSAGES`, so Sentry only sees the `fixes <id>` keyword if it is in a BRANCH COMMIT MESSAGE — the PR body is dropped from the squash commit.",
          `After \`/pr open\` finishes, for each id below that is not already present in a commit message on this branch (\`git log --format=%B origin/main..HEAD\`), create an empty commit with that exact id — e.g. for \`${sentryShortIds[0]}\` run \`git commit --allow-empty -m "fixes ${sentryShortIds[0]}"\` — then \`git push\`. The ids: ${sentryShortIds.map((id) => `\`${id}\``).join(", ")}.`,
          `Also append the same line(s) to the PR body with \`gh pr edit --body\` for human visibility (preserving the existing body): ${sentryShortIds.map((id) => `fixes ${id}`).join(", ")}.`,
        ]
      : []),
    "",
    "After it finishes successfully, output the exact line:",
    "BUILD_DONE",
    "If it cannot open the PR (e.g. unresolved merge conflicts that need a human call), instead output:",
    "ESCALATE: <one-line reason>",
  ].join("\n")
}

export type EnsureTicketPromptArgs = {
  feature: string
  /** Current git branch; kickoff loop branches embed the Linear id (<id>-slug). */
  branch: string
  /** Resolved canonical-input path; its contents are the issue-description source of truth. */
  specPath: string
  /** Product team id (Linear). */
  teamId: string
  /** Workflow state id to create the issue in (In-Progress). */
  inProgressStateId: string
  /** Project id, or "" when filing team-scoped (no project). */
  projectId: string
  /** Absolute path the agent must write its JSON result to. */
  resultPath: string
  /** Ranked forward-only buckets over the configured state ids (for the In-Progress advance). */
  stateOrdering: StateBucket[]
  /** When set, the issue is already known — sync-only mode (skip search/create). */
  existingIssueId?: string
  existingIssueUuid?: string
}

/**
 * Prompt for the `/build` ensure-ticket step (Linear MCP). Two modes:
 *
 * - **No-id mode** (no `existingIssueId`): find an existing open issue for this
 *   build by branch-embedded Linear id or a `build/<feature>` marker (NEVER by
 *   fuzzy title); adopt it or create one with the **verbatim spec** as the
 *   description.
 * - **Existing-id mode** (`existingIssueId` set): skip search/create, fetch that
 *   issue, and sync its description to the spec.
 *
 * In both modes the spec↔description comparison is **verbatim** (trim surrounding
 * whitespace only — no footer/marker stripping); on any difference the issue
 * description is rewritten to **exactly match the file** (the human edits the
 * file, so the file wins). The agent reports
 * `{"issueId","issueUuid","title","url","summary"}` JSON to `resultPath` (the
 * latter three orient the dashboard), makes no code changes, and opens no PR.
 */
export function ensureTicketPrompt({
  feature,
  branch,
  specPath,
  teamId,
  inProgressStateId,
  projectId,
  resultPath,
  stateOrdering,
  existingIssueId,
  existingIssueUuid,
}: EnsureTicketPromptArgs): string {
  const hasProject = projectId !== ""
  const marker = `build/${feature}`
  const advanceToInProgress = forwardOnlyRuleText({
    ordering: stateOrdering,
    targetStateId: inProgressStateId,
    targetRank: 1,
    targetLabel: "In-Progress",
  })
  const header = [
    "You are the ENSURE-TICKET step of the autonomous build pipeline. Use the Linear MCP.",
    `Feature: ${feature}`,
    `Branch: ${branch}`,
    `Team id: ${teamId}`,
    ...(hasProject ? [`Project: ${projectId}`] : []),
    `In-Progress state id: ${inProgressStateId}`,
    `Spec file (source of truth for the description): ${specPath}`,
    "",
    `1. Read the VERBATIM spec at ${specPath}. This is the source of truth for the Linear issue description on the /build (file → ticket) path.`,
  ]

  const verbatimRule = [
    "Description sync (file wins): compare the issue description to the spec contents VERBATIM, trimming only surrounding whitespace — no other normalization.",
    "If they differ, update the description to EXACTLY match the spec file — the human edits the file, so the file wins.",
  ]

  const modeSteps = existingIssueId
    ? [
        `2. EXISTING-ISSUE MODE — the issue is already known: ${existingIssueId} (uuid ${existingIssueUuid ?? "unknown"}).`,
        "   Skip search and create entirely. Do NOT search for or create any issue — fetch this existing issue directly.",
        `   ${verbatimRule[0]}`,
        `   ${verbatimRule[1]}`,
        `3. Forward-only advance this adopted issue to In-Progress:\n${advanceToInProgress}`,
        `4. Record this same issue: id ${existingIssueId}${existingIssueUuid ? `, uuid ${existingIssueUuid}` : ""}. Go to the final step.`,
      ]
    : [
        `2. Search the team (id ${teamId}) for an existing OPEN issue for this build. Match ONLY by:`,
        `   (a) a Linear issue identifier embedded in the branch name "${branch}" (kickoff loop branches look like <id>-slug), OR`,
        `   (b) the literal marker "${marker}" appearing in an issue description.`,
        "   Do NOT fuzzy-match on title — only (a) or (b) count as a match.",
        `3. If found: adopt it. ${verbatimRule[0]} ${verbatimRule[1]} Then forward-only advance this adopted issue to In-Progress:\n${advanceToInProgress}\n   Record its id + uuid.`,
        `4. If NOT found: create an issue — team ${teamId}, state ${inProgressStateId}${hasProject ? `, project ${projectId}` : ""}, title = a humanized form of "${feature}", description = the VERBATIM spec contents (add nothing — no header, no marker). Record its id + uuid.`,
      ]

  const tail = [
    "5. Capture orientation fields for the build dashboard from the issue you settled on in the step above (after the fetch/sync decision — the description the file won, the adopted issue, or the one you just created — never an earlier or unsynced copy):",
    "   - title: the issue's title.",
    "   - url: the issue's canonical Linear URL.",
    "   - summary: the first one-to-two sentences of that issue description, as a single short line.",
    `6. Write EXACTLY this JSON shape (and only valid JSON) to ${resultPath}:`,
    '   {"issueId":"PRO-123","issueUuid":"<uuid>","title":"<issue title>","url":"<issue url>","summary":"<1-2 sentence summary>"}',
    "Make no code changes and open no PR. Your only side effects are the Linear write(s) and the result file.",
  ]

  return [...header, ...modeSteps, ...tail].join("\n")
}

export type InReviewMovePromptArgs = {
  feature: string
  /** Human issue ref (e.g. PRO-123). */
  issueId: string
  /** Optional uuid — when present the agent fetches by uuid for an exact match. */
  issueUuid?: string
  /** Workflow state id to advance the ticket to (In Review). */
  inReviewStateId: string
  /** Ranked forward-only buckets over the configured state ids. */
  stateOrdering: StateBucket[]
  /** Absolute path the agent must write its JSON result to. */
  resultPath: string
}

/**
 * Prompt for the `/build` In-Review move step (Linear MCP), fired when the build
 * enters the `monitor` phase. Mirrors `ensureTicketPrompt`'s shape: it hands the
 * agent the ranked buckets + the forward-only rule and asks for a deterministic
 * id lookup, then advances the issue to In Review ONLY from rank 0/1. Reports
 * `{"moved":bool}` to `resultPath`, makes no code changes, and opens no PR.
 */
export function inReviewMovePrompt({
  feature,
  issueId,
  issueUuid,
  inReviewStateId,
  stateOrdering,
  resultPath,
}: InReviewMovePromptArgs): string {
  const advanceToInReview = forwardOnlyRuleText({
    ordering: stateOrdering,
    targetStateId: inReviewStateId,
    targetRank: 2,
    targetLabel: "In Review",
  })
  return [
    `You are the IN-REVIEW MOVE step of the autonomous build pipeline for the "${feature}" feature. Use the Linear MCP.`,
    "Make no code changes and open no PR. Your only side effects are the Linear write (if any) and the result file.",
    issueUuid
      ? `1. Fetch the issue ${issueId} by its uuid ${issueUuid} (for an exact match) and read its CURRENT workflow state id (the \`state.id\` field).`
      : `1. Fetch the issue ${issueId} and read its CURRENT workflow state id (the \`state.id\` field).`,
    `2. ${advanceToInReview}`,
    `3. Write EXACTLY this JSON shape (and only valid JSON) to ${resultPath}:`,
    '   {"moved":true}   — if you changed the state to In Review',
    '   {"moved":false}  — if you left it (already at/past In Review, or unrecognized)',
  ].join("\n")
}

/** Builder prompt for a failing-CI fix during the monitor loop. */
export function monitorCiFixPrompt(
  feature: string,
  failingChecks: string[],
): string {
  return [
    `You are the BUILDER fixing failing CI for the "${feature}" PR during build monitoring.`,
    "",
    singleTurnGuardrail(),
    "",
    `Failing checks: ${failingChecks.join(", ")}`,
    "",
    "1. For each failing check, run `gh run view <run-id> --log-failed` (find run ids via `gh run list`) to read the failure.",
    "2. Fix the root cause locally — do not disable tests or weaken assertions.",
    "3. Run the relevant local checks (bun run lint, bun run typecheck, targeted tests).",
    "4. Commit with a message naming what failed and why the fix works, then push.",
    "",
    "When the fix is pushed, output the exact line:",
    "BUILD_DONE",
    "If the failure needs human judgment, instead output:",
    "ESCALATE: <one-line reason>",
  ].join("\n")
}

/** Builder prompt that delegates unresolved-thread handling to /address-review. */
export function monitorAddressReviewPrompt(
  feature: string,
  prNumber: number,
): string {
  return [
    `You are the BUILDER addressing PR review threads for the "${feature}" PR during build monitoring.`,
    "",
    singleTurnGuardrail(),
    "",
    `Run the /address-review skill for PR #${prNumber}:`,
    "",
    `/address-review ${prNumber}`,
    "",
    "It reads unresolved threads, classifies each as Fix or Pushback, commits and pushes fixes, and posts pushback replies. Do NOT resolve threads — the cloud review agent owns resolution.",
    "",
    "When it finishes, output the exact line:",
    "BUILD_DONE",
    "If a thread needs human product judgment, instead output:",
    "ESCALATE: <one-line reason>",
  ].join("\n")
}
