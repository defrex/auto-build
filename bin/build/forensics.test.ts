import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appendCrashRecord,
  buildSignalCrashRecord,
  captureLaunchContext,
  collectAncestry,
  crashLogPath,
  describeSignalCrash,
  isPidAlive,
  launchContextPath,
  readCrashRecords,
  readLaunchContext,
} from "./forensics"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "forensics-"))
}

describe("paths", () => {
  test("crashLogPath is tracked (directly in the build dir)", () => {
    expect(crashLogPath("/repo/build/feat")).toBe(
      "/repo/build/feat/crashes.jsonl",
    )
  })

  test("launchContextPath lives under gitignored .build/", () => {
    expect(launchContextPath("/repo/build/feat")).toBe(
      "/repo/build/feat/.build/launch.json",
    )
  })
})

describe("collectAncestry", () => {
  const table: Record<number, { ppid: number; command: string }> = {
    100: { ppid: 90, command: "bun run bin/build.ts feat" },
    90: { ppid: 80, command: "bash bin/build/run.sh feat" },
    80: { ppid: 1, command: "claude" },
    1: { ppid: 0, command: "/sbin/launchd" },
  }
  const runPs = (pid: number) => table[pid] ?? null

  test("walks the parent chain up to launchd, self first", () => {
    const chain = collectAncestry(100, runPs)
    expect(chain.map((e) => e.pid)).toEqual([100, 90, 80, 1])
    expect(chain[0].command).toContain("bun run bin/build.ts")
    expect(chain[2].command).toBe("claude")
  })

  test("bounded depth — a cyclic ps table cannot loop forever", () => {
    const cyclic = (pid: number) => ({ ppid: pid, command: `p${pid}` })
    const chain = collectAncestry(42, cyclic, 5)
    expect(chain.length).toBeLessThanOrEqual(5)
  })

  test("ps failure mid-walk returns what was collected (no throw)", () => {
    const flaky = (pid: number) =>
      pid === 100 ? { ppid: 90, command: "bun" } : null
    const chain = collectAncestry(100, flaky)
    expect(chain).toEqual([{ pid: 100, command: "bun" }])
  })

  test("real ps runner resolves this test process without throwing", () => {
    const chain = collectAncestry(process.pid)
    expect(chain.length).toBeGreaterThanOrEqual(1)
    expect(chain[0].pid).toBe(process.pid)
  })

  test("caps each command line — a huge argv can't bloat tracked files", () => {
    const huge = (_pid: number) => ({
      ppid: 0,
      command: `claude -p '${"x".repeat(5_000)}'`,
    })
    const chain = collectAncestry(100, huge)
    expect(chain[0].command.length).toBeLessThanOrEqual(300 + 1) // +1 for the ellipsis
    expect(chain[0].command.endsWith("…")).toBe(true)
  })
})

