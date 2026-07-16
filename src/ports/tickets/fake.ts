/**
 * In-memory TicketSource for seam tests (SPEC §3.2, §13). Mirrors the policy
 * shape of the real adapters: initiation (listReady/get/claim/create) plus
 * outward-only projections (comment/transition), which it journals so tests
 * can assert exactly what flowed to the tracker.
 */
import type { Ticket, TicketDraft, TicketSource } from '../types'

/**
 * A seed literal: the dependency fields are provider-native answers, so the
 * fake derives them when a test does not care — `blockedBy` defaults to none,
 * and `complete` to "the seed state is the done-state". Tests that DO care
 * state either explicitly.
 */
export type TicketSeed = Omit<Ticket, 'blockedBy' | 'complete'> &
  Partial<Pick<Ticket, 'blockedBy' | 'complete'>>

function cloneTicket(ticket: Ticket): Ticket {
  return {
    ref: { ...ticket.ref },
    title: ticket.title,
    body: ticket.body,
    state: ticket.state,
    labels: [...ticket.labels],
    blockedBy: [...ticket.blockedBy],
    complete: ticket.complete,
  }
}

export class FakeTicketSource implements TicketSource {
  readonly name = 'fake'

  /** Journal of every projection sent outward (§13), in call order. */
  readonly comments: Array<{ id: string; body: string }> = []
  readonly transitions: Array<{ id: string; state: string }> = []

  private readonly tickets = new Map<string, Ticket>()
  private readonly claimed = new Set<string>()
  private readonly createState: string
  private readonly doneState: string
  private nextId = 1

  constructor(
    seed: TicketSeed[] = [],
    opts: {
      /** State assigned by create — proposals land in Triage (SPEC §12). */
      createState?: string
      /** This source's native "resolved" state — what `complete` means here. */
      doneState?: string
    } = {},
  ) {
    this.createState = opts.createState ?? 'Triage'
    this.doneState = opts.doneState ?? 'Done'
    for (const ticket of seed) {
      this.tickets.set(ticket.ref.id, this.normalize(ticket))
    }
  }

  private normalize(seed: TicketSeed): Ticket {
    return cloneTicket({
      ...seed,
      blockedBy: seed.blockedBy ?? [],
      complete: seed.complete ?? seed.state === this.doneState,
    })
  }

  /** True exactly when the ticket has been claimed — for seam assertions. */
  isClaimed(id: string): boolean {
    return this.claimed.has(id)
  }

  async listReady(criteria: {
    labels?: string[]
    state?: string
  }): Promise<Ticket[]> {
    const labels = criteria.labels ?? []
    return [...this.tickets.values()]
      .filter(
        (ticket) =>
          (criteria.state === undefined || ticket.state === criteria.state) &&
          labels.every((label) => ticket.labels.includes(label)),
      )
      .map(cloneTicket)
  }

  async get(id: string): Promise<Ticket | null> {
    const ticket = this.tickets.get(id)
    return ticket ? cloneTicket(ticket) : null
  }

  /** Claim-before-launch (SPEC §12): true exactly once per ticket. */
  async claim(id: string): Promise<boolean> {
    if (!this.tickets.has(id) || this.claimed.has(id)) return false
    this.claimed.add(id)
    return true
  }

  async comment(id: string, body: string): Promise<void> {
    this.require(id, 'comment')
    this.comments.push({ id, body })
  }

  /** Completion is native (SPEC §13): reaching the done-state resolves it. */
  async transition(id: string, state: string): Promise<void> {
    const ticket = this.require(id, 'transition')
    ticket.state = state
    ticket.complete = state === this.doneState
    this.transitions.push({ id, state })
  }

  async create(draft: TicketDraft): Promise<Ticket> {
    const id = `fake-${this.nextId++}`
    const ticket: Ticket = {
      ref: { source: this.name, id, title: draft.title },
      title: draft.title,
      body: draft.body,
      state: this.createState,
      labels: [...(draft.labels ?? [])],
      blockedBy: [...(draft.blockedBy ?? [])],
      complete: this.createState === this.doneState,
    }
    this.tickets.set(id, ticket)
    return cloneTicket(ticket)
  }

  private require(id: string, operation: string): Ticket {
    const ticket = this.tickets.get(id)
    if (!ticket) {
      throw new Error(`fake ticket source: ${operation} on unknown ticket "${id}"`)
    }
    return ticket
  }
}
