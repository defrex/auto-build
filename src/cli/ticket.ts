/**
 * `ab ticket` — source-agnostic pre-build grooming (SPEC §8.8). Config selects
 * Linear or the file tracker; the command surface never reaches around the
 * TicketSource port. These commands run outside build sessions and read
 * provider secrets from the process environment, never autobuild.toml.
 */
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadConfig } from '../config/load'
import type { TicketsConfig } from '../config/schema'
import { createTicketSource } from '../ports/tickets/create'
import type { TicketSource, TicketUpdate } from '../ports/types'
import type { Exec } from '../ports/workspace/git-worktree'
import { resolveMainRepo, resolveRepoStatePaths } from './repo-state'

export type TicketSourceFactory = (
  config: TicketsConfig,
  env: Record<string, string | undefined>,
  targetRepo: string,
  localStateRoot?: string,
) => TicketSource

interface TicketCommandBaseOpts {
  targetRepo: string
  /** Process environment — adapter secrets (D8-adjacent, never in config). */
  env: Record<string, string | undefined>
  /** Git seam supplied by the CLI; omitted direct callers use the target path. */
  exec?: Exec
  stdout: (line: string) => void
  /** Injectable for tests; defaults to the real adapter factory. */
  sourceFactory?: TicketSourceFactory
}

export interface TicketCreateOpts extends TicketCommandBaseOpts {
  title: string
  /** Path to the ticket body — the spec (docs/spec-standard.md). */
  bodyFile: string
  labels?: string[]
  /** Source-local ids of tickets that must complete before this one is
   * dispatched (§13). Validated against the configured source before create. */
  blockedBy?: string[]
}

export interface TicketUpdateOpts extends TicketCommandBaseOpts {
  id: string
  title?: string
  /** Replacement body file. Omission preserves the current body. */
  bodyFile?: string
  /** Complete label replacement. An explicit [] clears labels. */
  labels?: string[]
}

export interface TicketBlockerOpts extends TicketCommandBaseOpts {
  id: string
  blockerId: string
}

interface ConfiguredSource {
  source: TicketSource
}