describe("launch context", () => {
  test("captureLaunchContext writes launch.json and returns the context", () => {
    const dir = tmp()
    try {
      const ctx = captureLaunchContext({
        buildDir: dir,
        env: {
          CONDUCTOR_WORKSPACE_NAME: "product-feat",
          TERM_PROGRAM: "Superset",
          PATH: "/usr/bin", // not in the allowlist — must not be captured
        },
        now: () => "2026-07-07T00:00:00Z",
        pid: 100,
        runPs: (pid: number) =>
          pid === 100 ? { ppid: 90, command: "bun" } : null,
      })
      expect(ctx.pid).toBe(100)
      expect(ctx.ts).toBe("2026-07-07T00:00:00Z")
      expect(ctx.env).toEqual({
        CONDUCTOR_WORKSPACE_NAME: "product-feat",
        TERM_PROGRAM: "Superset",
      })
      const onDisk = readLaunchContext(launchContextPath(dir))
      expect(onDisk).toEqual(ctx)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("readLaunchContext returns null on missing or corrupt file", () => {
    const dir = tmp()
    try {
      expect(readLaunchContext(launchContextPath(dir))).toBeNull()
      writeFileSync(join(dir, "bad.json"), "{nope")
      expect(readLaunchContext(join(dir, "bad.json"))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("crash records", () => {
  test("appendCrashRecord appends one JSON line per record; readCrashRecords round-trips", () => {
    const dir = tmp()
    try {
      const p = crashLogPath(dir)
      appendCrashRecord(p, { kind: "signal", signal: "SIGTERM" })
      appendCrashRecord(p, { kind: "autopsy", wrapperExit: null })
      const lines = readFileSync(p, "utf-8").trim().split("\n")
      expect(lines).toHaveLength(2)
      const records = readCrashRecords(p)
      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({ kind: "signal", signal: "SIGTERM" })
      expect(records[1]).toMatchObject({ kind: "autopsy" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("readCrashRecords tolerates a corrupt line (skips it, keeps the rest)", () => {
    const dir = tmp()
    try {
      const p = crashLogPath(dir)
      appendCrashRecord(p, { kind: "signal" })
      writeFileSync(p, `${readFileSync(p, "utf-8")}{corrupt\n`)
      appendCrashRecord(p, { kind: "autopsy" })
      expect(readCrashRecords(p)).toHaveLength(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("readCrashRecords returns [] on a missing file", () => {
    expect(readCrashRecords(join(tmp(), "nope.jsonl"))).toEqual([])
  })
})

describe("isPidAlive", () => {
  test("true when kill(pid, 0) succeeds; false when it throws ESRCH", () => {
    expect(isPidAlive(1, () => {})).toBe(true)
    expect(
      isPidAlive(999999, () => {
        const err = new Error("kill ESRCH") as NodeJS.ErrnoException
        err.code = "ESRCH"
        throw err
      }),
    ).toBe(false)
  })

  test("EPERM (exists, not ours) still counts as alive", () => {
    expect(
      isPidAlive(1, () => {
        const err = new Error("kill EPERM") as NodeJS.ErrnoException
        err.code = "EPERM"
        throw err
      }),
    ).toBe(true)
  })
})

describe("buildSignalCrashRecord + describeSignalCrash", () => {
  const launch = {
    ts: "2026-07-07T00:00:00Z",
    pid: 100,
    ppid: 90,
    ancestry: [
      { pid: 100, command: "bun run bin/build.ts feat" },
      { pid: 90, command: "bash bin/build/run.sh feat" },
      { pid: 80, command: "claude --session abc" },
    ],
    env: { CONDUCTOR_WORKSPACE_NAME: "product-feat" },
  }

  test("record captures signal, identity drift, and parent liveness", () => {
    const record = buildSignalCrashRecord({
      signal: "SIGTERM",
      now: () => "2026-07-07T00:10:34Z",
      pid: 100,
      ppid: 1, // reparented — original parent already dead
      phase: "build",
      launch,
      parentAlive: false,
    })
    expect(record.kind).toBe("signal")
    expect(record.signal).toBe("SIGTERM")
    expect(record.ts).toBe("2026-07-07T00:10:34Z")
    expect(record.ppidAtSignal).toBe(1)
    expect(record.launch).toEqual(launch)
    expect(record.parentAlive).toBe(false)
    expect(record.phase).toBe("build")
  })

  test("describeSignalCrash renders human lines: context + ancestry", () => {
    const record = buildSignalCrashRecord({
      signal: "SIGTERM",
      now: () => "t",
      pid: 100,
      ppid: 90,
      phase: "review",
      launch,
      parentAlive: true,
    })
    const lines = describeSignalCrash(record)
    expect(lines[0]).toContain("SIGTERM")
    expect(lines[0]).toContain("phase=review")
    expect(lines[0]).toContain("launch parent alive=yes")
    expect(lines.join("\n")).toContain("claude --session abc")
  })

  test("reparenting (ppid drift) is called out in the human lines", () => {
    const record = buildSignalCrashRecord({
      signal: "SIGTERM",
      now: () => "t",
      pid: 100,
      ppid: 1,
      phase: "build",
      launch,
      parentAlive: true,
    })
    const lines = describeSignalCrash(record)
    expect(lines[0]).toContain("reparented 90→1")
  })
})
