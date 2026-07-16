/**
 * The dependency gate's own seam (SPEC §12, §13), driven through
 * FakeTicketSource so the provider answers `blockedBy`/`complete` exactly as a
 * real adapter would.
 */
import { describe, expect, test } from 'bun:test'
import { FakeTicketSource, type TicketSeed } from '../ports/tickets/fake'
import { resolveDependencyBlock } from './dependencies'

function seed(id: string, over: Partial<Omit<TicketSeed, 'ref'>> = {}): TicketSeed {
  return {
    ref: { source: 'fake', id, title: id },
    title: id,
    body: 'body',
    state: 'Ready',
    labels: ['autobuild'],
    ...over,
  }
}

/** The source plus a `get` that counts calls — the fast path's proof. */
function harness(seeds: TicketSeed[]) {
  const source = new FakeTicketSource(seeds)
  const gets: string[] = []
  const get = async (id: string) => {
    gets.push(id)
    return source.get(id)
  }
  return { source, get, gets }
}

async function block(seeds: TicketSeed[], id: string) {
  const { source, get, gets } = harness(seeds)
  const ticket = await source.get(id)
  if (!ticket) throw new Error(`seed missing: ${id}`)
  return { result: await resolveDependencyBlock(ticket, get), gets }
}

describe('resolveDependencyBlock', () => {
  test('a ticket with no blockers is eligible and issues zero lookups', async () => {
    const { result, gets } = await block([seed('T-1')], 'T-1')
    expect(result).toBeNull()
    // The unchanged-behavior guarantee (§13): dependency-free dispatch must
    // not gain a single provider round-trip.
    expect(gets).toEqual([])
  })

  test('an incomplete blocker leaves the ticket unresolved', async () => {
    const { result } = await block(
      [seed('T-1', { blockedBy: ['T-0'] }), seed('T-0', { state: 'Ready' })],
      'T-1',
    )
    expect(result?.reason).toBe('unresolved')
    expect(result?.ticket).toBe('T-1')
    expect(result?.blockers).toEqual(['T-0'])
    expect(result?.detail).toContain('T-1')
    expect(result?.detail).toContain('T-0')
  })

  test('a complete blocker makes the ticket eligible', async () => {
    const { result } = await block(
      [seed('T-1', { blockedBy: ['T-0'] }), seed('T-0', { state: 'Done' })],
      'T-1',
    )
    expect(result).toBeNull()
  })

  test('multiple blockers stay blocking until the LAST one resolves', async () => {
    const seeds = [
      seed('T-1', { blockedBy: ['T-0', 'T-00'] }),
      seed('T-0', { state: 'Done' }),
      seed('T-00', { state: 'Ready' }),
    ]
    const { result } = await block(seeds, 'T-1')
    expect(result?.reason).toBe('unresolved')
    // Only the id actually still outstanding — a resolved blocker must not
    // show up in an operator's diagnostic.
    expect(result?.blockers).toEqual(['T-00'])

    const done = [
      seed('T-1', { blockedBy: ['T-0', 'T-00'] }),
      seed('T-0', { state: 'Done' }),
      seed('T-00', { state: 'Done' }),
    ]
    expect((await block(done, 'T-1')).result).toBeNull()
  })

  test('an unknown blocker is missing, not unresolved', async () => {
    const { result } = await block([seed('T-1', { blockedBy: ['ghost'] })], 'T-1')
    expect(result?.reason).toBe('missing')
    expect(result?.blockers).toEqual(['ghost'])
    expect(result?.detail).toContain('ghost')
    expect(result?.detail).toContain('does not exist')
  })

  test('a missing blocker outranks an unresolved one — the broken id is the story', async () => {
    const { result } = await block(
      [seed('T-1', { blockedBy: ['T-0', 'ghost'] }), seed('T-0', { state: 'Ready' })],
      'T-1',
    )
    expect(result?.reason).toBe('missing')
    expect(result?.blockers).toEqual(['ghost'])
  })

  test('a self-dependency is reported as self and needs no lookups', async () => {
    const { result, gets } = await block([seed('T-1', { blockedBy: ['T-1'] })], 'T-1')
    expect(result?.reason).toBe('self')
    expect(result?.blockers).toEqual(['T-1'])
    expect(result?.detail).toContain('itself')
    expect(gets).toEqual([])
  })

  test('a two-node cycle terminates and names the path', async () => {
    const { result } = await block(
      [seed('A', { blockedBy: ['B'] }), seed('B', { blockedBy: ['A'] })],
      'A',
    )
    expect(result?.reason).toBe('cycle')
    expect(result?.detail).toContain('A → B → A')
    expect(result?.blockers).toEqual(['B'])
  })

  test('a three-node cycle terminates and names the path', async () => {
    const { result } = await block(
      [
        seed('A', { blockedBy: ['B'] }),
        seed('B', { blockedBy: ['C'] }),
        seed('C', { blockedBy: ['A'] }),
      ],
      'A',
    )
    expect(result?.reason).toBe('cycle')
    expect(result?.detail).toContain('A → B → C → A')
    expect(result?.blockers).toEqual(['B', 'C'])
  })

  test('a cycle among OTHER tickets terminates without misreporting this one', async () => {
    // A depends on B; B and C form a loop that never reaches A. A is plainly
    // unresolved — the walk must terminate without claiming A is in a cycle.
    const { result } = await block(
      [
        seed('A', { blockedBy: ['B'] }),
        seed('B', { blockedBy: ['C'] }),
        seed('C', { blockedBy: ['B'] }),
      ],
      'A',
    )
    expect(result?.reason).toBe('unresolved')
    expect(result?.blockers).toEqual(['B'])
  })

  test('a complete blocker stops the walk — its own edges are irrelevant', async () => {
    // B is done, so the B→A edge cannot block A. A is eligible, not cyclic.
    const { result } = await block(
      [seed('A', { blockedBy: ['B'] }), seed('B', { state: 'Done', blockedBy: ['A'] })],
      'A',
    )
    expect(result).toBeNull()
  })

  test('a blocker shared by the walk is fetched once', async () => {
    const { result, gets } = await block(
      [
        seed('A', { blockedBy: ['B', 'C'] }),
        seed('B', { blockedBy: ['D'] }),
        seed('C', { blockedBy: ['D'] }),
        seed('D', { state: 'Ready' }),
      ],
      'A',
    )
    expect(result?.reason).toBe('unresolved')
    expect(gets.filter((id) => id === 'D')).toHaveLength(1)
  })
})
