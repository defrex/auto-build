import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import {
  type CrashHandlerArgs,
  installCrashHandlers,
  SIGNAL_EXIT,
} from "./crash-handlers"

/** A fake process whose `exit` records the code instead of exiting the runner. */
class FakeProc extends EventEmitter {
  exitCode: number | null = null
  exit(code: number): never {
    this.exitCode = code
    // Not actually exiting; cast to satisfy the `never` return.
    return undefined as never
  }
}

function setup(overrides: Partial<CrashHandlerArgs> = {}) {
  const proc = new FakeProc()
  const stdout = new EventEmitter()
  const stderr = new EventEmitter()
  const lines: string[] = []
  const uncaught: { err: unknown; origin: string }[] = []
  const signals: NodeJS.Signals[] = []
  installCrashHandlers({
    logLine: (m) => lines.push(m),
    onUncaught: (err, origin) => uncaught.push({ err, origin }),
    onSignal: (sig) => signals.push(sig),
    proc: proc as unknown as CrashHandlerArgs["proc"],
    stdout: stdout as unknown as EventEmitter,
    stderr: stderr as unknown as EventEmitter,
    ...overrides,
  })
  return { proc, stdout, stderr, lines, uncaught, signals }
}

describe("SIGNAL_EXIT", () => {
  test("maps to the 128+signum codes", () => {
    expect(SIGNAL_EXIT).toEqual({ SIGINT: 130, SIGTERM: 143, SIGHUP: 129 })
  })
})

describe("installCrashHandlers — signals", () => {
  for (const [sig, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const) {
    test(`${sig} → logs, fires onSignal, exit(${code})`, () => {
      const { proc, lines, signals } = setup()
      proc.emit(sig)
      expect(lines.some((l) => l.includes(`signal: received ${sig}`))).toBe(
        true,
      )
      expect(signals).toEqual([sig])
      expect(proc.exitCode).toBe(code)
    })
  }
})

describe("installCrashHandlers — uncaught", () => {
  test("uncaughtException → logs stack, parks, exit(1)", () => {
    const { proc, lines, uncaught } = setup()
    const err = new Error("boom")
    proc.emit("uncaughtException", err)
    expect(
      lines.some((l) => l.includes("uncaught") && l.includes("boom")),
    ).toBe(true)
    expect(uncaught).toEqual([{ err, origin: "uncaughtException" }])
    expect(proc.exitCode).toBe(1)
  })

  test("unhandledRejection → parks with that origin, exit(1)", () => {
    const { proc, uncaught } = setup()
    const err = new Error("rejected")
    proc.emit("unhandledRejection", err)
    expect(uncaught[0]?.origin).toBe("unhandledRejection")
    expect(proc.exitCode).toBe(1)
  })
})

describe("installCrashHandlers — H2 stream EPIPE", () => {
  test("EPIPE on stdout logs once and does NOT exit", () => {
    const { proc, stdout, lines } = setup()
    stdout.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }))
    const epipeLines = lines.filter((l) => l.includes("stream: EPIPE"))
    expect(epipeLines.length).toBe(1)
    expect(proc.exitCode).toBeNull()
  })

  test("a second EPIPE does not log again (log-once)", () => {
    const { stdout, stderr, lines } = setup()
    const epipe = () => Object.assign(new Error("EPIPE"), { code: "EPIPE" })
    stdout.emit("error", epipe())
    stderr.emit("error", epipe())
    expect(lines.filter((l) => l.includes("stream: EPIPE")).length).toBe(1)
  })

  test("a non-EPIPE stream error rethrows", () => {
    const { stdout } = setup()
    const other = Object.assign(new Error("nope"), { code: "EOTHER" })
    expect(() => stdout.emit("error", other)).toThrow("nope")
  })
})
