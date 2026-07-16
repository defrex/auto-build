/**
 * Reusable contract suite for the TicketSource dependency seam (SPEC §13),
 * mirroring `src/store/contract.ts`. Dependency representation and completion
 * are provider responsibilities, so the only way to keep "no adapter silently
 * discards a requested blocker" true is to assert it against every adapter
 * from one place.
 *
 * Gap, deliberate: the Linear adapter cannot join this suite, because it needs
 * a real GraphQL server (or a fake of one) rather than a constructible local
 * source. It is covered by canned-exchange tests in `linear.test.ts`, whose
 * relation direction and state-type mapping were confirmed against the live
 * API. A future GraphQL fake should bring it in here.
 */
import { describe, expect, test } from 'bun:test'
import type { TicketSource } from '../types'

export interface TicketSourceHarness {
  source: TicketSource
  /** The source's native "resolved" state — what `complete` means for it. */
  doneState: string
  cleanup?: () => Promise<void>
}

export type TicketSourceFactory = () => Promise<TicketSourceHarness>

export function runTicketSourceContract(
  name: string,
  factory: TicketSourceFactory,
): void {
  describe(`TicketSource contract: ${name}`, () => {
    const withSource = async (
      body: (harness: TicketSourceHarness) => Promise<void>,
    ): Promise<void> => {
      const harness = await factory()
      try {
        await body(harness)
      } finally {
        await harness.cleanup?.()
      }
    }

    test('a ticket created without blockers has none', async () => {
      await withSource(async ({ source }) => {
        const ticket = await source.create({ title: 'no deps', body: 'body' })
        expect(ticket.blockedBy).toEqual([])
        const fetched = await source.get(ticket.ref.id)
        expect(fetched?.blockedBy).toEqual([])
      })
    })

    test('requested blockers round-trip through get and listReady', async () => {
      await withSource(async ({ source }) => {
        const first = await source.create({ title: 'blocker one', body: 'b' })
        const second = await source.create({ title: 'blocker two', body: 'b' })
        const created = await source.create({
          title: 'dependent',
          body: 'b',
          blockedBy: [first.ref.id, second.ref.id],
        })

        // create()'s own return value reflects what was written — a caller
        // must not have to re-read to learn its dependency landed.
        expect(created.blockedBy.sort()).toEqual([first.ref.id, second.ref.id].sort())

        const fetched = await source.get(created.ref.id)
        expect(fetched?.blockedBy.sort()).toEqual([first.ref.id, second.ref.id].sort())

        const listed = (await source.listReady({})).find(
          (ticket) => ticket.ref.id === created.ref.id,
        )
        expect(listed?.blockedBy.sort()).toEqual([first.ref.id, second.ref.id].sort())
      })
    })

    test('complete follows the source native lifecycle', async () => {
      await withSource(async ({ source, doneState }) => {
        const ticket = await source.create({ title: 'lifecycle', body: 'b' })
        expect(ticket.complete).toBe(false)

        await source.transition(ticket.ref.id, doneState)
        expect((await source.get(ticket.ref.id))?.complete).toBe(true)

        await source.transition(ticket.ref.id, 'Triage')
        expect((await source.get(ticket.ref.id))?.complete).toBe(false)
      })
    })
  })
}
