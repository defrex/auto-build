/**
 * Agent prompt builders for the kickoff loop.
 *
 * Only the kickoff run spawns an agent from code (the select+claim step), so this
 * module owns that prompt as the single, testable source of truth for the
 * agent↔TS contract. The harvest/triage ingesters are skill-driven (their agent
 * instructions live in their `SKILL.md`), so their prompts are not built here.
 *
 * The select agent writes a JSON result file (the same "agent writes a file, TS
 * parses it" contract the build reviewer uses via `last-message.txt`). It must
 * respect capacity and claim (move to In-Progress) BEFORE the build starts, so a
 * crash or re-run can never double-launch.
 */

import type { KickoffConfig } from "./config"

export type KickoffSelectPromptArgs = {
  config: KickoffConfig
  /** Absolute path the agent must write its JSON result to. */
  resultPath: string
}

/**
 * Prompt for the kickoff run's select+claim subprocess. Tells the agent exactly
 * which Linear states/labels to use (from config), to honor the concurrency
 * cap, to claim the chosen issue before returning, and to emit a strict JSON
 * result the kickoff run can parse.
 */
export function kickoffSelectPrompt({
  config,
  resultPath,
}: KickoffSelectPromptArgs): string {
  const { linear, maxConcurrentBuilds } = config
  const hasProject = linear.projectId !== ""
  const scope = hasProject ? "for this team/project" : "for this team"
  return [
    "You are the SELECT step of the kickoff loop. Use the Linear MCP.",
    "Your job: pick at most ONE issue to build, claim it, and report.",
    "",
    hasProject
      ? `Team: ${linear.teamId}  Project: ${linear.projectId}`
      : `Team: ${linear.teamId}`,
    `Ready state id: ${linear.readyStateId}`,
    `In-Progress state id: ${linear.inProgressStateId}`,
    `Needs-definition label id (EXCLUDE these): ${linear.needsDefinitionLabelId}`,
    `Max concurrent builds: ${maxConcurrentBuilds}`,
    "",
    "Steps:",
    `1. Count issues currently in the In-Progress state (id ${linear.inProgressStateId}) ${scope}. Call it inProgressCount.`,
    `2. If inProgressCount >= ${maxConcurrentBuilds}, DO NOT claim anything. Write {"none": true, "atCapacity": true} to the result file and stop.`,
    `3. Otherwise find issues in the Ready state (id ${linear.readyStateId}) that do NOT carry the needs-definition label (id ${linear.needsDefinitionLabelId}). EXCLUDE any issue carrying that label even if it is in Ready. Never pick an issue already In-Progress or in a terminal state.`,
    '4. If none qualify, write {"none": true} to the result file and stop.',
    `5. Pick exactly one (prefer higher priority, then older). IMMEDIATELY move it to the In-Progress state (id ${linear.inProgressStateId}) — claim it before building.`,
    "6. Read its title and full description (the brief). Determine its source from its label (observations vs sentry).",
    "7. Write this exact JSON shape to the result file:",
    '   {"inProgressCount": <number>, "issueId": "DIS-123", "issueUuid": "<uuid>", "title": "<title>", "brief": "<full description>", "source": "observations|sentry"}',
    "",
    `Write the JSON (and ONLY valid JSON) to: ${resultPath}`,
    "Do not edit any code. Do not open a PR. Your only side effect is the Linear state change and the result file.",
  ].join("\n")
}
