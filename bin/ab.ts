#!/usr/bin/env bun
/**
 * The `ab` binary — thin wiring only (SPEC §8). Every behavior lives in
 * src/cli/ behind injected deps; this file resolves the real ones: ambient
 * auth from the environment (D8), the store from AB_STORE (local path or
 * http(s) URL), the GitHub forge, real exec, wall clock, random ids.
 */
import { runCli } from '../src/cli/main'
import { resolveCliEnv } from '../src/cli/env'
import { resolveStore } from '../src/cli/store-ref'
import { RemoteBuildStore } from '../src/store/remote/client'
import { GitHubForge } from '../src/ports/forge/github'
import { spawnExec } from '../src/ports/workspace/git-worktree'
import { randomIds } from '../src/ids'
import { systemClock } from '../src/store/types'

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const command = argv[0]

  // init/upgrade/help run OUTSIDE build sessions (SPEC §16.3): they take a
  // repo path, not a build, so they must work with no AB_* environment set.
  if (
    command === undefined ||
    ['init', 'upgrade', 'help', '--help', '-h'].includes(command)
  ) {
    return runCli(argv, {
      workspacePath: process.cwd(),
      exec: spawnExec,
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    })
  }

  let cliEnv
  try {
    cliEnv = resolveCliEnv(process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }

  const store = resolveStore(cliEnv.store, {
    token: cliEnv.token,
    remoteFactory: (url, token) => new RemoteBuildStore({ url, token }),
  })

  try {
    return await runCli(argv, {
      store,
      env: cliEnv,
      workspacePath: process.cwd(),
      forge: new GitHubForge(),
      exec: spawnExec,
      ids: randomIds(),
      clock: systemClock,
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    })
  } finally {
    await store.close()
  }
}

process.exit(await main())
