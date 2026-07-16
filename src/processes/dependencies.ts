/**
 * Pre-build dependency gating (SPEC §12, §13). A ticket may declare blockers;
 * the dispatcher must leave it alone until every blocker is resolved *by the
 * source's own lifecycle*. This module is the whole of that decision.
 *
 * The split that makes it deterministic: the TicketSource answers the two
 * questions only it can — what does this ticket declare as blockers
 * (`blockedBy`), and is a ticket resolved (`complete`) — and everything else
 * (traversal, classification, diagnostics) is provider-independent code here.
 * No adapter re-derives graph logic, and no agent judgment enters.
 *
 * Why `processes/` and not `kernel/`: the kernel is pure pipeline decisions
 * over a build's event log. This is async, runs over the ticket graph, and
 * gates work *before* any build exists — it never touches build state.
 *
 * Deliberately NOT a build-level `blocked` status: a dependency-blocked ticket
 * stays a plain queued ticket in the source (§13), so it creates no build,
 * provisions no workspace, and consumes no capacity.
 */
import type { Ticket } from '../ports/types'

/** Why a ticket is being held back. Precedence order, worst-first. */
export type DependencyReason = 'self' | 'missing' | 'cycle' | 'unresolved'

export interface DependencyBlock {
  /** Source-local id of the ticket being held back. */
  ticket: string
  reason: DependencyReason
  /** The offending blocker ids — for `unresolved`, ALL that remain. */
  blockers: string[]
  /** Actionable one-liner naming the ticket and the dependency (§12). */
  detail: string
}

/** Fetch a ticket by source-local id; null when the source has no such id. */
export type TicketLookup = (id: string) => Promise<Ticket | null>

/** Wraps `get` in a per-call memo: a blocker shared by several tickets, or
 * revisited by the cycle walk, is fetched once. */
export function memoizeLookup(get: TicketLookup): TicketLookup {
  const cache = new Map<string, Promise<Ticket | null>>()
  return (id) => {
    const hit = cache.get(id)
    if (hit) return hit
    const miss = get(id)
    cache.set(id, miss)
    return miss
  }
}

/**
 * Classify a candidate ticket: `null` means eligible, a `DependencyBlock`
 * means hold it back.
 *
 * Precedence is worst-first — a self-dependency or a missing blocker is a
 * broken graph a human must fix, and saying "waiting on X" would hide that.
 *
 * On cycles: a cycle is already self-gating, because every ticket in one has
 * an incomplete direct blocker and so is `unresolved` anyway. The walk exists
 * purely to upgrade the diagnostic to name the loop, which is what makes it
 * actionable. It follows only INCOMPLETE blockers — a complete blocker does
 * not block, so its own edges are irrelevant — and a visited set bounds it.
 */
export async function resolveDependencyBlock(
  ticket: Ticket,
  get: TicketLookup,
): Promise<DependencyBlock | null> {
  const id = ticket.ref.id
  // Fast path: no dependencies means no lookups at all, so behavior for the
  // overwhelmingly common dependency-free ticket is provably unchanged.
  if (ticket.blockedBy.length === 0) return null

  const lookup = memoizeLookup(get)

  if (ticket.blockedBy.includes(id)) {
    return {
      ticket: id,
      reason: 'self',
      blockers: [id],
      detail: `${id} lists itself as a blocker — it can never become eligible; remove the self-dependency`,
    }
  }

  const blockers: Array<{ id: string; ticket: Ticket }> = []
  const missing: string[] = []
  for (const blockerId of ticket.blockedBy) {
    const blocker = await lookup(blockerId)
    if (blocker === null) missing.push(blockerId)
    else blockers.push({ id: blockerId, ticket: blocker })
  }
  if (missing.length > 0) {
    return {
      ticket: id,
      reason: 'missing',
      blockers: missing,
      detail:
        `${id} is blocked by ${missing.join(', ')}, which ${missing.length > 1 ? 'do' : 'does'} ` +
        'not exist in the configured ticket source — fix the blocker ids',
    }
  }

  const unresolved = blockers.filter((blocker) => !blocker.ticket.complete)
  if (unresolved.length === 0) return null

  const cycle = await findCycle(id, unresolved.map((blocker) => blocker.id), lookup)
  if (cycle) {
    return {
      ticket: id,
      reason: 'cycle',
      blockers: cycle.slice(0, -1).filter((node) => node !== id),
      detail: `${id} is in a dependency cycle (${cycle.join(' → ')}) — no ticket in it can ever become eligible; break the cycle`,
    }
  }

  const ids = unresolved.map((blocker) => blocker.id)
  return {
    ticket: id,
    reason: 'unresolved',
    blockers: ids,
    detail: `${id} is waiting on unresolved blockers: ${ids.join(', ')}`,
  }
}

/**
 * DFS from `origin`'s incomplete blockers back to `origin`. Returns the path
 * as `origin → … → origin`, or null when no cycle reaches back. The visited
 * set is what guarantees termination on any shape of graph, including cycles
 * that do not pass through the origin.
 */
async function findCycle(
  origin: string,
  starts: string[],
  lookup: TicketLookup,
): Promise<string[] | null> {
  const visited = new Set<string>()

  const walk = async (id: string, path: string[]): Promise<string[] | null> => {
    if (id === origin) return [...path, origin]
    if (visited.has(id)) return null
    visited.add(id)
    const ticket = await lookup(id)
    // A missing or already-resolved blocker cannot carry the loop onward.
    if (ticket === null || ticket.complete) return null
    for (const next of ticket.blockedBy) {
      const found = await walk(next, [...path, id])
      if (found) return found
    }
    return null
  }

  for (const start of starts) {
    const found = await walk(start, [origin])
    if (found) return found
  }
  return null
}
