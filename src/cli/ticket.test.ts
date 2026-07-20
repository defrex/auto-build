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
import type {
  Ticket,
  TicketDraft,
  TicketSource,
  TicketUpdate,
} from '../ports/types'
import { runCli } from './main'
import {
  abTicketBlock,
  abTicketCreate,
  abTicketUnblock,
  abTicketUpdate,
} from './ticket'

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-ticket-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const FILE_TICKETS_TOML = ['[tickets]', 'source = "file"', 'dir = "tickets"', ''].join('\n')

/**
 * `[tickets].readyState` is required, and every normal fixture here goes
 * through `parseConfig`. Inject it into an existing tickets table or prepend a
 * minimal file-source table when the fixture is about another config section.
 */
function withReadyState(toml: string): string {
  if (/(^|\n)\s*readyState\s*=/.test(toml)) return toml
  if (/(^|\n)\[tickets\]/.test(toml)) {
    return toml.replace(/(^|\n)(\[tickets\][^\n]*\n)/, `$1$2readyState = "ready"\n`)
  }
  return `[tickets]\nsource = "file"\nreadyState = "ready"\n${toml}`
}

async function writeRepo(configToml: string): Promise<void> {
  await writeFile(join(tmp, 'autobuild.toml'), withReadyState(configToml))
}

/**
 * A capturing fake: records the draft and config it was constructed from.
 * `known` is the set of ids `dependencyStates` reports as existing — how the
 * blocker-validation tests distinguish a real blocker from a typo.
 */
