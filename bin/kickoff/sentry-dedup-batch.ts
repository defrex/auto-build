/**
 * ENTRYPOINT: batched Sentry-dedup Linear resolver for `/triage-sentry` step 3.
 *
 *   bun run bin/kickoff/sentry-dedup-batch.ts --input <path-to-json>
 *
 * The skill gathers each survivor's Sentry notes via MCP, writes a
 * `{ candidates: [{ shortId, notes, inActionableQuery }] }` JSON input, runs this
 * script, and reads the per-candidate dedup verdicts back from stdout. This moves
 * the mechanical Linear read + verdict off the LLM and onto the headless
 * `linear-client.ts` seam (the `adversarial-review.ts` pattern) — and does the
 * Linear read as ONE batched GraphQL request for the whole candidate set.
 *
 * Layering (per plan): the query string lives HERE; transport stays in
 * `linear-client.ts`. The dedup verdict logic is REUSED from `sentry-dedup.ts`
 * (`selectLatestSentryBreadcrumb`, `classifyTicketState`, `decideSentryTriage`) —
 * never reimplemented.
 *
 * stdout carries ONLY the result JSON; all diagnostics go to stderr, so the skill
 * can parse stdout. A malformed input or a transport error (missing
 * `LINEAR_API_KEY`, non-2xx, GraphQL `errors[]`) throws → non-zero exit with the
 * message on stderr and NO stdout JSON — the same failure contract as
 * `adversarial-review.ts`.
 */

import { readFileSync } from "node:fs"
import { detectRepoRoot } from "../build/repo"
import { type LinearConfig, loadConfig, validateConfig } from "./config"
import { type LinearGraphql, linearGraphql } from "./linear-client"
import {
  classifyTicketState,
  decideSentryTriage,
  type SentryBreadcrumb,
  type SentryNote,
  type SentryTriageVerdict,
  selectLatestSentryBreadcrumb,
  type TicketTerminality,
} from "./sentry-dedup"

/** One candidate's Sentry-gathered facts (the skill assembles these). */
export type SentryDedupCandidateInput = {
  shortId: string
  /** The Sentry issue's notes, as gathered via MCP — parsed here, not by the LLM. */
  notes: SentryNote[]
  /** Came back from is:unresolved|regressed|escalating AND passed threshold. */
  inActionableQuery: boolean
}

export type SentryDedupBatchInput = {
  candidates: SentryDedupCandidateInput[]
}

export type SentryDedupResultEntry = {
  shortId: string
  verdict: SentryTriageVerdict
  /** The selected latest breadcrumb (null when the issue carries none). */
  breadcrumb: SentryBreadcrumb | null
  /** Resolved terminality; null when there's no breadcrumb OR the lookup failed. */
  terminality: TicketTerminality | null
  /** Set when the linked ticket couldn't be resolved (deleted/inaccessible). */
  lookupError?: string
}

export type SentryDedupBatchResult = {
  results: SentryDedupResultEntry[]
}

export type SentryDedupBatchDeps = {
  graphql: LinearGraphql
  linear: Pick<LinearConfig, "doneStateId" | "rejectedStateIds">
  log?: (message: string) => void
}

/** Page size for the bounded paginated read (mirrors `select.ts`). */
const PAGE_SIZE = 50
/** Defensive page cap so a pathological result set can't loop forever. */
const MAX_PAGES = 20

/** Full Linear-issued node uuid shape (guards against a malformed uuid tripping
 * Linear's `INVALID_INPUT` on the `id.in` branch — a malformed uuid falls back
 * to the identifier branch, since a breadcrumb always carries `linearTicketId`). */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Linear ref shape, e.g. PRO-372 / PRODUCT-12 (already validated upstream). */
const LINEAR_REF_RE = /^([A-Z][A-Z0-9]*)-(\d+)$/

const TICKET_STATES_QUERY = `
query SentryDedupTicketStates($filter: IssueFilter, $after: String) {
  issues(filter: $filter, first: ${PAGE_SIZE}, after: $after) {
    nodes { id identifier state { id } }
    pageInfo { hasNextPage endCursor }
  }
}`

type StateNode = {
  id: string
  identifier: string
  state: { id: string } | null
}
type TicketStatesConnection = {
  issues: {
    nodes: StateNode[]
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
  }
}

