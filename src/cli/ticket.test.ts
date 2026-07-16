/**
 * `ab ticket create` (SPEC §8.8): files the body through the configured
 * TicketSource — config selects the adapter, secrets come from the process
 * env, and errors are agent feedback (D6) naming what would be accepted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TicketsConfig } from '../config/schema'
import type { Ticket, TicketDraft, TicketSource } from '../ports/types'
import { runCli } from './main'
import { abTicketCreate } from './ticket'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-ticket-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const FILE_TICKETS_TOML = ['[tickets]', 'source = "file"', 'dir = "tickets"', ''].join('\n')

async function writeRepo(configToml: string): Promise<void> {
  await writeFile(join(tmp, 'autobuild.toml'), configToml)
}

/**
 * A capturing fake: records the draft and config it was constructed from.
 * `known` lists the ids `get` resolves — everything else is unknown, which is
 * what `--blocked-by` validation turns into an error.
 */
function fakeFactory(
  created: {
    config?: TicketsConfig
    env?: Record<string, string | undefined>
    draft?: TicketDraft
  },
  known: string[] = [],
) {
  return (config: TicketsConfig, env: Record<string, string | undefined>): TicketSource => {
    created.config = config
    created.env = env
    const stub = (id: string): Ticket => ({
      ref: { source: 'fake', id },
      title: id,
      body: '',
      state: 'Triage',
      labels: [],
      blockedBy: [],
      complete: false,
    })
    return {
      name: 'fake',
      listReady: () => Promise.resolve([]),
      get: (id: string) =>
        Promise.resolve(known.includes(id) ? stub(id) : null),
      claim: () => Promise.resolve(false),
      comment: () => Promise.resolve(),
      transition: () => Promise.resolve(),
      create: (draft: TicketDraft): Promise<Ticket> => {
        created.draft = draft
        return Promise.resolve({
          ref: { source: 'fake', id: 'fake-1', url: 'https://example.test/fake-1' },
          title: draft.title,
          body: draft.body,
          state: 'Triage',
          labels: draft.labels ?? [],
          blockedBy: [...(draft.blockedBy ?? [])],
          complete: false,
        })
      },
    }
  }
}

describe('abTicketCreate', () => {
  test('files the body file through the configured source and prints the ref', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, '## What and why\n\nBecause.\n')
    const created: Parameters<typeof fakeFactory>[0] = {}
    const out: string[] = []

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Add rate limiting',
      bodyFile,
      labels: ['autobuild'],
      env: { LINEAR_API_KEY: 'k' },
      stdout: (line) => out.push(line),
      sourceFactory: fakeFactory(created),
    })

    expect(created.config).toEqual({ source: 'file', dir: join(tmp, 'tickets') })
    expect(created.env).toEqual({ LINEAR_API_KEY: 'k' })
    expect(created.draft).toEqual({
      title: 'Add rate limiting',
      body: '## What and why\n\nBecause.\n',
      labels: ['autobuild'],
    })
    expect(out).toEqual([
      'ticket created: fake:fake-1 (Triage) — https://example.test/fake-1',
    ])
  })

  test('--blocked-by reaches the draft and the printed line names the blockers', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const created: Parameters<typeof fakeFactory>[0] = {}
    const out: string[] = []

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Dependent work',
      bodyFile,
      blockedBy: ['AUT-8', 'AUT-7'],
      env: {},
      stdout: (line) => out.push(line),
      sourceFactory: fakeFactory(created, ['AUT-8', 'AUT-7']),
    })

    expect(created.draft?.blockedBy).toEqual(['AUT-8', 'AUT-7'])
    expect(out).toEqual([
      'ticket created: fake:fake-1 (Triage) — https://example.test/fake-1 (blocked by AUT-8, AUT-7)',
    ])
  })

  test('an unknown blocker is an actionable error naming the id and source, and creates nothing', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const created: Parameters<typeof fakeFactory>[0] = {}

    await expect(
      abTicketCreate({
        targetRepo: tmp,
        title: 'Dependent work',
        bodyFile,
        blockedBy: ['AUT-8', 'AUT-99'],
        env: {},
        stdout: () => {},
        sourceFactory: fakeFactory(created, ['AUT-8']),
      }),
    ).rejects.toThrow(/--blocked-by: no ticket "AUT-99" in the configured fake source/)
    // The failure must be total: a ticket whose dependency never landed would
    // dispatch too early, which is the whole thing the gate prevents.
    expect(created.draft).toBeUndefined()
  })

  test('no --blocked-by leaves the draft untouched (unchanged behavior)', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const created: Parameters<typeof fakeFactory>[0] = {}

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Independent work',
      bodyFile,
      env: {},
      stdout: () => {},
      sourceFactory: fakeFactory(created),
    })

    expect(created.draft).toEqual({ title: 'Independent work', body: 'body\n' })
  })

  test('with source = "file" and no factory override, writes a real ticket file', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'the spec body\n')
    const out: string[] = []

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Real file ticket',
      bodyFile,
      env: {},
      stdout: (line) => out.push(line),
    })

    expect(out).toEqual(['ticket created: file:file-1 (Triage)'])
    const written = await readFile(join(tmp, 'tickets', 'file-1.md'), 'utf8')
    expect(written).toContain('title = "Real file ticket"')
    expect(written).toContain('the spec body')
  })

  test('a missing autobuild.toml is an error naming the path', async () => {
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    expect(
      abTicketCreate({
        targetRepo: tmp,
        title: 't',
        bodyFile,
        env: {},
        stdout: () => {},
      }),
    ).rejects.toThrow(/autobuild\.toml: not found/)
  })

  test('a config without [tickets] is an error naming what would be accepted', async () => {
    await writeRepo('[project]\nbaseBranch = "main"\n')
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    expect(
      abTicketCreate({
        targetRepo: tmp,
        title: 't',
        bodyFile,
        env: {},
        stdout: () => {},
      }),
    ).rejects.toThrow(/no \[tickets\] table.*source = "linear".*source = "file"/)
  })

  test('a missing body file is an error naming the path', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    expect(
      abTicketCreate({
        targetRepo: tmp,
        title: 't',
        bodyFile: join(tmp, 'nope.md'),
        env: {},
        stdout: () => {},
      }),
    ).rejects.toThrow(/--body .*nope\.md: file not found/)
  })
})

