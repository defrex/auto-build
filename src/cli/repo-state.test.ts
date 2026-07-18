import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'
import { spawnExec } from '../ports/workspace/git-worktree'
import {
  resolveMainRepo,
  resolveRepoState,
  resolveRepoStatePaths,
} from './repo-state'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await spawnExec(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
}

describe('resolveMainRepo', () => {
  test('uses the absolute Git common directory', async () => {
    const exec: Exec = async (cmd, opts) => {
      expect(cmd).toEqual([
        'git',
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ])
      expect(opts.cwd).toBe('/worktree')
      return { stdout: '/main/repo/.git\n', stderr: '', exitCode: 0 }
    }
    expect(await resolveMainRepo('/worktree', exec)).toBe('/main/repo')
  })

  test('falls back to the resolved target when Git is unavailable', async () => {
    const exec: Exec = async () => {
      throw new Error('git unavailable')
    }
    expect(await resolveMainRepo('./plain-directory', exec)).toBe(
      resolve('./plain-directory'),
    )
  })

  test('returns the main checkout from both a checkout and a linked worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ab-repo-state-'))
    cleanup.push(root)
    const main = join(root, 'main')
    const linked = join(root, 'linked')
    await git(root, 'init', '-b', 'main', main)
    await git(main, 'config', 'user.email', 'test@example.com')
    await git(main, 'config', 'user.name', 'Test')
    await Bun.write(join(main, 'README.md'), 'fixture\n')
    await git(main, 'add', 'README.md')
    await git(main, 'commit', '-m', 'fixture')
    await git(main, 'worktree', 'add', '-b', 'linked', linked)

    const canonicalMain = await realpath(main)
    expect(await resolveMainRepo(main, spawnExec)).toBe(canonicalMain)
    expect(await resolveMainRepo(linked, spawnExec)).toBe(canonicalMain)
  })
})

describe('resolveRepoStatePaths', () => {
  const repo = '/code/example'

  test('defaults every local path beneath the repository state root', () => {
    expect(resolveRepoStatePaths({ repo })).toEqual({
      repo,
      defaultLocalRoot: '/code/example/.autobuild',
      storeRef: '/code/example/.autobuild',
      localStateRoot: '/code/example/.autobuild',
      worktreeRoot: '/code/example/.autobuild/worktrees',
    })
  })

  test('normalizes relative and absolute local overrides and moves worktrees', () => {
    expect(resolveRepoStatePaths({ repo, storeRef: 'state/../state' })).toMatchObject({
      storeRef: '/code/example/state',
      worktreeRoot: '/code/example/state/worktrees',
    })
    expect(resolveRepoStatePaths({ repo, storeRef: '/var/lib/ab' })).toMatchObject({
      storeRef: '/var/lib/ab',
      worktreeRoot: '/var/lib/ab/worktrees',
    })
  })

  test('preserves remote URLs and keeps their worktrees repository-local', () => {
    expect(
      resolveRepoStatePaths({ repo, storeRef: 'https://store.example/api' }),
    ).toMatchObject({
      storeRef: 'https://store.example/api',
      worktreeRoot: '/code/example/.autobuild/worktrees',
    })
  })

  test('uses flag over environment over default and ignores a blank environment value', () => {
    expect(
      resolveRepoStatePaths({ repo, storeRef: 'flag', envStore: 'environment' }).storeRef,
    ).toBe('/code/example/flag')
    expect(resolveRepoStatePaths({ repo, envStore: 'environment' }).storeRef).toBe(
      '/code/example/environment',
    )
    expect(resolveRepoStatePaths({ repo, envStore: '  ' }).storeRef).toBe(
      '/code/example/.autobuild',
    )
  })
})

test('resolveRepoState selects paths after resolving repository identity', async () => {
  const exec: Exec = async () => ({
    stdout: '/main/repo/.git\n',
    stderr: '',
    exitCode: 0,
  })
  expect(
    await resolveRepoState({
      targetRepo: '/linked',
      exec,
      envStore: 'shared-state',
    }),
  ).toMatchObject({
    repo: '/main/repo',
    storeRef: '/main/repo/shared-state',
    worktreeRoot: '/main/repo/shared-state/worktrees',
  })
})
