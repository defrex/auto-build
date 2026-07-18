/**
 * Repository identity and sessionless local-state resolution.
 *
 * One resolver owns both concepts because they must agree in linked worktrees:
 * Git's common directory identifies the main checkout, whose `.autobuild/`
 * directory is the implicit state root. Local overrides are normalized against
 * that checkout so the dispatcher and agents cannot interpret a relative path
 * from different working directories.
 */
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Exec } from '../ports/workspace/git-worktree'

export const LOCAL_STATE_DIR = '.autobuild'

export function isRemoteStoreRef(ref: string): boolean {
  return /^https?:\/\//i.test(ref)
}

/**
 * Resolve the main checkout from Git's common directory. In a linked worktree,
 * `--show-toplevel` names the worktree itself, while `--git-common-dir` names
 * the main checkout's `.git` directory from either location.
 *
 * Outside Git (or when Git cannot be executed), the resolved target directory
 * is the deterministic fallback.
 */
export async function resolveMainRepo(targetRepo: string, exec: Exec): Promise<string> {
  const target = resolve(targetRepo)
  try {
    const result = await exec(
      ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: target },
    )
    if (result.exitCode !== 0) return target
    const output = result.stdout.trim()
    if (output === '') return target
    const commonDir = isAbsolute(output) ? resolve(output) : resolve(target, output)
    return dirname(commonDir)
  } catch {
    return target
  }
}

export interface RepoStatePaths {
  /** Main checkout used as repository identity in BuildStore records/journals. */
  repo: string
  /** The only implicit local state root. */
  defaultLocalRoot: string
  /** Normalized local path, or an unchanged HTTP(S) URL. */
  storeRef: string
  /** Root for local-only state (tickets and worktrees). */
  localStateRoot: string
  /** Local scratch root used by GitWorktreeProvider. */
  worktreeRoot: string
}

function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value : undefined
}

/**
 * Select state with one precedence rule for every sessionless command:
 * non-blank explicit `--store` > non-blank `AB_STORE` > repository-local default.
 *
 * A local selection relocates the whole local tree, including worktrees. A
 * remote store has no filesystem root, so its worktrees remain local beneath
 * the repository's implicit state root.
 */
export function resolveRepoStatePaths(opts: {
  repo: string
  storeRef?: string
  envStore?: string
}): RepoStatePaths {
  const repo = resolve(opts.repo)
  const defaultLocalRoot = join(repo, LOCAL_STATE_DIR)
  const selected = nonBlank(opts.storeRef) ?? nonBlank(opts.envStore) ?? defaultLocalRoot
  const remote = isRemoteStoreRef(selected)
  const storeRef = remote ? selected : resolve(repo, selected)
  const localStateRoot = remote ? defaultLocalRoot : storeRef
  return {
    repo,
    defaultLocalRoot,
    storeRef,
    localStateRoot,
    worktreeRoot: join(localStateRoot, 'worktrees'),
  }
}

/** Resolve repository identity, then select all state paths from it. */
export async function resolveRepoState(opts: {
  targetRepo: string
  exec: Exec
  storeRef?: string
  envStore?: string
}): Promise<RepoStatePaths> {
  const repo = await resolveMainRepo(opts.targetRepo, opts.exec)
  return resolveRepoStatePaths({
    repo,
    ...(opts.storeRef !== undefined ? { storeRef: opts.storeRef } : {}),
    ...(opts.envStore !== undefined ? { envStore: opts.envStore } : {}),
  })
}
