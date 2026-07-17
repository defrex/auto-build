import { describe, expect, test } from 'bun:test'
import { KERNEL } from '../../events/envelope'
import { MemoryBuildStore } from '../../store/memory'
import { projectHarvest } from './model'
import { renderDashboard, stripAnsi } from './render'

describe('dashboard harvest row', () => {
  test('projects the staged run, keeps terminal runs visible, and renders a literal nonselectable marker', async () => {
    const store = new MemoryBuildStore()
    await store.ensureRepo('/repo')
    await store.appendRepoWithArtifacts(
      '/repo',
      [{ kind: 'harvest-scan', content: '{}' }],
      (deposited) => ({
        actor: KERNEL,
        type: 'harvest.started',
        payload: {
          run: 'h_1',
          observations: [{ build: 'a', seq: 1 }],
          scan: { kind: deposited[0]!.kind, rev: deposited[0]!.revision },
        },
      }),
    )
    for (const step of ['scan', 'synthesize'] as const) {
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.step.started',
        payload: { run: 'h_1', step, ...(step === 'synthesize' ? { round: 2 } : {}) },
      })
      await store.appendRepo('/repo', {
        actor: KERNEL,
        type: 'harvest.step.completed',
        payload: {
          run: 'h_1',
          step,
          outcome: 'completed',
          ...(step === 'synthesize' ? { round: 2 } : {}),
        },
      })
    }
    const projected = projectHarvest(await store.getRepoEvents('/repo'))
    expect(projected?.kind).toBe('harvest')
    expect(projected?.steps.map((step) => step.label)).toEqual([
      'scan',
      'synthesize',
      'review',
      'file',
    ])
    expect(projected?.rounds).toBe(2)

    const lines = renderDashboard(
      {
        repo: '/repo',
        mode: 'watch',
        capacity: 2,
        drained: false,
        builds: [],
        harvest: projected!,
      },
      { color: true, width: 100, height: 20, now: Date.now() },
    )
    const plain = stripAnsi(lines.join('\n'))
    expect(plain).toContain('HARVEST')
    expect(plain).toContain('h_1')
    expect(plain).not.toContain('> HARVEST')
  })
})