function fakeFactory(
  created: {
    config?: TicketsConfig
    env?: Record<string, string | undefined>
    targetRepo?: string
    draft?: TicketDraft
    update?: { id: string; patch: TicketUpdate }
    blockerAdds?: Array<{ id: string; blockerId: string }>
    blockerRemovals?: Array<{ id: string; blockerId: string }>
  },
  known: string[] = [],
) {
  return (
    config: TicketsConfig,
    env: Record<string, string | undefined>,
    targetRepo: string,
  ): TicketSource => {
    created.config = config
    created.env = env
    created.targetRepo = targetRepo
    return {
      name: 'fake',
      listReady: () => Promise.resolve([]),
      get: () => Promise.resolve(null),
      claim: () => Promise.resolve(false),
      comment: () => Promise.resolve(),
      transition: () => Promise.resolve(),
      update: (id, patch) => {
        created.update = {
          id,
          patch: {
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.body !== undefined ? { body: patch.body } : {}),
            ...(patch.labels !== undefined ? { labels: [...patch.labels] } : {}),
          },
        }
        return Promise.resolve()
      },
      addBlocker: (id, blockerId) => {
        ;(created.blockerAdds ??= []).push({ id, blockerId })
        return Promise.resolve()
      },
      removeBlocker: (id, blockerId) => {
        ;(created.blockerRemovals ??= []).push({ id, blockerId })
        return Promise.resolve()
      },
      dependencyStates: (ids: string[]) =>
        Promise.resolve(
          ids.map((id) => ({
            id,
            exists: known.includes(id),
            resolved: false,
            blockedBy: [],
          })),
        ),
      create: (draft: TicketDraft): Promise<Ticket> => {
        created.draft = draft
        return Promise.resolve({
          ref: { source: 'fake', id: 'fake-1', url: 'https://example.test/fake-1' },
          title: draft.title,
          body: draft.body,
          state: 'Triage',
          labels: draft.labels ?? [],
          ...(draft.blockedBy !== undefined ? { blockedBy: draft.blockedBy } : {}),
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

    // The CLI hands the factory the config verbatim plus the repo: resolving a
    // relative dir (and deciding it was defaulted) is the factory's job now.
    expect(created.config).toEqual({
      source: 'file',
      readyState: 'ready',
      dir: 'tickets',
    })
    expect(created.targetRepo).toBe(tmp)
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
    // Triage is the directory, not a frontmatter field — new tickets land in
    // <dir>/triage/ (the printed state above is read back off that directory).
    const written = await readFile(join(tmp, 'tickets', 'triage', 'file-1.md'), 'utf8')
    expect(written).toContain('title = "Real file ticket"')
    expect(written).toContain('the spec body')
    expect(written).not.toContain('state =')
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

  test('a config without [tickets] fails at the mandatory ready-state path', async () => {
    await writeFile(
      join(tmp, 'autobuild.toml'),
      '[project]\nbaseBranch = "main"\n',
    )
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, '## What and why\n\nBecause.\n')

    await expect(
      abTicketCreate({
        targetRepo: tmp,
        title: 'Rate-limit auth',
        bodyFile,
        env: {},
        stdout: () => {},
      }),
    ).rejects.toThrow('tickets.readyState')
  })

  test('an explicit file source with no dir uses .autobuild/tickets', async () => {
    await writeRepo('[tickets]\nsource = "file"\n')
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, '## What and why\n\nBecause.\n')
    const lines: string[] = []

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Rate-limit auth',
      bodyFile,
      env: {},
      stdout: (line) => lines.push(line),
    })

    const path = join(tmp, '.autobuild', 'tickets', 'triage', 'file-1.md')
    expect(await readFile(path, 'utf8')).toContain('title = "Rate-limit auth"')
    expect(lines).toEqual(['ticket created: file:file-1 (Triage)'])
  })

  test('AB_STORE relocates the default file tracker with local state', async () => {
    await writeRepo('[tickets]\nsource = "file"\n')
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Alternate tracker',
      bodyFile,
      env: { AB_STORE: 'alternate-state' },
      stdout: () => {},
    })

    expect(
      await readFile(
        join(tmp, 'alternate-state', 'tickets', 'triage', 'file-1.md'),
        'utf8',
      ),
    ).toContain('title = "Alternate tracker"')
  })

  test('normalizes a linked-worktree cwd before resolving default file tickets', async () => {
    await writeRepo('[tickets]\nsource = "file"\n')
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')

    await abTicketCreate({
      targetRepo: join(tmp, 'linked-worktree'),
      exec: async () => ({
        stdout: `${join(tmp, '.git')}\n${join(tmp, '.git')}\n${tmp}\n`,
        stderr: '',
        exitCode: 0,
      }),
      title: 'Main tracker only',
      bodyFile,
      env: {},
      stdout: () => {},
    })

    expect(
      await readFile(join(tmp, '.autobuild', 'tickets', 'triage', 'file-1.md'), 'utf8'),
    ).toContain('title = "Main tracker only"')
  })

  test('--blocked-by reaches the draft and the success line names the blockers', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const created: Parameters<typeof fakeFactory>[0] = {}
    const out: string[] = []

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Dependent work',
      bodyFile,
      blockedBy: ['AUT-8', 'AUT-9'],
      env: {},
      stdout: (line) => out.push(line),
      sourceFactory: fakeFactory(created, ['AUT-8', 'AUT-9']),
    })

    expect(created.draft?.blockedBy).toEqual(['AUT-8', 'AUT-9'])
    expect(out).toEqual([
      'ticket created: fake:fake-1 (Triage) — blocked by AUT-8, AUT-9 — https://example.test/fake-1',
    ])
  })

  test('an unknown blocker is an actionable error and NO ticket is created', async () => {
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
    ).rejects.toThrow(/--blocked-by: no ticket "AUT-99" in the configured fake/)
    // Validation precedes creation: nothing was filed.
    expect(created.draft).toBeUndefined()
  })

  test('duplicate blocker ids are deduped rather than rejected', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const created: Parameters<typeof fakeFactory>[0] = {}

    await abTicketCreate({
      targetRepo: tmp,
      title: 'Dependent work',
      bodyFile,
      blockedBy: ['AUT-8', 'AUT-8'],
      env: {},
      stdout: () => {},
      sourceFactory: fakeFactory(created, ['AUT-8']),
    })

    expect(created.draft?.blockedBy).toEqual(['AUT-8'])
  })

  test('with source = "file", --blocked-by records the blocker in TOML frontmatter', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'blocker body\n')
    await abTicketCreate({
      targetRepo: tmp,
      title: 'Blocker',
      bodyFile,
      env: {},
      stdout: () => {},
    })

    const out: string[] = []
    await abTicketCreate({
      targetRepo: tmp,
      title: 'Dependent',
      bodyFile,
      blockedBy: ['file-1'],
      env: {},
      stdout: (line) => out.push(line),
    })

    expect(out).toEqual(['ticket created: file:file-2 (Triage) — blocked by file-1'])
    const written = await readFile(join(tmp, 'tickets', 'triage', 'file-2.md'), 'utf8')
    expect(written).toContain('blockedBy = [ "file-1" ]')
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

