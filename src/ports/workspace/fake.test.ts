import { describe, expect, test } from 'bun:test'
import { FakeWorkspaceProvider } from './fake'

const OPTS = { repo: '/repos/origin', baseBranch: 'main', branch: 'ab/fix-login' }

describe('FakeWorkspaceProvider', () => {
  test('provision returns <root>/<branch> with ref === path and journals', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws' })
    const handle = await provider.provision(OPTS)
    expect(handle).toEqual({
      provider: 'fake',
      ref: '/ws/ab/fix-login',
      path: '/ws/ab/fix-login',
      branch: 'ab/fix-login',
      base: { source: 'remote', sha: 'fake-base-sha' },
    })
    expect(provider.provisions).toEqual([OPTS])
    expect(provider.isActive(handle.ref)).toBe(true)
  })

  test('provision distinguishes first creation from idempotent reuse', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws' })
    const first = await provider.provision(OPTS)
    const second = await provider.provision(OPTS)
    expect(second).toEqual({
      ...first,
      base: { source: 'existing', sha: 'fake-base-sha' },
    })
    expect(provider.provisions).toHaveLength(2)
  })

  test('configured fallback evidence is returned and the branch head survives release', async () => {
    const provider = new FakeWorkspaceProvider({
      root: '/ws',
      base: {
        source: 'local',
        sha: 'local-sha',
        remoteError: 'origin unavailable',
      },
    })
    const first = await provider.provision(OPTS)
    expect(first.base).toEqual({
      source: 'local',
      sha: 'local-sha',
      remoteError: 'origin unavailable',
    })

    provider.setBranchHead(OPTS.branch, 'implemented-sha')
    await provider.release(first)
    const resumed = await provider.provision(OPTS)
    expect(resumed.base).toEqual({
      source: 'existing',
      sha: 'implemented-sha',
    })
  })

  test('release journals and is idempotent', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws' })
    const handle = await provider.provision(OPTS)
    await provider.release(handle)
    expect(provider.isActive(handle.ref)).toBe(false)
    // Releasing again (or releasing something never provisioned) is a no-op.
    await provider.release(handle)
    expect(provider.releases).toHaveLength(2)
  })

  test('setFailure makes the named operation throw until cleared', async () => {
    const provider = new FakeWorkspaceProvider({ root: '/ws' })
    provider.setFailure('provision', new Error('disk full'))
    await expect(provider.provision(OPTS)).rejects.toThrow('disk full')
    expect(provider.provisions).toEqual([]) // failed calls are not journaled

    provider.setFailure('provision', null)
    const handle = await provider.provision(OPTS)

    provider.setFailure('release', new Error('locked'))
    await expect(provider.release(handle)).rejects.toThrow('locked')
    expect(provider.releases).toEqual([])
    expect(provider.isActive(handle.ref)).toBe(true)
  })
})
