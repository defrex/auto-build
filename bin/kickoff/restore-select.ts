/**
 * Deterministic restore-select runner — replaces the read-only `claude` + Linear
 * MCP restore agent.
 *
 * Lists the In-Progress issues assigned to the current operator (the API token's
 * viewer) and resolves each one's attached git branch ref so `restore.ts` can
 * rebuild its local environment. Read-only: it never claims or moves a ticket.
 *
 * Branch resolution mirrors the old prompt's precedence: among GitHub
 * attachments, a PR head ref wins over a no-PR branch link; Linear's
 * auto-suggested `branchName` field is NEVER used (we don't query it). When no
 * real attached ref is resolvable, `branch` is `null` and `restore.ts` falls
 * back to an existing id-carrying branch or a derived one — the same degradation
 * the agent path had.
 */

import type { KickoffConfig, LinearConfig } from "./config"
import type { LinearGraphql } from "./linear-client"
import { normalizeAttachedBranch, type RestoreTicket } from "./restore"

/** A Linear attachment reduced to the fields branch resolution needs. */
export type AttachmentLite = {
  url: string | null
  sourceType: string | null
  metadata: Record<string, unknown> | null
}

export type RestoreSelectDeps = {
  graphql: LinearGraphql
  log: (message: string) => void
}

const PAGE_SIZE = 50
const MAX_PAGES = 20

type PageInfo = { hasNextPage: boolean; endCursor: string | null }
type RawAssignedIssue = {
  id: string
  identifier: string
  title: string
  attachments: { nodes: AttachmentLite[] }
}
type ViewerAssigned = {
  viewer: {
    id: string
    assignedIssues: { nodes: RawAssignedIssue[]; pageInfo: PageInfo }
  }
}

const ASSIGNED_IN_PROGRESS_QUERY = `
query KickoffRestoreAssigned($filter: IssueFilter, $after: String) {
  viewer {
    id
    assignedIssues(filter: $filter, first: ${PAGE_SIZE}, after: $after) {
      nodes {
        id
        identifier
        title
        attachments(first: ${PAGE_SIZE}) {
          nodes { url sourceType metadata }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`

/** Filter for In-Progress issues, scoped to the team (and project when pinned).
 * Assignee is implicit — these come off `viewer.assignedIssues`. */
function assignedFilter(linear: LinearConfig): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    team: { id: { eq: linear.teamId } },
    state: { id: { eq: linear.inProgressStateId } },
  }
  if (linear.projectId !== "") {
    filter.project = { id: { eq: linear.projectId } }
  }
  return filter
}

/** A GitHub attachment is one whose source is github or whose url is a github.com link. */
function isGithubAttachment(a: AttachmentLite): boolean {
  if (a.sourceType?.toLowerCase() === "github") return true
  return a.url?.includes("github.com") ?? false
}

/**
 * The PR HEAD branch carried in a Linear GitHub-integration attachment's
 * metadata. Verified against the live API: a PR attachment's `metadata` carries
 * `branch` = the head branch and `targetBranch` = the base (e.g. "main"). We use
 * `branch` ONLY — `targetBranch` must never be returned.
 */
function branchFromMetadata(
  metadata: Record<string, unknown> | null,
): string | null {
  if (!metadata) return null
  const v = metadata.branch
  return typeof v === "string" && v.trim() !== "" ? v : null
}

/** Branch name out of a `/tree/<branch>` GitHub url (branch may contain slashes). */
function branchFromTreeUrl(url: string | null): string | null {
  if (!url) return null
  const m = url.match(/\/tree\/(.+)$/)
  return m ? m[1] : null
}

/**
 * Resolve a plain, checkoutable branch name for an issue from its attachments
 * (pure). Precedence: a PR attachment's head ref (from metadata) wins; otherwise
 * a no-PR branch-link's `/tree/<branch>` segment. The result is normalized via
 * {@link normalizeAttachedBranch}; unresolvable → `null`.
 */
export function resolveAttachedBranch(
  attachments: AttachmentLite[],
): string | null {
  const github = attachments.filter(isGithubAttachment)
  let prRef: string | null = null
  let branchRef: string | null = null
  for (const a of github) {
    const isPr = a.url?.includes("/pull/") ?? false
    if (isPr) {
      prRef = prRef ?? branchFromMetadata(a.metadata)
    } else {
      branchRef =
        branchRef ?? branchFromMetadata(a.metadata) ?? branchFromTreeUrl(a.url)
    }
  }
  return normalizeAttachedBranch(prRef ?? branchRef)
}

/**
 * List the operator's In-Progress issues and resolve each one's branch ref.
 * Read-only; returns `[]` when nothing is assigned. Throws on any API failure.
 */
export async function runDeterministicRestoreSelect(
  args: { config: KickoffConfig },
  deps: RestoreSelectDeps,
): Promise<RestoreTicket[]> {
  const { linear } = args.config
  const { graphql, log } = deps
  const filter = assignedFilter(linear)

  const issues: RawAssignedIssue[] = []
  let after: string | null = null
  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
    const data: ViewerAssigned = await graphql(ASSIGNED_IN_PROGRESS_QUERY, {
      filter,
      after,
    })
    const conn = data.viewer.assignedIssues
    issues.push(...conn.nodes)
    if (!conn.pageInfo.hasNextPage) break
    after = conn.pageInfo.endCursor
  }

  const tickets = issues.map((issue) => ({
    issueId: issue.identifier,
    issueUuid: issue.id,
    title: issue.title,
    branch: resolveAttachedBranch(issue.attachments.nodes),
  }))
  log(`restore: ${tickets.length} In-Progress ticket(s) assigned`)
  return tickets
}