/**
 * The key a breadcrumb is looked up by: the internal uuid when present AND
 * well-formed, else the human ref. `buildTicketFilter` partitions on the same
 * choice, and the resolved state map is keyed by both `node.id` and
 * `node.identifier`, so this ref always hits the right entry.
 */
function lookupRef(breadcrumb: SentryBreadcrumb): string {
  const uuid = breadcrumb.linearTicketUuid
  if (typeof uuid === "string" && UUID_RE.test(uuid)) return uuid
  return breadcrumb.linearTicketId
}

/**
 * Build the batched Linear `IssueFilter` for a set of breadcrumbs, or `null` when
 * there's nothing to resolve (so the caller skips the network call entirely).
 *
 * Partitions breadcrumbs into a uuid branch (`{ id: { in: uuids } }`) and one
 * identifier branch per team key (`{ and: [ { team: { key: { eq } } }, { number:
 * { in } } ] }`). The team+number constraint MUST be wrapped in an explicit
 * `and` — inside an `or` element, sibling keys are treated as OR by Linear, so a
 * bare `{ team, number }` branch would return the whole team (verified against
 * the live API). The final filter is the `or` of all branches.
 */
export function buildTicketFilter(
  breadcrumbs: SentryBreadcrumb[],
): Record<string, unknown> | null {
  const uuids: string[] = []
  const numbersByTeam = new Map<string, number[]>()
  for (const breadcrumb of breadcrumbs) {
    const uuid = breadcrumb.linearTicketUuid
    if (typeof uuid === "string" && UUID_RE.test(uuid)) {
      uuids.push(uuid)
      continue
    }
    const match = LINEAR_REF_RE.exec(breadcrumb.linearTicketId)
    if (!match) continue // LINEAR_REF-validated upstream; defensive skip.
    const [, teamKey, number] = match
    const list = numbersByTeam.get(teamKey) ?? []
    list.push(Number(number))
    numbersByTeam.set(teamKey, list)
  }

  const branches: Record<string, unknown>[] = []
  if (uuids.length > 0) branches.push({ id: { in: uuids } })
  for (const [teamKey, numbers] of numbersByTeam) {
    branches.push({
      and: [{ team: { key: { eq: teamKey } } }, { number: { in: numbers } }],
    })
  }
  if (branches.length === 0) return null
  return { or: branches }
}

/**
 * Resolve the workflow-state id of every breadcrumb's linked ticket in ONE
 * batched, paginated request. Returns a map keyed by BOTH `node.id` (uuid) and
 * `node.identifier` (human ref) → `state.id`, so a lookup by either ref hits.
 * Returns an empty map (no request issued) when there's nothing to resolve.
 *
 * Transport errors (missing key, non-2xx, GraphQL `errors[]`) PROPAGATE, per
 * `linear-client.ts` semantics.
 */
export async function resolveTicketStates(
  breadcrumbs: SentryBreadcrumb[],
  graphql: LinearGraphql,
  log: (message: string) => void,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const filter = buildTicketFilter(breadcrumbs)
  if (filter === null) return map

  let after: string | null = null
  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
    const data: TicketStatesConnection = await graphql(TICKET_STATES_QUERY, {
      filter,
      after,
    })
    for (const node of data.issues.nodes) {
      if (node.state?.id) {
        map.set(node.id, node.state.id)
        map.set(node.identifier, node.state.id)
      }
    }
    if (!data.issues.pageInfo.hasNextPage) return map
    after = data.issues.pageInfo.endCursor
  }
  log(
    `sentry-dedup-batch: ticket-state lookup hit the ${MAX_PAGES}-page read cap (${map.size} keys) with more available — results truncated`,
  )
  return map
}

/**
 * Orchestration core: per candidate select the latest breadcrumb (reused parser),
 * resolve all linked ticket states in one batched request, classify terminality,
 * and decide the verdict (all reused from `sentry-dedup.ts`). A per-ticket
 * resolution failure degrades ONLY that candidate to unknown terminality (→
 * defensive `skip`) with a `lookupError`; the batch is never aborted. A
 * transport-level failure propagates.
 */
