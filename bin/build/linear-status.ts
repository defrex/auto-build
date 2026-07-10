/**
 * Advance a build's Linear ticket to In Review when the build enters the
 * `monitor` phase — best-effort, never blocking (mirrors `linear-ticket.ts`).
 *
 * Splits a **pure gate** (`shouldAdvanceToInReview`) and a **pure parser**
 * (`parseInReviewResult`) from the **impure agent step**
 * (`advanceTicketToInReview`, with the agent injected). The forward-only
 * ordering is handed to the prompt as ranked buckets (see `linear-state-order`)
 * so the agent does a deterministic id lookup, not a judgment.
 *
 * The hard rule (spec): ticketing must NEVER block a build. Every failure path
 * logs a visible warning to `build.log` and returns — no throw, no escalate, no
 * `NEEDS-INPUT.md`. There is no state mutation: `linearIssueId/uuid` are already
 * recorded by the ensure-ticket step.
 */

import { join } from "node:path"
import type { LinearConfig } from "../kickoff/config"
import { orderedStateBuckets } from "./linear-state-order"
import { inReviewMovePrompt } from "./prompts"
import type { BuildState } from "./state"

export type InReviewDecision =
  | { skip: true; reason: string }
  | { skip: false; proceed: true }

/**
 * Gate (pure): need a pinned `inReviewStateId` AND a recorded `linearIssueId`
 * (the human ref — the Linear MCP can fetch by it). The uuid is NOT required by
 * the gate; it is only a precision hint passed through to the prompt.
 */
export function shouldAdvanceToInReview(args: {
  inReviewStateId: string
  linearIssueId?: string
}): InReviewDecision {
  if (!args.inReviewStateId.trim()) {
    return {
      skip: true,
      reason: "In-Review state id not pinned — skipping In-Review move",
    }
  }
  if (!args.linearIssueId?.trim()) {
    return {
      skip: true,
      reason: "no linearIssueId recorded — skipping In-Review move",
    }
  }
  return { skip: false, proceed: true }
}

/**
 * Parse the agent's `{"moved":bool}` result (pure). Returns `null` on malformed
 * JSON or a missing/non-boolean `moved` field.
 */
export function parseInReviewResult(raw: string): { moved: boolean } | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (typeof obj.moved !== "boolean") return null
    return { moved: obj.moved }
  } catch {
    return null
  }
}

export type InReviewDeps = {
  /** Run the In-Review move agent; resolve with its exit code + the result-file contents. */
  runStatusAgent: (args: {
    prompt: string
    resultPath: string
  }) => Promise<{ code: number; resultRaw: string | null }>
  /** Log a (visible) line into build.log. */
  log: (message: string) => void
}

export type AdvanceInReviewArgs = {
  buildDir: string
  feature: string
  linear: LinearConfig
  state: BuildState
}

/** Absolute path to the In-Review agent's result file (under gitignored `.build/`). */
export function inReviewResultPath(buildDir: string): string {
  return join(buildDir, ".build", "in-review-result.json")
}

/**
 * Forward-only advance this build's ticket to In Review (best-effort). Never
 * throws — every failure logs a warning and returns. Returns `void`: the move is
 * a Linear side effect; no `state.json` field changes.
 */
export async function advanceTicketToInReview(
  args: AdvanceInReviewArgs,
  deps: InReviewDeps,
): Promise<void> {
  const { buildDir, feature, linear, state } = args
  try {
    const decision = shouldAdvanceToInReview({
      inReviewStateId: linear.inReviewStateId,
      linearIssueId: state.linearIssueId,
    })
    if (decision.skip) {
      deps.log(`⚠ in-review-move: ${decision.reason}`)
      return
    }

    const resultPath = inReviewResultPath(buildDir)
    // `decision.skip === false` guarantees a non-empty linearIssueId.
    const issueId = state.linearIssueId as string
    const prompt = inReviewMovePrompt({
      feature,
      issueId,
      issueUuid: state.linearIssueUuid,
      inReviewStateId: linear.inReviewStateId,
      stateOrdering: orderedStateBuckets(linear),
      resultPath,
    })

    const { code, resultRaw } = await deps.runStatusAgent({
      prompt,
      resultPath,
    })
    if (code !== 0) {
      deps.log(
        `⚠ in-review-move: agent exited ${code} — continuing without a ticket change`,
      )
      return
    }
    const parsed = resultRaw === null ? null : parseInReviewResult(resultRaw)
    if (!parsed) {
      deps.log(
        `In-Review move: completed (result unreadable) for ${issueId} — continuing`,
      )
      return
    }
    if (parsed.moved) {
      deps.log(`In-Review move: advanced ${issueId} to In Review`)
    } else {
      deps.log(`In-Review move: ${issueId} already at/past In Review — no-op`)
    }
  } catch (err) {
    deps.log(
      `⚠ in-review-move: failed (${(err as Error).message}) — continuing`,
    )
  }
}
