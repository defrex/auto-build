/**
 * The renderer (src/cli/dashboard/render.ts) — pure, so every AC about what
 * the operator can SEE is assertable here without a terminal.
 */
import { describe, expect, test } from 'bun:test'
import { renderDashboard, stripAnsi } from './render'
import type { DashboardBuild, DashboardModel } from './model'

function build(overrides: Partial<DashboardBuild> = {}): DashboardBuild {
  return {
    slug: 'auth-rate-limit',
    status: 'running',
    alsoPaused: false,
    ticketId: 'ENG-42',
    phase: 'implement',
    steps: [
      { label: 'plan', state: 'done' },
      { label: 'implement', state: 'current', note: 'r2' },
      { label: 'verify:test', state: 'pending' },
    ],
    blockers: [],
    ...overrides,
  }
}

function model(builds: DashboardBuild[]): DashboardModel {
  return { repo: '/repos/app', mode: 'watch', capacity: 2, builds }
}

const WIDE = { color: false, width: 200 }

describe('renderDashboard: the header', () => {
  test('names the repo, the mode and the capacity', () => {
    const [header] = renderDashboard(model([build()]), WIDE)
    expect(header).toContain('app') // the repo basename
    expect(header).toContain('watch')
    expect(header).toContain('capacity 2')
    expect(header).toContain('1 active')
  })

  test('an empty dashboard says so', () => {
    const lines = renderDashboard(model([]), WIDE)
    expect(lines.join('\n')).toContain('no active builds')
  })

  test('mode reads `once` for a single pass', () => {
    const [header] = renderDashboard({ ...model([]), mode: 'once' }, WIDE)
    expect(header).toContain('once')
  })
})

describe('renderDashboard: plain mode (the --plain AC)', () => {
  test('color: false emits NOT ONE escape byte', () => {
    const out = renderDashboard(
      model([
        build({ status: 'blocked', blockers: ['which algorithm?'] }),
        build({ slug: 'other', status: 'paused', alsoPaused: false, pr: { url: 'https://x/1', state: 'open' } }),
      ]),
      WIDE,
    ).join('\n')
    expect(out).not.toContain('\x1b')
  })

  test('the PR URL is bare in plain mode — terminals linkify it themselves', () => {
    const out = renderDashboard(
      model([build({ pr: { url: 'https://github.com/defrex/app/pull/7', state: 'open' } })]),
      WIDE,
    ).join('\n')
    expect(out).toContain('https://github.com/defrex/app/pull/7')
    expect(out).not.toContain('\x1b]8')
  })
})

describe('renderDashboard: never color-only', () => {
  test('every step state carries a glyph, and every status its literal word', () => {
    const out = renderDashboard(
      model([
        build({ status: 'blocked' }),
        build({ slug: 'b', status: 'paused' }),
        build({ slug: 'c', status: 'running' }),
      ]),
      WIDE,
    ).join('\n')
    // Steps: done / current / pending, all distinguishable with color stripped.
    expect(out).toContain('[x] plan')
    expect(out).toContain('[>] implement(r2)')
    expect(out).toContain('[ ] verify:test')
    // Statuses: words, not hues.
    expect(out).toContain('BLOCKED')
    expect(out).toContain('PAUSED')
    expect(out).toContain('RUNNING')
  })

  test('the same glyphs and words survive WITH color on', () => {
    const out = renderDashboard(model([build({ status: 'blocked' })]), { color: true, width: 200 })
    const plain = stripAnsi(out.join('\n'))
    expect(plain).toContain('[x] plan')
    expect(plain).toContain('BLOCKED')
  })
})

describe('renderDashboard: emphasis', () => {
  const colored = (b: DashboardBuild): string =>
    renderDashboard(model([b]), { color: true, width: 200 }).join('\n')

  test('blocked is red; paused is yellow', () => {
    expect(colored(build({ status: 'blocked' }))).toContain('\x1b[31m')
    expect(colored(build({ status: 'paused' }))).toContain('\x1b[33m')
  })

  test('a blocked+paused build shows BLOCKED in red AND keeps the pause visible', () => {
    const out = colored(build({ status: 'blocked', alsoPaused: true }))
    expect(out).toContain('\x1b[31m') // blocked wins the status…
    expect(stripAnsi(out)).toContain('BLOCKED')
    expect(stripAnsi(out)).toContain('(paused)') // …without losing the pause
    expect(out).toContain('\x1b[33m')
  })

  test('every unresolved blocker gets its own line', () => {
    const out = renderDashboard(
      model([build({ status: 'blocked', blockers: ['first question', 'second question'] })]),
      WIDE,
    )
    expect(out.some((l) => l.includes('first question'))).toBe(true)
    expect(out.some((l) => l.includes('second question'))).toBe(true)
  })

  test('a PR URL becomes an OSC 8 hyperlink when color is on', () => {
    const out = colored(build({ pr: { url: 'https://x/7', state: 'open' } }))
    expect(out).toContain('\x1b]8;;https://x/7\x07PR open\x1b]8;;\x07')
  })
})

