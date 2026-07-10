/**
 * Ensure (and sync) a Linear ticket for a build — best-effort, never blocking.
 *
 * Splits a **pure decision** (`shouldEnsureTicket` — the config-pin gate) and a
 * **pure parser** (`parseEnsureResult`) from the **impure agent step**
 * (`ensureLinearTicket`, with the agent injected), exactly like
 * `bin/kickoff/kickoff.ts`. Identity-find and description-sync are one
 * best-effort step that runs on **every** launch — including when an id is
 * already recorded — so a human spec edit before a re-run propagates (file wins).
 *
 * The hard rule (design): ticketing must NEVER block a build. Every failure
 * path here logs a visible warning to `build.log` and returns the input state
 * unchanged — no throw, no escalate, no retry-loop. The orchestrator persists
 * the returned state via `writeState`.
 */

import { join } from "node:path"
import type { KickoffConfig } from "../kickoff/config"
import { orderedStateBuckets } from "./linear-state-order"
import { ensureTicketPrompt } from "./prompts"
import type { BuildState } from "./state"

/** The config-pin gate inputs: only team + In-Progress state are required. */
export type EnsureTicketConfig = {
  teamId: string
  inProgressStateId: string
  projectId: string
}

export type EnsureDecision =
  | { skip: true; reason: string }
  | { skip: false; proceed: true }

/**
 * Decide whether to run the ensure-ticket step (pure). Gates ONLY on the config
 * pin (team + In-Progress state). It does NOT consult `linearIssueId` — sync
 * must still run when an id already exists.
 */
export function shouldEnsureTicket(config: EnsureTicketConfig): EnsureDecision {
  if (!config.teamId.trim()) {
    return {
      skip: true,
      reason:
        "Linear config not pinned (no teamId) — skipping ticket creation/sync",
    }
  }
  if (!config.inProgressStateId.trim()) {
    return {
      skip: true,
      reason:
        "Linear config not pinned (no inProgressStateId) — skipping ticket creation/sync",
    }
  }
  return { skip: false, proceed: true }
}

/** Hard cap for a persisted Linear summary so `state.json` stays bounded. */
export const MAX_SUMMARY_CHARS = 240

/**
 * Normalize an agent-supplied summary so it can't distort the panel (pure):
 * trim, collapse internal whitespace/newlines to single spaces, and truncate to
 * `MAX_SUMMARY_CHARS` (replacing the tail with `…`).
 */
export function capSummary(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, " ")
  if (collapsed.length <= MAX_SUMMARY_CHARS) return collapsed
  return `${collapsed.slice(0, MAX_SUMMARY_CHARS - 1)}…`
}

/** A parsed ensure-ticket result: id/uuid required, orientation fields optional. */
export type EnsureResult = {
  issueId: string
  issueUuid: string
  title?: string
  url?: string
  summary?: string
}

/**
 * Read `key` from `obj` only when it is a string that is non-empty after
 * trimming, returning the trimmed value (else `undefined`). Whitespace-only
 * values are treated as absent so they can't render a blank/malformed header.
 */
function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed !== "" ? trimmed : undefined
}

/**
 * Parse the agent's result JSON (pure). `issueId`/`issueUuid` are required —
 * returns `null` on malformed JSON or a missing/empty id (empty after trim, so
 * a whitespace-only id fails parse). `title`/`url`/`summary` are optional:
 * absent/empty/whitespace-only/non-string values are simply omitted (never a
 * parse failure), and `summary` is run through `capSummary` so it stays bounded.
 */
export function parseEnsureResult(raw: string): EnsureResult | null {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    const issueId = optionalString(obj, "issueId")
    const issueUuid = optionalString(obj, "issueUuid")
    if (issueId === undefined) return null
    if (issueUuid === undefined) return null
    const title = optionalString(obj, "title")
    const url = optionalString(obj, "url")
    const summaryRaw = optionalString(obj, "summary")
    const summary =
      summaryRaw !== undefined ? capSummary(summaryRaw) : undefined
    return {
      issueId,
      issueUuid,
      ...(title !== undefined ? { title } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(summary !== undefined && summary !== "" ? { summary } : {}),
    }
  } catch {
    return null
  }
}

export type EnsureTicketDeps = {
  /** Run the ensure-ticket agent; resolve with its exit code + the result-file contents. */
  runEnsureAgent: (args: {
    prompt: string
    resultPath: string
  }) => Promise<{ code: number; resultRaw: string | null }>
  /** Log a (visible) line into build.log. */
  log: (message: string) => void
}

export type EnsureTicketArgs = {
  buildDir: string
  specPath: string
  feature: string
  config: KickoffConfig
  state: BuildState
}

/** Absolute path to the ensure-ticket agent's result file (under gitignored `.build/`). */
export function ensureResultPath(buildDir: string): string {
  return join(buildDir, ".build", "ensure-ticket-result.json")
}

/**
 * Ensure a Linear ticket exists for this build and its description is synced to
 * the spec (best-effort). Returns the (possibly updated) state; the orchestrator
 * persists it. Never throws — every failure logs a warning and returns the input
 * state unchanged.
 */
export async function ensureLinearTicket(
  args: EnsureTicketArgs,
  deps: EnsureTicketDeps,
): Promise<BuildState> {
  const { buildDir, specPath, feature, config, state } = args
  try {
    const decision = shouldEnsureTicket(config.linear)
    if (decision.skip) {
      deps.log(`⚠ ensure-ticket: ${decision.reason}`)
      return state
    }

    const resultPath = ensureResultPath(buildDir)
    const prompt = ensureTicketPrompt({
      feature,
      branch: state.branch,
      specPath,
      teamId: config.linear.teamId,
      inProgressStateId: config.linear.inProgressStateId,
      projectId: config.linear.projectId,
      resultPath,
      stateOrdering: orderedStateBuckets(config.linear),
      existingIssueId: state.linearIssueId,
      existingIssueUuid: state.linearIssueUuid,
    })

    const { code, resultRaw } = await deps.runEnsureAgent({
      prompt,
      resultPath,
    })
    if (code !== 0) {
      deps.log(
        `⚠ ensure-ticket: agent exited ${code} — continuing without a ticket change`,
      )
      return state
    }
    const parsed = resultRaw === null ? null : parseEnsureResult(resultRaw)
    if (!parsed) {
      deps.log(
        "⚠ ensure-ticket: agent wrote no valid result — continuing without a ticket change",
      )
      return state
    }
    return {
      ...state,
      linearIssueId: parsed.issueId,
      linearIssueUuid: parsed.issueUuid,
      ...(parsed.title !== undefined ? { linearTitle: parsed.title } : {}),
      ...(parsed.summary !== undefined
        ? { linearSummary: parsed.summary }
        : {}),
      ...(parsed.url !== undefined ? { linearUrl: parsed.url } : {}),
    }
  } catch (err) {
    deps.log(
      `⚠ ensure-ticket: failed (${(err as Error).message}) — continuing without a ticket change`,
    )
    return state
  }
}
