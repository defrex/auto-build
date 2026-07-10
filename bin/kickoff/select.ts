/**
 * Deterministic claim-select runner — replaces the headless `claude` + Linear
 * MCP select agent.
 *
 * Orchestrates the impure boundary around the pure {@link decideSelection} core:
 * count In-Progress issues (capacity gate), fetch Ready candidates with their
 * labels + blocked-by relations, decide, then CLAIM the chosen issue (move it to
 * In-Progress) before returning. The claim happens AFTER the decision and BEFORE
 * assembling the result so the issue is always In-Progress before the build
 * starts — a crash/re-run can never double-launch (the invariant the kickoff
 * loop relies on).
 *
 * Failures SURFACE: a transport/auth error or a `success:false` claim throws,
 * which rides the existing `runSelect` → kickoff "treat as failure, not empty
 * queue" path. Only a genuinely empty/blocked queue returns `{none:true}`.
 */

import type { KickoffConfig, LinearConfig } from "./config"
import { extractDeferMarker, isDeferred, parseDeferUntil } from "./defer"
import type { LinearGraphql } from "./linear-client"
import {
  decideSelection,
  type LinearIssueLite,
  type SelectDecisionConfig,
} from "./select-decision"

/** The select result contract shared with `kickoff.ts` (re-declared to avoid a
 * cycle — `kickoff.ts` imports this module). */
export type SelectResult =
  | { none: true; atCapacity?: boolean }
  | {
      none?: false
      inProgressCount: number
      issueId: string
      issueUuid: string
      title: string
      brief: string
      source: "observations" | "sentry" | "groomed"
    }

export type SelectDeps = {
  graphql: LinearGraphql
  log: (message: string) => void
  /** Wall clock for the deferral gate, injected for deterministic tests.
   * Defaults to `Date.now`. */
  now?: () => number
}

/** Page size for the bounded paginated reads. */
const PAGE_SIZE = 50
/** Defensive page cap so a pathological state can't loop forever. */
const MAX_PAGES = 20

type PageInfo = { hasNextPage: boolean; endCursor: string | null }
type IssueConnection<T> = { issues: { nodes: T[]; pageInfo: PageInfo } }

type RawRelation = {
  type: string
  issue: { id: string; state: { type: string } | null } | null
}
type RawReadyIssue = {
  id: string
  identifier: string
  title: string
  description: string | null
  priority: number
  createdAt: string
  labels: { nodes: { id: string }[] }
  inverseRelations: { nodes: RawRelation[] }
}

/** GraphQL filter for issues in a given workflow state, scoped to the team (and
 * project when one is pinned). `excludeNeedsDefinition` adds the label gate. */
function issueFilter(
  linear: LinearConfig,
  stateId: string,
  opts: { excludeNeedsDefinition?: boolean } = {},
): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    team: { id: { eq: linear.teamId } },
    state: { id: { eq: stateId } },
  }
  if (linear.projectId !== "") {
    filter.project = { id: { eq: linear.projectId } }
  }
  if (opts.excludeNeedsDefinition) {
    // Linear's IssueLabelCollectionFilter has no `none`; "carries no label X" is
    // expressed as "EVERY label has id != X" (vacuously true for label-less
    // issues), verified against the live API.
    filter.labels = { every: { id: { neq: linear.needsDefinitionLabelId } } }
  }
  return filter
}

const IN_PROGRESS_COUNT_QUERY = `
query KickoffInProgressCount($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: ${PAGE_SIZE}, after: $after) {
    nodes { id }
    pageInfo { hasNextPage endCursor }
  }
}`

const READY_CANDIDATES_QUERY = `
query KickoffReadyCandidates($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: ${PAGE_SIZE}, after: $after, orderBy: createdAt) {
    nodes {
      id
      identifier
      title
      description
      priority
      createdAt
      labels(first: ${PAGE_SIZE}) { nodes { id } }
      inverseRelations(first: ${PAGE_SIZE}) {
        nodes { type issue { id state { type } } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`

const CLAIM_MUTATION = `
mutation KickoffClaimIssue($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) {
    success
    issue { id state { id type } }
  }
}`

/** Walk an `issues` connection page by page, collecting every node (bounded).
 * On hitting the defensive page cap with more pages still available, logs a
 * warning rather than silently truncating (a partial Ready set could pass over a
 * claimable ticket). */
async function collectIssues<T>(
  graphql: LinearGraphql,
  query: string,
  filter: Record<string, unknown>,
  log: (m: string) => void,
  label: string,
): Promise<T[]> {
  const nodes: T[] = []
  let after: string | null = null
  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
    const data: IssueConnection<T> = await graphql(query, { filter, after })
    nodes.push(...data.issues.nodes)
    if (!data.issues.pageInfo.hasNextPage) return nodes
    after = data.issues.pageInfo.endCursor
  }
  log(
    `select: ${label} hit the ${MAX_PAGES}-page read cap (${nodes.length} rows) with more available — results truncated`,
  )
  return nodes
}

/**
 * Count In-Progress issues, stopping as soon as the count reaches `cap` (the
 * exact total past the cap is irrelevant — the caller only needs to know it's at
 * capacity). Below the cap the returned count is exact (it's surfaced in the
 * claimed result + analytics). Logs on the defensive page cap.
 */