describe('renderDashboard: layout', () => {
  test('columns align across builds of differing slug length', () => {
    const lines = renderDashboard(
      model([
        build({ slug: 'a', status: 'running' }),
        build({ slug: 'a-much-longer-slug', status: 'blocked' }),
      ]),
      WIDE,
    )
    const [short, long] = lines.filter((l) => l.includes('RUNNING') || l.includes('BLOCKED'))
    expect(short).toBeDefined()
    expect(long).toBeDefined()
    // Slug and status are padded to the widest in the FRAME, so every later
    // column lands at the same offset down the whole dashboard.
    expect(short!.indexOf('RUNNING')).toBe(long!.indexOf('BLOCKED'))
    expect(short!.indexOf('ENG-42')).toBe(long!.indexOf('ENG-42'))
  })

  test('builds are separated by a blank line', () => {
    const lines = renderDashboard(model([build({ slug: 'a' }), build({ slug: 'b' })]), WIDE)
    expect(lines.filter((l) => l === '')).toHaveLength(2)
  })
})

describe('renderDashboard: truncation (one rendered line = one physical row)', () => {
  // If a line exceeds the width the terminal wraps it, the painted-line count
  // under-counts, and the redraw's cursor-up clears too little — leaving
  // accumulating fragments, the exact thing the no-accumulation AC forbids.

  test('no line exceeds the width, in plain or color', () => {
    const long = build({
      slug: 'a-very-long-slug-that-goes-on'.repeat(3),
      blockers: ['a blocker message that is far too long to fit on one line'.repeat(3)],
    })
    for (const color of [false, true]) {
      const lines = renderDashboard(model([long]), { color, width: 40 })
      for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(40)
    }
  })

  test('truncation never splits an escape sequence or leaks color', () => {
    const lines = renderDashboard(
      model([build({ status: 'blocked', blockers: ['x'.repeat(200)] })]),
      { color: true, width: 30 },
    )
    for (const line of lines) {
      // Every escape we emit is a complete, well-formed sequence…
      const leftovers = line.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      expect(leftovers).not.toContain('\x1b')
      // …and a cut line still closes its color, so it cannot bleed downward.
      if (line.includes('\x1b[')) expect(line.endsWith('\x1b[0m')).toBe(true)
    }
  })

  test('a line that fits is left exactly alone', () => {
    const lines = renderDashboard(model([build()]), WIDE)
    expect(lines.some((l) => l.includes('~'))).toBe(false)
  })
})

describe('renderDashboard: the progress row WRAPS rather than truncating', () => {
  // Regression, found by rendering a realistic frame at 100 columns: a full
  // pipeline (plan → plan-review → implement → code-review → verify:* →
  // finalize → merge) does not fit, and truncating drops the tail — which is
  // `finalize` and `merge(waiting)`, i.e. exactly the steps the ACs require
  // and the ones the operator is actually waiting on. We do the wrapping, so
  // the row count stays honest AND nothing is lost.
  const full = build({
    steps: [
      { label: 'plan', state: 'done' },
      { label: 'plan-review', state: 'done' },
      { label: 'implement', state: 'done', note: 'r2' },
      { label: 'code-review', state: 'done', note: 'r2' },
      { label: 'verify:lint', state: 'done' },
      { label: 'verify:test', state: 'current', note: 'a2' },
      { label: 'finalize', state: 'pending' },
      { label: 'merge', state: 'pending', note: 'waiting' },
    ],
  })

  test('every step survives at a width the row cannot fit on one line', () => {
    const out = renderDashboard(model([full]), { color: false, width: 60 }).join('\n')
    for (const label of ['plan', 'implement(r2)', 'verify:test(a2)', 'finalize', 'merge(waiting)']) {
      expect(out).toContain(label)
    }
    expect(out).not.toContain('~') // nothing was truncated away
  })

  test('…and the width guarantee still holds on every wrapped line', () => {
    for (const width of [30, 44, 60, 100]) {
      for (const color of [false, true]) {
        const lines = renderDashboard(model([full]), { color, width })
        for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(width)
      }
    }
  })

  test('a long blocker message wraps instead of losing its tail', () => {
    // "Every unresolved blocker message is displayed" is not satisfied by its
    // first 80 characters, and a policy escalation's question routinely runs
    // longer than that.
    const blocker =
      'maxVerifyAttempts (3) exhausted: verify:test is still failing after three ' +
      'attempts and the implementer keeps reintroducing the same regression'
    const lines = renderDashboard(
      model([build({ status: 'blocked', blockers: [blocker] })]),
      { color: false, width: 50 },
    )
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(50)
    // Reassembled, the whole message is there.
    const text = lines
      .filter((l) => l.trimStart().startsWith('!') || /^\s{4}\S/.test(l))
      .join(' ')
      .replace(/\s+/g, ' ')
      .replace('! ', '')
      .trim()
    expect(text).toBe(blocker)
  })
})
