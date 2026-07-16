/**
 * The live region (src/cli/dashboard/live.ts) over a fake TerminalOut, so the
 * escape traffic itself is the assertion.
 */
import { describe, expect, test } from 'bun:test'
import { LiveRegion } from './live'
import type { TerminalOut } from '../terminal'

function fakeTerm(): TerminalOut & { writes: string[]; all: () => string } {
  const writes: string[] = []
  return {
    writes,
    all: () => writes.join(''),
    write: (chunk) => {
      writes.push(chunk)
    },
    columns: 80,
    interactive: true,
  }
}

const CURSOR_UP = (n: number): string => `\x1b[${n}A`
const CLEAR_TO_END = '\x1b[0J'

describe('LiveRegion: the region does not accumulate', () => {
  test('a changed frame erases the previous one before repainting', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['one', 'two'])
    const before = term.all()
    expect(before).toContain('one\ntwo\n')

    region.update(['one', 'three'])
    const added = term.all().slice(before.length)
    // Two lines painted ⇒ cursor up two, clear to end, then repaint.
    expect(added).toContain(CURSOR_UP(2) + CLEAR_TO_END)
    expect(added).toContain('one\nthree\n')
  })

  test('the erase counts the LINES ACTUALLY PAINTED, not the new frame', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['a', 'b', 'c'])
    const before = term.all().length
    region.update(['x'])
    expect(term.all().slice(before)).toContain(CURSOR_UP(3))
  })

  test('the first frame has nothing to erase', () => {
    const term = fakeTerm()
    new LiveRegion(term).update(['one'])
    expect(term.all()).not.toContain('\x1b[0A')
    expect(term.all()).not.toContain(CLEAR_TO_END)
  })
})

describe('LiveRegion: an identical frame writes nothing', () => {
  test('a repeat update is a no-op — the frame is a pure function of state', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['one', 'two'])
    const before = term.writes.length
    region.update(['one', 'two'])
    region.update(['one', 'two'])
    expect(term.writes.length).toBe(before)
  })
})

describe('LiveRegion: log() keeps the region last on screen', () => {
  test('the line lands BEFORE the repainted frame, and the frame survives', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['frame-a', 'frame-b'])
    const out: string[] = []

    region.log('a diagnostic', (line) => out.push(line))

    expect(out).toEqual(['a diagnostic'])
    const tail = term.all()
    // Erased, then repainted — so the message scrolls ABOVE a frame that is
    // still the last thing on screen.
    expect(tail).toContain(CURSOR_UP(2) + CLEAR_TO_END)
    expect(tail.endsWith('frame-a\nframe-b\n')).toBe(true)
  })

  test('the line goes to the SINK, never to the region terminal (the stderr guard)', () => {
    // The region changes WHEN a line is written, never WHICH stream — a stderr
    // diagnostic must stay on stderr even while stdout is a TTY.
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['frame'])
    const stderr: string[] = []

    region.log('runner failed', (line) => stderr.push(line))

    expect(stderr).toEqual(['runner failed'])
    expect(term.all()).not.toContain('runner failed')
  })

  test('logging with no frame painted just writes the line', () => {
    const term = fakeTerm()
    const out: string[] = []
    new LiveRegion(term).log('early', (line) => out.push(line))
    expect(out).toEqual(['early'])
    expect(term.all()).not.toContain(CLEAR_TO_END)
  })
})

describe('LiveRegion: the cursor', () => {
  test('hidden on the first paint, restored by finish()', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['frame'])
    expect(term.all()).toContain('\x1b[?25l')
    region.finish()
    expect(term.all()).toContain('\x1b[?25h')
  })

  test('finish() on an unpainted region leaves no escapes at all', () => {
    const term = fakeTerm()
    new LiveRegion(term).finish()
    expect(term.all()).toBe('')
  })
})

describe('LiveRegion: finish() leaves the last frame on screen', () => {
  test('the final frame stays painted, with no erase after it', () => {
    // The last frame is the answer the operator ran the command for — `git log`
    // and a finished progress bar both leave their output up. Erasing it would
    // make the exit render pointless work.
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['final-frame'])
    const beforeFinish = term.all().length

    region.finish()

    const after = term.all().slice(beforeFinish)
    expect(after).not.toContain(CLEAR_TO_END)
    expect(after).not.toContain('\x1b[1A')
    expect(term.all()).toContain('final-frame\n')
  })

  test('finish() is idempotent and stops tracking — nothing cursors up afterwards', () => {
    const term = fakeTerm()
    const region = new LiveRegion(term)
    region.update(['final-frame'])
    region.finish()
    region.finish()
    const before = term.all().length

    // A late update must not cursor-up over lines the region no longer owns.
    region.update(['late'])
    expect(term.all().length).toBe(before)

    // A late log still delivers its line — it just does not touch the region.
    const out: string[] = []
    region.log('late line', (line) => out.push(line))
    expect(out).toEqual(['late line'])
    expect(term.all().length).toBe(before)
  })
})
