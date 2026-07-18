/**
 * End-to-end smoke tests for the REAL `ab` binary.
 *
 * These exist because every other CLI test calls `runCli` directly and so
 * never traverses `bin/ab.ts`. That file routes sessionless commands on
 * SESSIONLESS_COMMANDS and sends everything else through `resolveCliEnv`,
 * which REQUIRES AB_STORE/AB_BUILD/AB_PHASE/AB_SESSION and returns 1 before
 * `runCli` routes anything. A command missing from the set therefore ships
 * broken while the entire unit suite stays green — a green `bun test` is not
 * evidence here, so the binary itself is executed.
 *
 * Most smoke cases point AB_STORE at a temporary override, and the session
 * keys stay unset — exactly the condition that would trip resolveCliEnv if
 * routing regressed. A separate real-Git case exercises the implicit
 * repository-local root with no override.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KERNEL } from '../events/envelope'
import { spawnExec } from '../ports/workspace/git-worktree'
import { openLocalStore } from '../store/local/store'

const BIN = join(import.meta.dir, '..', '..', 'bin', 'ab.ts')

let tmp: string

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ab-bin-'))
})

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

async function runBin(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    cwd: tmp,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: process.env['HOME'] ?? '',
      // The store is a temp dir; AB_BUILD/AB_PHASE/AB_SESSION are deliberately
      // absent — resolveCliEnv would reject on them if routing regressed.
      AB_STORE: join(tmp, 'store'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

async function runBinAt(
  cwd: string,
  args: string[],
  home: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    cwd,
    // Deliberately omit every AB_* variable: this is the implicit-root path.
    env: { PATH: process.env['PATH'] ?? '', HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  const result = await spawnExec(['git', ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout)
}

test('ab builds runs with no session environment set', async () => {
  const result = await runBin(['builds'])
  expect(result.stderr).not.toContain('AB_BUILD')
  expect(result.stderr).not.toContain('runs inside a build session')
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('no active builds')
})

test('ab builds --json emits parseable JSON and no ANSI', async () => {
  const result = await runBin(['builds', '--all', '--json'])
  expect(result.code).toBe(0)
  expect(result.stdout).not.toContain('\x1b')
  expect(JSON.parse(result.stdout)).toEqual([])
})

test('ab build status runs sessionless and exits 1 on an unknown slug', async () => {
  const result = await runBin(['build', 'status', 'no-such-build'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('no-such-build')
  expect(result.stderr).not.toContain('AB_BUILD')
})

test('implicit state is shared by a main checkout and its linked worktree and ignores HOME', async () => {
  const main = join(tmp, 'main')
  const linked = join(tmp, 'linked')
  const fakeHome = join(tmp, 'home')
  await git(tmp, 'init', '-b', 'main', main)
  await git(main, 'config', 'user.email', 'test@example.com')
  await git(main, 'config', 'user.name', 'Test')
  await writeFile(join(main, 'README.md'), 'fixture\n')
  await git(main, 'add', 'README.md')
  await git(main, 'commit', '-m', 'fixture')
  await git(main, 'worktree', 'add', '-b', 'linked', linked)

  const canonicalMain = await realpath(main)
  const local = openLocalStore(join(main, '.autobuild'))
  await local.createBuild({ slug: 'repo-build', repo: canonicalMain })
  await local.append('repo-build', {
    actor: KERNEL,
    type: 'runner.attached',
    payload: { instance: 'i1', host: 'h1', resumedFromSeq: 0 },
  })
  await local.close()

  // Poison the old machine-level shape. Repository-local resolution must never
  // discover this otherwise valid store through HOME.
  const poison = openLocalStore(join(fakeHome, '.autobuild'))
  await poison.createBuild({ slug: 'home-only', repo: canonicalMain })
  await poison.close()

  const fromMain = await runBinAt(main, ['builds', '--all', '--json'], fakeHome)
  const fromLinked = await runBinAt(linked, ['builds', '--all', '--json'], fakeHome)
  expect(fromMain.code).toBe(0)
  expect(fromLinked.code).toBe(0)
  expect(fromMain.stderr).toBe('')
  expect(fromLinked.stderr).toBe('')
  expect(JSON.parse(fromMain.stdout).map((build: { slug: string }) => build.slug)).toEqual([
    'repo-build',
  ])
  expect(JSON.parse(fromLinked.stdout)).toEqual(JSON.parse(fromMain.stdout))
})

test('a session command still demands its environment', async () => {
  // The complement: routing did not accidentally make everything sessionless.
  const result = await runBin(['context'])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain('AB_BUILD')
})
