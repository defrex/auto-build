/**
 * FakeWorkspaceProvider (SPEC §3.2): in-memory WorkspaceProvider for seam
 * tests — the dispatcher's provision/release plumbing (§3.3, §15.7) and the
 * build-runner's rehydrate path (§15.6-C) run against it without touching
 * git. Every call is journaled so tests assert exactly what was provisioned
 * and released, mirroring the other fakes (FakeForge, FakeTicketSource).
 *
 * Shape parity with GitWorktreeProvider: `ref` and `path` are the same
 * string (`<root>/<branch>`), provision is idempotent per branch (resume is
 * a re-run, not a special path — constitution #2), and release of an
 * unknown or already-released workspace is a no-op, never an error.
 */
import type { WorkspaceBase } from '../../ontology'
import type {
  WorkspaceHandle,
  WorkspaceProvider,
  WorkspaceProvisionResult,
} from '../types'

export interface ProvisionRecord {
  repo: string
  baseBranch: string
  branch: string
}

export class FakeWorkspaceProvider implements WorkspaceProvider {
  readonly name = 'fake'

  /** Journals — public so tests assert directly on call order and args. */
  readonly provisions: ProvisionRecord[] = []
  readonly releases: WorkspaceHandle[] = []

  private readonly root: string
  private readonly initialBase: WorkspaceBase
  /** ref → handle for workspaces provisioned and not yet released. */
  private readonly active = new Map<string, WorkspaceHandle>()
  /** Durable fake branch heads survive release, like real Git branches. */
  private readonly branchHeads = new Map<string, string>()
  private readonly failures = new Map<'provision' | 'release', Error>()

  constructor(opts: { root?: string; base?: WorkspaceBase } = {}) {
    this.root = opts.root ?? '/fake/workspaces'
    this.initialBase = opts.base ?? { source: 'remote', sha: 'fake-base-sha' }
  }

  /**
   * Injectable failure: while set, the named operation throws `error` on
   * every call (pass `null` to clear). Lets tests drive the provision/release
   * failure paths without a real provider.
   */
  setFailure(op: 'provision' | 'release', error: Error | null): void {
    if (error === null) this.failures.delete(op)
    else this.failures.set(op, error)
  }

  /** Whether the workspace at `ref` is currently provisioned. */
  isActive(ref: string): boolean {
    return this.active.has(ref)
  }

  /** Test seam for commits made between provision calls. */
  setBranchHead(branch: string, sha: string): void {
    this.branchHeads.set(branch, sha)
  }

  async provision(opts: {
    repo: string
    baseBranch: string
    branch: string
  }): Promise<WorkspaceProvisionResult> {
    const failure = this.failures.get('provision')
    if (failure) throw failure
    this.provisions.push({ ...opts })
    const ref = `${this.root}/${opts.branch}`
    const existing = this.active.get(ref)
    if (existing) {
      return {
        ...existing,
        base: {
          source: 'existing',
          sha: this.branchHeads.get(opts.branch) ?? this.initialBase.sha,
        },
      }
    }

    const handle: WorkspaceHandle = {
      provider: this.name,
      ref,
      path: ref,
      branch: opts.branch,
    }
    this.active.set(ref, handle)

    const existingSha = this.branchHeads.get(opts.branch)
    if (existingSha !== undefined) {
      return { ...handle, base: { source: 'existing', sha: existingSha } }
    }
    this.branchHeads.set(opts.branch, this.initialBase.sha)
    return { ...handle, base: { ...this.initialBase } }
  }

  /** Idempotent: releasing an unknown or already-released handle is a no-op
   * (matching GitWorktreeProvider's already-gone-worktree behavior). */
  async release(handle: WorkspaceHandle): Promise<void> {
    const failure = this.failures.get('release')
    if (failure) throw failure
    this.releases.push({
      provider: handle.provider,
      ref: handle.ref,
      path: handle.path,
      branch: handle.branch,
    })
    this.active.delete(handle.ref)
  }
}