describe('abTicket update/block/unblock', () => {
  test('update builds one partial patch from flags and prints a stable confirmation', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'replacement.md')
    await writeFile(bodyFile, 'replacement spec\n')
    const created: Parameters<typeof fakeFactory>[0] = {}
    const out: string[] = []

    await abTicketUpdate({
      targetRepo: tmp,
      id: 'AUT-7',
      title: 'Renamed ticket',
      bodyFile,
      labels: [],
      env: { LINEAR_API_KEY: 'secret' },
      stdout: (line) => out.push(line),
      sourceFactory: fakeFactory(created),
    })

    expect(created.update).toEqual({
      id: 'AUT-7',
      patch: {
        title: 'Renamed ticket',
        body: 'replacement spec\n',
        labels: [],
      },
    })
    expect(created.env).toEqual({ LINEAR_API_KEY: 'secret' })
    expect(out).toEqual(['ticket updated: fake:AUT-7'])
  })

  test('block and unblock preserve target/blocker ordering through the source', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const created: Parameters<typeof fakeFactory>[0] = {}
    const out: string[] = []
    const common = {
      targetRepo: tmp,
      id: 'AUT-9',
      blockerId: 'AUT-8',
      env: {},
      stdout: (line: string) => out.push(line),
      sourceFactory: fakeFactory(created),
    }

    await abTicketBlock(common)
    await abTicketUnblock(common)

    expect(created.blockerAdds).toEqual([{ id: 'AUT-9', blockerId: 'AUT-8' }])
    expect(created.blockerRemovals).toEqual([
      { id: 'AUT-9', blockerId: 'AUT-8' },
    ])
    expect(out).toEqual([
      'ticket blocker added: fake:AUT-9 — blocked by AUT-8',
      'ticket blocker removed: fake:AUT-9 — no longer blocked by AUT-8',
    ])
  })

  test('a missing update body file fails before constructing or mutating a source', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const created: Parameters<typeof fakeFactory>[0] = {}

    await expect(
      abTicketUpdate({
        targetRepo: tmp,
        id: 'AUT-7',
        bodyFile: join(tmp, 'missing.md'),
        env: {},
        stdout: () => {},
        sourceFactory: fakeFactory(created),
      }),
    ).rejects.toThrow(/--body .*missing\.md: file not found/)
    expect(created.config).toBeUndefined()
    expect(created.update).toBeUndefined()
  })
})