export async function runSentryDedupBatch(
  input: SentryDedupBatchInput,
  deps: SentryDedupBatchDeps,
): Promise<SentryDedupBatchResult> {
  const log = deps.log ?? ((message: string) => console.warn(message))

  const perCandidate = input.candidates.map((candidate) => ({
    candidate,
    breadcrumb: selectLatestSentryBreadcrumb(candidate.notes),
  }))

  const breadcrumbs = perCandidate
    .map((entry) => entry.breadcrumb)
    .filter((b): b is SentryBreadcrumb => b !== null)

  const stateMap = await resolveTicketStates(breadcrumbs, deps.graphql, log)

  const results: SentryDedupResultEntry[] = perCandidate.map(
    ({ candidate, breadcrumb }) => {
      if (breadcrumb === null) {
        return {
          shortId: candidate.shortId,
          verdict: decideSentryTriage({
            breadcrumb: null,
            ticketTerminality: null,
            inActionableQuery: candidate.inActionableQuery,
          }),
          breadcrumb: null,
          terminality: null,
        }
      }

      const ref = lookupRef(breadcrumb)
      const stateId = stateMap.get(ref)
      if (stateId === undefined) {
        return {
          shortId: candidate.shortId,
          verdict: decideSentryTriage({
            breadcrumb,
            ticketTerminality: null,
            inActionableQuery: candidate.inActionableQuery,
          }),
          breadcrumb,
          terminality: null,
          lookupError: `ticket ${ref} state unresolved from Linear (deleted, inaccessible, stateless, or past the read cap) — terminality unknown`,
        }
      }

      const terminality = classifyTicketState(stateId, deps.linear)
      return {
        shortId: candidate.shortId,
        verdict: decideSentryTriage({
          breadcrumb,
          ticketTerminality: terminality,
          inActionableQuery: candidate.inActionableQuery,
        }),
        breadcrumb,
        terminality,
      }
    },
  )

  return { results }
}

/**
 * Validate the JSON input contract. THROWS on a malformed shape so the process
 * exits non-zero with a clear message and NO stdout result JSON (same failure
 * contract as `adversarial-review.ts`).
 */
export function parseBatchInput(raw: unknown): SentryDedupBatchInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("sentry-dedup-batch input must be a JSON object")
  }
  const candidates = (raw as Record<string, unknown>).candidates
  if (!Array.isArray(candidates)) {
    throw new Error("sentry-dedup-batch input.candidates must be an array")
  }
  return { candidates: candidates.map(parseCandidate) }
}

function parseCandidate(
  raw: unknown,
  index: number,
): SentryDedupCandidateInput {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`candidate[${index}] must be an object`)
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.shortId !== "string" || obj.shortId.length === 0) {
    throw new Error(`candidate[${index}].shortId must be a non-empty string`)
  }
  if (typeof obj.inActionableQuery !== "boolean") {
    throw new Error(`candidate[${index}].inActionableQuery must be a boolean`)
  }
  if (!Array.isArray(obj.notes)) {
    throw new Error(`candidate[${index}].notes must be an array`)
  }
  const notes: SentryNote[] = obj.notes.map((note, noteIndex) => {
    if (typeof note !== "object" || note === null) {
      throw new Error(
        `candidate[${index}].notes[${noteIndex}] must be an object`,
      )
    }
    const n = note as Record<string, unknown>
    if (typeof n.body !== "string") {
      throw new Error(
        `candidate[${index}].notes[${noteIndex}].body must be a string`,
      )
    }
    if (typeof n.createdAt !== "string") {
      throw new Error(
        `candidate[${index}].notes[${noteIndex}].createdAt must be a string`,
      )
    }
    return { body: n.body, createdAt: n.createdAt }
  })
  return {
    shortId: obj.shortId,
    notes,
    inActionableQuery: obj.inActionableQuery,
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const inputIdx = args.indexOf("--input")
  const inputPath = inputIdx >= 0 ? args[inputIdx + 1] : undefined
  const rawInput = inputPath
    ? readFileSync(inputPath, "utf-8")
    : readFileSync(0, "utf-8") // stdin fallback
  const input = parseBatchInput(JSON.parse(rawInput))

  const repoRoot = detectRepoRoot()
  // The same pin-gate the skill's setup step relies on: a missing required
  // Linear ID (including doneStateId) is made legible rather than silently
  // misclassifying tickets. rejectedStateIds is intentionally not required — an
  // unpinned one just classifies a rejected ticket as non-terminal (→ defensive
  // skip), never a spurious file.
  const config = loadConfig(repoRoot)
  validateConfig(config)

  const result = await runSentryDedupBatch(input, {
    graphql: linearGraphql,
    linear: config.linear,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.main) {
  await main()
}