async function countInProgressUpTo(
  graphql: LinearGraphql,
  filter: Record<string, unknown>,
  cap: number,
  log: (m: string) => void,
): Promise<number> {
  let count = 0
  let after: string | null = null
  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
    const data: IssueConnection<{ id: string }> = await graphql(
      IN_PROGRESS_COUNT_QUERY,
      { filter, after },
    )
    count += data.issues.nodes.length
    if (count >= cap) return count
    if (!data.issues.pageInfo.hasNextPage) return count
    after = data.issues.pageInfo.endCursor
  }
  log(
    `select: in-progress count hit the ${MAX_PAGES}-page read cap (${count} rows) — treating as a lower bound`,
  )
  return count
}

/** Normalize a raw Ready issue into the pure-core shape. Blocked-by relations
 * come from `inverseRelations` of type "blocks" (the source issue blocks us); an
 * unreadable related state becomes `null` → fail-safe (still blocks). */
function normalizeIssue(raw: RawReadyIssue): LinearIssueLite {
  const blockers = raw.inverseRelations.nodes
    .filter((r) => r.type === "blocks")
    .map((r) => ({
      id: r.issue?.id ?? "",
      stateType: r.issue?.state?.type ?? null,
    }))
  // Parse the defer-until marker ONCE here, so the pure decision and the
  // diagnostics logging share a single parse (the treated-as-null set provably
  // equals the logged-malformed set — no drift from a double parse).
  const deferRaw = extractDeferMarker(raw.description ?? "")
  const { deferUntilMs, malformed } = parseDeferUntil(deferRaw)
  return {
    id: raw.id,
    identifier: raw.identifier,
    title: raw.title,
    description: raw.description ?? "",
    priority: raw.priority,
    createdAt: raw.createdAt,
    labelIds: raw.labels.nodes.map((l) => l.id),
    blockers,
    deferUntilMs,
    deferMalformed: malformed,
    deferRaw,
  }
}

/** Project the relevant `SelectDecisionConfig` from the full kickoff config. */
function decisionConfig(config: KickoffConfig): SelectDecisionConfig {
  return {
    maxConcurrentBuilds: config.maxConcurrentBuilds,
    sourceObservationsLabelId: config.linear.sourceObservationsLabelId,
    sourceSentryLabelId: config.linear.sourceSentryLabelId,
    needsDefinitionLabelId: config.linear.needsDefinitionLabelId,
  }
}

/**
 * Deterministically select + claim one Ready issue. Returns `{none:true}` when
 * the queue is empty/all-blocked, `{none:true, atCapacity:true}` when at the
 * concurrency cap, or the claimed issue's `SelectResult`. Throws on any Linear
 * API failure or a failed claim.
 */
export async function runDeterministicSelect(
  args: { config: KickoffConfig },
  deps: SelectDeps,
): Promise<SelectResult> {
  const { config } = args
  const { linear } = config
  const { graphql, log } = deps
  const now = (deps.now ?? Date.now)()

  // 1. Capacity gate FIRST — skip the candidate fetch when already full. The
  // count short-circuits at the cap (a busy team can have many In-Progress).
  const inProgressCount = await countInProgressUpTo(
    graphql,
    issueFilter(linear, linear.inProgressStateId),
    config.maxConcurrentBuilds,
    log,
  )
  if (inProgressCount >= config.maxConcurrentBuilds) {
    log(
      `select: at capacity (${inProgressCount}/${config.maxConcurrentBuilds} in progress)`,
    )
    return { none: true, atCapacity: true }
  }

  // 2. Fetch Ready candidates (needs-definition excluded server-side).
  const rawCandidates = await collectIssues<RawReadyIssue>(
    graphql,
    READY_CANDIDATES_QUERY,
    issueFilter(linear, linear.readyStateId, { excludeNeedsDefinition: true }),
    log,
    "ready candidates",
  )
  const candidates = rawCandidates.map(normalizeIssue)

  // Diagnostics from the single parse above — so a parked ticket is
  // distinguishable from an empty or fully-blocked queue. Logged for every
  // candidate regardless of blocked/needs-def status (over-logging an edge case
  // is harmless; the goal is queue observability).
  for (const c of candidates) {
    if (isDeferred(c.deferUntilMs, now)) {
      log(
        `select: skipping ${c.identifier} — deferred until ${new Date(
          c.deferUntilMs as number,
        ).toISOString()} (not before)`,
      )
    }
    if (c.deferMalformed) {
      log(
        `select: ${c.identifier} has an unparseable defer-until value "${c.deferRaw}" — treating as not deferred (claimable)`,
      )
    }
  }

  // 3. Pure decision.
  const decision = decideSelection({
    inProgressCount,
    candidates,
    config: decisionConfig(config),
    now,
  })
  if (decision.kind === "at-capacity") return { none: true, atCapacity: true }
  if (decision.kind === "none") {
    log("select: nothing ready (or every candidate is blocked or deferred)")
    return { none: true }
  }

  // 4. Claim BEFORE returning — move to In-Progress so a re-run can't re-pick it.
  const claim = await graphql<{ issueUpdate: { success: boolean } }>(
    CLAIM_MUTATION,
    { id: decision.issue.id, stateId: linear.inProgressStateId },
  )
  if (!claim.issueUpdate?.success) {
    throw new Error(
      `failed to claim ${decision.issue.identifier} (issueUpdate.success !== true)`,
    )
  }
  log(`select: claimed ${decision.issue.identifier}`)

  return {
    inProgressCount: decision.inProgressCount,
    issueId: decision.issue.identifier,
    issueUuid: decision.issue.id,
    title: decision.issue.title,
    brief: decision.issue.description,
    source: decision.source,
  }
}
