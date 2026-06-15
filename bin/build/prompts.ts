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

export type PlanPromptArgs = {
  feature: string
  buildDir: string
  /** Resolved path to the canonical input spec (spec.md, or legacy design.md). */
  specPath: string
  /** True when re-planning after a NEEDS_REVISION verdict. */
  revising: boolean
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
    `1. Read the approved spec at ${spec} — it is the canonical target. Everything you plan must serve it.`,
    revising
      ? `2. This is a revision. Read the reviewer's critique at ${planReview} and address every point it raises.`
      : "2. Explore the codebase to ground the plan in real files, patterns, and conventions.",
    `3. Write a concrete, step-by-step coding plan to ${plan}. Reference actual files (path:line), describe the changes, call out tests (red/green TDD), and note any risks or sequencing constraints.`,
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
  return [
    `You are the PLAN-REVIEW phase of an autonomous build pipeline for the "${feature}" feature.`,
    "You are a fresh, independent reviewer with no knowledge of how the plan's author reasoned — that independence is the point.",
    "",
    `1. Read ${spec} — this is the CANONICAL target. Judge strictly against it.`,
    `2. Read the coding plan at ${plan}.`,
    `3. Critique the plan: does it fully and faithfully realise the spec? Look for missing steps, hidden dependencies, incorrect assumptions, scope creep, untested paths, and simpler alternatives.`,
    `4. Write your critique to ${out}.`,
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
    `1. Read the approved plan at ${plan} and the canonical spec at ${spec}.`,
    validateFailuresPath
      ? `2. The validation gate FAILED on the last build. Read the captured failure output at ${validateFailuresPath} and fix the root cause — do not weaken tests or silence errors.`
      : "2. Implement the plan. Follow the repo's conventions (red/green TDD, Biome style, CLAUDE.md rules).",
    `3. Record what you built and any divergences from the plan in ${impl}.`,
    "4. Commit your work with clear messages.",
    "",
    observationsInstruction(buildDir),
    "",
    "When the implementation is complete, output the exact line:",
    "BUILD_DONE",
    "If you are genuinely blocked (the plan is unbuildable as written, or a decision needs human judgment), instead output:",
    "ESCALATE: <one-line reason>",
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
    // The distinctness clause lives here, not in the shared helper, because only
    // the review phase produces gated [blocking] findings to keep observations apart from.
    `${observationsInstruction(buildDir)}\nThese are separate from your review findings — never promote an observation into a [blocking] finding to force it into this feature, and conversely never downgrade a real defect in THIS diff to an observation: anything wrong with the diff under review is a finding, not an observation.`,
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
 */
export function prPrompt(feature: string, linearIssueId?: string): string {
  return [
    `You are the PR phase of the autonomous build pipeline for the "${feature}" feature.`,
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
    "",
    "After it finishes successfully, output the exact line:",
    "BUILD_DONE",
    "If it cannot open the PR (e.g. unresolved merge conflicts that need a human call), instead output:",
    "ESCALATE: <one-line reason>",
  ].join("\n")
}

export type EnsureTicketPromptArgs = {
  feature: string
  /** Current git branch; kickoff loop branches embed the Linear id (kickoff/<id>-slug). */
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
 * file, so the file wins). The agent reports `{"issueId","issueUuid"}` JSON to
 * `resultPath`, makes no code changes, and opens no PR.
 */
export function ensureTicketPrompt({
  feature,
  branch,
  specPath,
  teamId,
  inProgressStateId,
  projectId,
  resultPath,
  existingIssueId,
  existingIssueUuid,
}: EnsureTicketPromptArgs): string {
  const hasProject = projectId !== ""
  const marker = `build/${feature}`
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
        `3. Record this same issue: id ${existingIssueId}${existingIssueUuid ? `, uuid ${existingIssueUuid}` : ""}. Go to the final step.`,
      ]
    : [
        `2. Search the team (id ${teamId}) for an existing OPEN issue for this build. Match ONLY by:`,
        `   (a) a Linear issue identifier embedded in the branch name "${branch}" (kickoff loop branches look like kickoff/<id>-slug), OR`,
        `   (b) the literal marker "${marker}" appearing in an issue description.`,
        "   Do NOT fuzzy-match on title — only (a) or (b) count as a match.",
        `3. If found: adopt it. ${verbatimRule[0]} ${verbatimRule[1]} Record its id + uuid.`,
        `4. If NOT found: create an issue — team ${teamId}, state ${inProgressStateId}${hasProject ? `, project ${projectId}` : ""}, title = a humanized form of "${feature}", description = the VERBATIM spec contents (add nothing — no header, no marker). Record its id + uuid.`,
      ]

  const tail = [
    `${existingIssueId ? "4" : "5"}. Write EXACTLY this JSON shape (and only valid JSON) to ${resultPath}:`,
    '   {"issueId":"PRO-123","issueUuid":"<uuid>"}',
    "Make no code changes and open no PR. Your only side effects are the Linear write(s) and the result file.",
  ]

  return [...header, ...modeSteps, ...tail].join("\n")
}

/** Builder prompt for a failing-CI fix during the monitor loop. */
export function monitorCiFixPrompt(
  feature: string,
  failingChecks: string[],
): string {
  return [
    `You are the BUILDER fixing failing CI for the "${feature}" PR during build monitoring.`,
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
