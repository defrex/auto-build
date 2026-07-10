/**
 * Pure builder for the adversarial review prompt handed to `codex exec`.
 *
 * The prompt sets a skeptical posture (refute, don't rubber-stamp), tells Codex
 * it may READ the repo but must not write it (also enforced structurally — the
 * run is in a throwaway worktree), embeds the brief + evidence verbatim, renders
 * how prior holes were resolved (round ≥ 2) so repeats are judged not re-raised
 * blindly, and pins the exact JSON output contract from `adversarial-review-verdict`.
 */

import type { ReviewRound } from "./adversarial-review-verdict"

export type ReviewPromptInput = {
  shortId: string
  /** Proposed root-cause hypothesis + fix direction (markdown). */
  brief: string
  /** Sentry/Convex evidence the skill gathered. */
  evidence: string
  /** Completed rounds: holes + how each was resolved. */
  priorRounds: ReviewRound[]
  round: number
}

/** Render the prompt for a single review round. */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const { shortId, brief, evidence, priorRounds, round } = input

  const sections: string[] = [
    "You are an adversarial reviewer of a proposed bug diagnosis and fix.",
    "Your job is to try to REFUTE this diagnosis and fix — do not rubber-stamp.",
    "Default to finding holes unless the evidence genuinely closes them.",
    "",
    "You CAN and SHOULD read the repository to verify the named mechanism is",
    "actually in the code, that the proposed fix makes sense against what is",
    "there, and that no code path is overlooked. READ-ONLY — do not edit, write,",
    "modify, or commit any files.",
    "",
    `## Candidate ticket (Sentry ${shortId}) — round ${round}`,
    "",
    "### Proposed brief (root-cause hypothesis + fix direction)",
    "",
    brief,
    "",
    "### Evidence gathered (Sentry / Convex — the reviewer cannot reach this directly)",
    "",
    evidence,
  ]

  if (round >= 2 && priorRounds.length > 0) {
    sections.push(
      "",
      SCOPE_FOR_LATER_ROUNDS,
      "",
      renderPriorRounds(priorRounds),
    )
  }

  sections.push("", OUTPUT_CONTRACT)

  return sections.join("\n")
}

/**
 * Round-≥2 scope narrowing + the machine-readable resolution contract. Round 1
 * keeps the full skeptical posture; from round 2 the broad completeness pass is
 * done, so new holes must be material to the diagnosis/fix being wrong, and the
 * reviewer must judge every prior hole in `resolutions`.
 */
const SCOPE_FOR_LATER_ROUNDS = [
  "## Scope for this round",
  "",
  "You have already done the broad skeptical pass. In this round, only raise a",
  "*new* hole if it shows the **diagnosis or fix direction is wrong**. Do not",
  "raise completeness / robustness / hardening nitpicks now — those belonged to",
  "round 1.",
  "",
  "For **every** prior hole listed below, emit an entry in `resolutions` with",
  "`accepted` true/false and a one-line `reason`. Put only genuinely-new holes in",
  "`holes`.",
  "",
  "If you accept every prior resolution and have no new hole, return `verdict:",
  '"sufficient"`.',
].join("\n")

/** Render the "Prior rounds" section so Codex judges resolutions, not blindly re-raises. */
function renderPriorRounds(priorRounds: ReviewRound[]): string {
  const lines: string[] = [
    "## Prior rounds",
    "",
    "These holes were raised earlier and the author responded to each. Judge",
    "whether each response actually closes the hole. If you are re-raising a hole",
    "from a prior round because its resolution is inadequate, reuse that hole's",
    "exact `id` and `claim` so it is recognized as the same hole.",
    "",
  ]
  for (const r of priorRounds) {
    lines.push(`### Round ${r.round}`)
    for (const res of r.resolutions) {
      lines.push(
        `- hole \`${res.hole.id}\` (${res.hole.severity}): ${res.hole.claim}`,
        `  - status: ${res.status}`,
        `  - response: ${res.response || "(no response — still open)"}`,
      )
    }
    // Holes with no recorded resolution (defensive — should not normally happen).
    for (const h of r.holes) {
      if (!r.resolutions.some((res) => res.hole.id === h.id)) {
        lines.push(
          `- hole \`${h.id}\` (${h.severity}): ${h.claim}`,
          "  - status: open",
          "  - response: (no response recorded)",
        )
      }
    }
  }
  return lines.join("\n")
}

const OUTPUT_CONTRACT = [
  "## Output contract (REQUIRED)",
  "",
  "End your final message with a single fenced json block matching this shape:",
  "",
  "```json",
  "{",
  '  "verdict": "sufficient" | "holes",',
  '  "holes": [',
  "    {",
  '      "id": "short-stable-slug",',
  '      "claim": "the specific claim under attack",',
  '      "weakness": "why it is weak or unsupported",',
  '      "resolution": "the SPECIFIC evidence or change that would resolve it",',
  '      "severity": "low" | "medium" | "high"',
  "    }",
  "  ],",
  '  "resolutions": [',
  "    {",
  '      "id": "prior-hole-id",',
  '      "accepted": true | false,',
  '      "reason": "one line: why the resolution closes it, or why it is still open"',
  "    }",
  "  ],",
  '  "confidence": "low" | "medium" | "high",',
  '  "summary": "one-paragraph summary of your review"',
  "}",
  "```",
  "",
  "Rules:",
  '- Use "sufficient" only when the diagnosis and fix are genuinely well-supported;',
  "  then `holes` is an empty array and every `resolutions` entry is `accepted`.",
  '- Use "holes" with one entry per unresolved concern. For each hole, `resolution`',
  "  must name the SPECIFIC evidence or change that would close it (so the author",
  "  knows exactly what to fetch or revise), and `id` must be a short stable slug.",
  "- `resolutions` is your accept/reject judgment on prior-round holes. From round",
  "  2 on you MUST include one entry per prior hole (`id`, `accepted`, `reason`);",
  "  put only genuinely-new holes in `holes`. Round 1 leaves `resolutions` empty.",
  "- When re-raising a prior hole, reuse its exact `id` and `claim`.",
].join("\n")