async function configuredSource(
  opts: TicketCommandBaseOpts,
  command: 'create' | 'update' | 'block' | 'unblock',
): Promise<ConfiguredSource> {
  const targetRepo =
    opts.exec === undefined
      ? resolve(opts.targetRepo)
      : await resolveMainRepo(opts.targetRepo, opts.exec)
  const configPath = join(targetRepo, 'autobuild.toml')
  let config
  try {
    config = await loadConfig(configPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${configPath}: not found — 'ab ticket ${command}' reads autobuild.toml ` +
          'from the resolved Git main checkout (SPEC §8.8)',
      )
    }
    throw error
  }

  const repoState = resolveRepoStatePaths({
    repo: targetRepo,
    ...(opts.env['AB_STORE'] !== undefined
      ? { envStore: opts.env['AB_STORE'] }
      : {}),
  })
  const factory = opts.sourceFactory ?? createTicketSource
  return {
    source: factory(
      config.tickets,
      opts.env,
      targetRepo,
      repoState.localStateRoot,
    ),
  }
}

async function readBody(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `--body ${path}: file not found — expected a file holding the ticket body`,
      )
    }
    throw error
  }
}

export async function abTicketCreate(opts: TicketCreateOpts): Promise<void> {
  // Read the complete body before constructing or calling a mutable source.
  const body = await readBody(opts.bodyFile)
  const { source } = await configuredSource(opts, 'create')

  // Validate blockers BEFORE creating: a ticket referencing a nonexistent
  // blocker would never dispatch, and failing here costs nothing, whereas
  // failing after create leaves a stranded ticket behind.
  const blockedBy = [...new Set(opts.blockedBy ?? [])]
  if (blockedBy.length > 0) {
    const states = await source.dependencyStates(blockedBy)
    const unknown = states.filter((state) => !state.exists).map((state) => state.id)
    if (unknown.length > 0) {
      throw new Error(
        `--blocked-by: no ticket ${unknown.map((id) => `"${id}"`).join(', ')} ` +
          `in the configured ${source.name} ticket source — blocker ids are ` +
          'source-local (e.g. AUT-8 for linear, file-1 for file)',
      )
    }
  }

  const ticket = await source.create({
    title: opts.title,
    body,
    ...(opts.labels !== undefined ? { labels: opts.labels } : {}),
    ...(blockedBy.length > 0 ? { blockedBy } : {}),
  })
  const state = ticket.state ?? 'created'
  const url = ticket.ref.url !== undefined ? ` — ${ticket.ref.url}` : ''
  const blockers =
    ticket.blockedBy !== undefined && ticket.blockedBy.length > 0
      ? ` — blocked by ${ticket.blockedBy.join(', ')}`
      : ''
  opts.stdout(
    `ticket created: ${ticket.ref.source}:${ticket.ref.id} (${state})${blockers}${url}`,
  )
}

export async function abTicketUpdate(opts: TicketUpdateOpts): Promise<void> {
  const body =
    opts.bodyFile === undefined ? undefined : await readBody(opts.bodyFile)
  const { source } = await configuredSource(opts, 'update')
  const patch: TicketUpdate = {
    ...(opts.title !== undefined ? { title: opts.title } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(opts.labels !== undefined ? { labels: [...opts.labels] } : {}),
  }
  await source.update(opts.id, patch)
  opts.stdout(`ticket updated: ${source.name}:${opts.id}`)
}

export async function abTicketBlock(opts: TicketBlockerOpts): Promise<void> {
  const { source } = await configuredSource(opts, 'block')
  await source.addBlocker(opts.id, opts.blockerId)
  opts.stdout(
    `ticket blocker added: ${source.name}:${opts.id} — blocked by ${opts.blockerId}`,
  )
}

export async function abTicketUnblock(opts: TicketBlockerOpts): Promise<void> {
  const { source } = await configuredSource(opts, 'unblock')
  await source.removeBlocker(opts.id, opts.blockerId)
  opts.stdout(
    `ticket blocker removed: ${source.name}:${opts.id} — no longer blocked by ${opts.blockerId}`,
  )
}

const CREATE_USAGE =
  'usage: ab ticket create <title> --body <file> [--labels a,b] [--blocked-by id,id] (§8.8)'
const UPDATE_USAGE =
  'usage: ab ticket update <id> [--title <title>] [--body <file>] [--labels a,b] (§8.8)'
const BLOCK_USAGE = 'usage: ab ticket block <id> <blocker-id> (§8.8)'
const UNBLOCK_USAGE = 'usage: ab ticket unblock <id> <blocker-id> (§8.8)'
export const TICKET_USAGE = [
  CREATE_USAGE,
  UPDATE_USAGE,
  BLOCK_USAGE,
  UNBLOCK_USAGE,
].join('\n')

interface ParsedTicketArgs {
  positionals: string[]
  flags: Map<string, string>
}

function parseTicketArgs(
  args: string[],
  allowedFlags: ReadonlySet<string>,
  usage: string,
): ParsedTicketArgs {
  const positionals: string[] = []
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }

    const name = arg.slice(2)
    if (!allowedFlags.has(name)) {
      throw new Error(`unknown flag --${name} — ${usage}`)
    }
    if (flags.has(name)) {
      throw new Error(`--${name} may be supplied only once — ${usage}`)
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(
        `--${name} requires a value${value !== undefined ? `, got "${value}"` : ''} — ${usage}`,
      )
    }
    flags.set(name, value)
    index += 1
  }
  return { positionals, flags }
}

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

/** Parse and execute the complete ticket argv tail. Ticket-only flags stay out
 * of the phase-command parser in main.ts. */
export async function abTicket(
  argv: string[],
  opts: TicketCommandBaseOpts,
): Promise<void> {
  const [command, ...args] = argv
  switch (command) {
    case 'create': {
      const parsed = parseTicketArgs(
        args,
        new Set(['body', 'labels', 'blocked-by']),
        CREATE_USAGE,
      )
      const title = parsed.positionals.join(' ')
      const bodyFile = parsed.flags.get('body')
      if (title === '' || bodyFile === undefined) throw new Error(CREATE_USAGE)
      const labels = parsed.flags.get('labels')
      const blockedBy = parsed.flags.get('blocked-by')
      await abTicketCreate({
        ...opts,
        title,
        bodyFile,
        ...(labels !== undefined ? { labels: commaList(labels) } : {}),
        ...(blockedBy !== undefined
          ? { blockedBy: commaList(blockedBy) }
          : {}),
      })
      return
    }

    case 'update': {
      const parsed = parseTicketArgs(
        args,
        new Set(['title', 'body', 'labels']),
        UPDATE_USAGE,
      )
      const [id, ...extra] = parsed.positionals
      if (id === undefined || extra.length > 0 || parsed.flags.size === 0) {
        throw new Error(UPDATE_USAGE)
      }
      const title = parsed.flags.get('title')
      const bodyFile = parsed.flags.get('body')
      const labels = parsed.flags.get('labels')
      await abTicketUpdate({
        ...opts,
        id,
        ...(title !== undefined ? { title } : {}),
        ...(bodyFile !== undefined ? { bodyFile } : {}),
        ...(labels !== undefined ? { labels: commaList(labels) } : {}),
      })
      return
    }

    case 'block':
    case 'unblock': {
      const usage = command === 'block' ? BLOCK_USAGE : UNBLOCK_USAGE
      const parsed = parseTicketArgs(args, new Set(), usage)
      const [id, blockerId, ...extra] = parsed.positionals
      if (id === undefined || blockerId === undefined || extra.length > 0) {
        throw new Error(usage)
      }
      const blockerOpts = { ...opts, id, blockerId }
      if (command === 'block') await abTicketBlock(blockerOpts)
      else await abTicketUnblock(blockerOpts)
      return
    }

    default:
      throw new Error(TICKET_USAGE)
  }
}