describe('runCli — ticket routing', () => {
  function sessionlessDeps() {
    const out: string[] = []
    const err: string[] = []
    return {
      deps: {
        workspacePath: tmp,
        stdout: (line: string) => out.push(line),
        stderr: (line: string) => err.push(line),
      },
      out,
      err,
    }
  }

  test('ab ticket without create prints usage and exits 1', async () => {
    const { deps, err } = sessionlessDeps()
    expect(await runCli(['ticket'], deps)).toBe(1)
    expect(err.join('\n')).toContain('usage: ab ticket create')
  })

  test('ab ticket create without --body prints usage and exits 1', async () => {
    const { deps, err } = sessionlessDeps()
    expect(await runCli(['ticket', 'create', 'a', 'title'], deps)).toBe(1)
    expect(err.join('\n')).toContain('usage: ab ticket create')
  })

  test('ab ticket create runs sessionless — no AB_* deps required', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps, out } = sessionlessDeps()
    expect(await runCli(['ticket', 'create', 'A', 'title', '--body', bodyFile], deps)).toBe(0)
    expect(out.join('\n')).toContain('ticket created: file:file-1')
  })

  test('usage documents --blocked-by, its syntax, and that ids are source-local', async () => {
    const { deps, err } = sessionlessDeps()
    expect(await runCli(['ticket'], deps)).toBe(1)
    expect(err.join('\n')).toContain('[--blocked-by id,id]')
    expect(err.join('\n')).toContain('comma-separated')
    expect(err.join('\n')).toContain('configured ticket source')
  })

  test('--blocked-by parses a comma list and gates the real file source end-to-end', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps, out, err } = sessionlessDeps()

    // file-1 exists to be blocked by; file-2 declares the dependency.
    expect(await runCli(['ticket', 'create', 'Blocker', '--body', bodyFile], deps)).toBe(0)
    expect(
      await runCli(
        ['ticket', 'create', 'Dependent', '--body', bodyFile, '--blocked-by', 'file-1'],
        deps,
      ),
    ).toBe(0)
    expect(out.join('\n')).toContain('ticket created: file:file-2 (Triage) (blocked by file-1)')

    // An unknown id fails nonzero rather than filing a dangling dependency.
    expect(
      await runCli(
        ['ticket', 'create', 'Bad', '--body', bodyFile, '--blocked-by', 'file-99'],
        deps,
      ),
    ).toBe(1)
    expect(err.join('\n')).toContain('--blocked-by: no ticket "file-99"')
  })
})