describe('runCli — ticket routing', () => {
  function sessionlessDeps() {
    const out: string[] = []
    const err: string[] = []
    return {
      deps: {
        workspacePath: tmp,
        exec: async () => ({
          stdout: `${join(tmp, '.git')}\n${join(tmp, '.git')}\n${tmp}\n`,
          stderr: '',
          exitCode: 0,
        }),
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

  test('--blocked-by parses comma-separated ids and reaches the source', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps, out } = sessionlessDeps()
    expect(await runCli(['ticket', 'create', 'Blocker', '--body', bodyFile], deps)).toBe(0)
    expect(
      await runCli(
        ['ticket', 'create', 'Dependent', '--body', bodyFile, '--blocked-by', 'file-1'],
        deps,
      ),
    ).toBe(0)
    expect(out.join('\n')).toContain('ticket created: file:file-2 (Triage) — blocked by file-1')
  })

  test('an unknown --blocked-by id exits nonzero with the actionable error', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps, err } = sessionlessDeps()
    expect(
      await runCli(
        ['ticket', 'create', 'Dependent', '--body', bodyFile, '--blocked-by', 'file-404'],
        deps,
      ),
    ).toBe(1)
    expect(err.join('\n')).toContain('--blocked-by: no ticket "file-404"')
  })

  test('update partially replaces a real file ticket and explicit empty labels clear', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const originalBody = join(tmp, 'original.md')
    const replacementBody = join(tmp, 'replacement.md')
    await writeFile(originalBody, 'original body\n')
    await writeFile(replacementBody, 'replacement body\n')
    const { deps, out } = sessionlessDeps()

    expect(
      await runCli(
        [
          'ticket',
          'create',
          'Original title',
          '--body',
          originalBody,
          '--labels',
          'bug,api',
        ],
        deps,
      ),
    ).toBe(0)
    expect(
      await runCli(
        [
          'ticket',
          'update',
          'file-1',
          '--title',
          'Renamed title',
          '--body',
          replacementBody,
        ],
        deps,
      ),
    ).toBe(0)

    const path = join(tmp, 'tickets', 'triage', 'file-1.md')
    let written = await readFile(path, 'utf8')
    expect(written).toContain('title = "Renamed title"')
    expect(written).toContain('labels = [ "bug", "api" ]')
    expect(written).toContain('replacement body')
    expect(written).not.toContain('original body')
    expect(written).not.toContain('state =')

    expect(
      await runCli(
        ['ticket', 'update', 'file-1', '--labels', ''],
        deps,
      ),
    ).toBe(0)
    written = await readFile(path, 'utf8')
    expect(written).not.toContain('labels =')
    expect(written).toContain('replacement body')
    expect(out).toContain('ticket updated: file:file-1')
  })

  test('block/unblock are idempotent against the real configured file source', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps, out } = sessionlessDeps()
    await runCli(['ticket', 'create', 'Blocker', '--body', bodyFile], deps)
    await runCli(['ticket', 'create', 'Dependent', '--body', bodyFile], deps)

    expect(
      await runCli(['ticket', 'block', 'file-2', 'file-1'], deps),
    ).toBe(0)
    expect(
      await runCli(['ticket', 'block', 'file-2', 'file-1'], deps),
    ).toBe(0)
    const path = join(tmp, 'tickets', 'triage', 'file-2.md')
    const blocked = await readFile(path, 'utf8')
    expect((blocked.match(/file-1/g) ?? [])).toHaveLength(1)

    expect(
      await runCli(['ticket', 'unblock', 'file-2', 'file-1'], deps),
    ).toBe(0)
    expect(
      await runCli(['ticket', 'unblock', 'file-2', 'file-404'], deps),
    ).toBe(0)
    expect(await readFile(path, 'utf8')).not.toContain('blockedBy')
    expect(out).toContain(
      'ticket blocker added: file:file-2 — blocked by file-1',
    )
    expect(out).toContain(
      'ticket blocker removed: file:file-2 — no longer blocked by file-1',
    )
  })

  test('new write failures name self, missing blocker, unknown target, and invalid fields', async () => {
    await writeRepo(FILE_TICKETS_TOML)
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps, err } = sessionlessDeps()
    await runCli(['ticket', 'create', 'Target', '--body', bodyFile], deps)

    expect(
      await runCli(['ticket', 'block', 'file-1', 'file-1'], deps),
    ).toBe(1)
    expect(err.at(-1)).toContain('file-1')
    expect(
      await runCli(['ticket', 'block', 'file-1', 'file-404'], deps),
    ).toBe(1)
    expect(err.at(-1)).toContain('file-404')
    expect(
      await runCli(['ticket', 'update', 'file-404', '--title', 'New'], deps),
    ).toBe(1)
    expect(err.at(-1)).toContain('file-404')
    expect(
      await runCli(['ticket', 'update', 'file-1', '--title', '   '], deps),
    ).toBe(1)
    expect(err.at(-1)).toContain('title')
    expect((await readFile(join(tmp, 'tickets', 'triage', 'file-1.md'), 'utf8'))).not.toContain(
      'blockedBy',
    )
  })

  test('ticket grammars reject missing fields, extra ids, and unknown flags', async () => {
    const cases = [
      ['ticket', 'update', 'file-1'],
      ['ticket', 'update', 'file-1', '--title', 'x', 'extra'],
      ['ticket', 'update', 'file-1', '--state', 'Done'],
      ['ticket', 'block', 'file-1'],
      ['ticket', 'block', 'file-1', 'file-2', 'extra'],
      ['ticket', 'unblock', 'file-1', 'file-2', '--force'],
    ]
    for (const argv of cases) {
      const { deps, err } = sessionlessDeps()
      expect(await runCli(argv, deps)).toBe(1)
      expect(err.join('\n')).toContain('usage: ab ticket')
    }
  })

  test('update resolves an autobuild worktree cwd back to the main tracker', async () => {
    await writeRepo('[tickets]\nsource = "file"\n')
    const bodyFile = join(tmp, 'spec.md')
    await writeFile(bodyFile, 'body\n')
    const { deps } = sessionlessDeps()
    await runCli(['ticket', 'create', 'Original', '--body', bodyFile], deps)
    deps.workspacePath = join(tmp, 'linked-worktree')

    expect(
      await runCli(
        ['ticket', 'update', 'file-1', '--title', 'From worktree'],
        deps,
      ),
    ).toBe(0)
    expect(
      await readFile(
        join(tmp, '.autobuild', 'tickets', 'triage', 'file-1.md'),
        'utf8',
      ),
    ).toContain('title = "From worktree"')
  })
})
