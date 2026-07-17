import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHarvestContext, submitHarvestProposals, submitHarvestVerdict } from '../cli/harvest'
import { resolveHarvestCliEnv } from '../cli/env'
import { parseConfig } from '../config/load'
import { agentActor } from '../events/envelope'
import { sequentialIds } from '../ids'
import { reduceHarvest } from '../kernel/harvest'
import { ScriptedAgentRunner, defaultTurnResult } from '../ports/runner/fake'
import { FakeTicketSource } from '../ports/tickets/fake'
import { MemoryBuildStore } from '../store/memory'
import { steppingClock } from '../testing/fixed'
import { HarvestRunner } from './harvest-runner'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function seedObservation(store: MemoryBuildStore, build: string, summary: string): Promise<void> {
  if ((await store.getBuild(build)) === null) {
    await store.createBuild({ slug: build, repo: '/repo' })
  }
  await store.append(build, {
    actor: agentActor('implement', `s-${build}`),
    type: 'observation.recorded',
    payload: { id: `obs-${build}-${summary}`, kind: 'latent-bug', summary },
  })
}

function config(threshold = 2) {
  return parseConfig(
    `[dispatcher]\nreadyState = "Ready"\n[harvest]\nthreshold = ${threshold}\n`,
  )
}

describe('HarvestRunner', () => {
  test('revise continues one producer session and starts a fresh reviewer each round', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-revise-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    let reviewRound = 0
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts, turn }) => {
        const env = resolveHarvestCliEnv(opts.env)
        const deps = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(deps)
        if (opts.skill === 'ab-harvest') {
          if (turn === 2) {
            expect(
              JSON.parse(
                await readFile(join(workspace, '.ab', 'findings.json'), 'utf8'),
              ),
            ).toHaveLength(1)
          }
          const observations = JSON.parse(
            await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
          ) as Array<{ occurrence: { build: string; seq: number } }>
          const file = join(workspace, '.ab', `proposals-${turn}.json`)
          await writeFile(
            file,
            JSON.stringify({
              proposals: [
                {
                  action: 'create',
                  title: turn === 1 ? 'Initial title' : 'Reviewed title',
                  whatWhy: 'The observation describes an actionable defect.',
                  acceptanceCriteria: ['The defect no longer occurs.'],
                  outOfScope: ['Unrelated cleanup.'],
                  observations: observations.map((item) => item.occurrence),
                },
              ],
            }),
          )
          await submitHarvestProposals(deps, file)
        } else {
          reviewRound += 1
          const notes = join(workspace, '.ab', `review-${reviewRound}.md`)
          await writeFile(notes, reviewRound === 1 ? 'revise' : 'approve')
          if (reviewRound === 1) {
            const findings = join(workspace, '.ab', 'review-findings.json')
            await writeFile(
              findings,
              JSON.stringify([
                { severity: 'important', summary: 'Make the title specific' },
              ]),
            )
            await submitHarvestVerdict(deps, {
              verdict: 'revise',
              notes,
              findings,
            })
          } else {
            await submitHarvestVerdict(deps, { verdict: 'approve', notes })
          }
        }
        return defaultTurnResult('done')
      },
    })
    await seedObservation(store, 'one', 'first')
    const result = await new HarvestRunner({
      store,
      tickets,
      config: config(1),
      runtimes: { scripted: { runner: scripted, servesModels: [''] } },
      defaultRuntime: 'scripted',
      repo: '/repo',
      workspacePath: workspace,
      ids,
      clock: steppingClock(),
      instance: 'instance',
      opts: { heartbeatMs: 100_000 },
    }).run()
    expect(result.outcome).toBe('completed')
    const journals = [...scripted.sessions.values()]
    const producers = journals.filter((session) => session.opts.skill === 'ab-harvest')
    const reviewers = journals.filter(
      (session) => session.opts.skill === 'ab-harvest-review',
    )
    expect(producers).toHaveLength(1)
    expect(producers[0]?.turns).toHaveLength(2)
    expect(reviewers).toHaveLength(2)
    expect(reviewers.every((session) => session.turns.length === 1)).toBe(true)
    expect((await tickets.get('fake-1'))?.title).toBe('Reviewed title')
  })

  test('below threshold is idle; threshold runs reviewed workflow, files Triage, and K new observations retrigger', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'ab-harvest-runner-'))
    roots.push(workspace)
    const store = new MemoryBuildStore({ clock: steppingClock() })
    const tickets = new FakeTicketSource()
    const ids = sequentialIds()
    let reviewRounds = 0
    const scripted = new ScriptedAgentRunner({
      script: async ({ opts }) => {
        const env = resolveHarvestCliEnv(opts.env)
        const deps = { store, env, workspacePath: workspace, ids }
        await buildHarvestContext(deps)
        if (opts.skill === 'ab-harvest') {
          const observations = JSON.parse(
            await readFile(join(workspace, '.ab', 'observations.json'), 'utf8'),
          ) as Array<{ occurrence: { build: string; seq: number } }>
          const proposal = {
            proposals: [
              {
                action: 'create',
                title: 'Shared observation defect',
                whatWhy: 'The recorded behavior is a recurring product defect.',
                acceptanceCriteria: ['The recorded defect no longer occurs.'],
                outOfScope: ['Unrelated cleanup is excluded.'],
                observations: observations.map((item) => item.occurrence),
              },
            ],
          }
          const file = join(workspace, '.ab', 'submit.json')
          await writeFile(file, JSON.stringify(proposal))
          await submitHarvestProposals(deps, file)
        } else {
          reviewRounds += 1
          const notes = join(workspace, '.ab', 'review.md')
          await writeFile(notes, 'approved\n')
          await submitHarvestVerdict(deps, { verdict: 'approve', notes })
        }
        return defaultTurnResult('done')
      },
    })
    const makeRunner = () =>
      new HarvestRunner({
        store,
        tickets,
        config: config(),
        runtimes: { scripted: { runner: scripted, servesModels: [''] } },
        defaultRuntime: 'scripted',
        repo: '/repo',
        workspacePath: workspace,
        ids,
        clock: steppingClock(),
        instance: ids('instance'),
        opts: { heartbeatMs: 100_000 },
      })

    await seedObservation(store, 'one', 'first')
    expect(await makeRunner().run()).toEqual({ outcome: 'idle' })

    await seedObservation(store, 'two', 'second')
    const first = await makeRunner().run()
    expect(first.outcome).toBe('completed')
    expect(first).toMatchObject({ launch: 'started' })
    expect(reviewRounds).toBe(1)
    const state = reduceHarvest(await store.getRepoEvents('/repo'))
    expect(state.latest?.status).toBe('completed')
    expect(state.ledger).toHaveLength(2)
    expect((await tickets.get('fake-1'))?.state).toBe('Triage')
    expect(await makeRunner().run()).toEqual({ outcome: 'idle' })

    await seedObservation(store, 'three', 'third')
    expect(await makeRunner().run()).toEqual({ outcome: 'idle' })
    await seedObservation(store, 'four', 'fourth')
    expect((await makeRunner().run()).outcome).toBe('completed')
    expect(await tickets.get('fake-2')).not.toBeNull()
  })
})
