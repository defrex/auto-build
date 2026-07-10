import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  HEARTBEAT_STALE_MS,
  type Heartbeat,
  heartbeatPath,
  isHeartbeatStale,
  legacyHeartbeatPath,
  readHeartbeat,
  startHeartbeat,
  writeHeartbeat,
} from "./heartbeat"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "heartbeat-"))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("heartbeatPath", () => {
  test("joins heartbeat.json under the gitignored .build/ scratch dir", () => {
    expect(heartbeatPath("/a/b")).toBe(join("/a/b", ".build", "heartbeat.json"))
  })
})

describe("legacyHeartbeatPath", () => {
  test("joins heartbeat.json directly under the build dir (pre-PRO-667)", () => {
    expect(legacyHeartbeatPath("/a/b")).toBe(join("/a/b", "heartbeat.json"))
  })
})

describe("writeHeartbeat / readHeartbeat", () => {
  test("round-trips a record", () => {
    const dir = tmp()
    try {
      const p = heartbeatPath(dir)
      const hb: Heartbeat = { ts: "2026-07-03T00:00:00Z", pid: 4242 }
      writeHeartbeat(p, hb)
      expect(readHeartbeat(p)).toEqual(hb)
      // Lands under the gitignored .build/ scratch dir (auto-created).
      expect(existsSync(join(dir, ".build", "heartbeat.json"))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns null on a missing file", () => {
    const dir = tmp()
    try {
      expect(readHeartbeat(join(dir, "nope.json"))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns null on corrupt JSON", () => {
    const dir = tmp()
    try {
      const p = heartbeatPath(dir)
      mkdirSync(join(dir, ".build"), { recursive: true })
      writeFileSync(p, "{not json")
      expect(readHeartbeat(p)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("startHeartbeat", () => {
  test("writes the file immediately with the injected now/pid", () => {
    const dir = tmp()
    try {
      const p = heartbeatPath(dir)
      const hb = startHeartbeat({
        path: p,
        now: () => "2026-07-03T00:00:00Z",
        pid: 99,
        intervalMs: 1_000_000,
      })
      // Assert BEFORE any tick.
      expect(readHeartbeat(p)).toEqual({ ts: "2026-07-03T00:00:00Z", pid: 99 })
      hb.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("ticks: ts advances, and stops writing after stop()", async () => {
    const dir = tmp()
    try {
      const p = heartbeatPath(dir)
      let n = 0
      const hb = startHeartbeat({
        path: p,
        now: () => `2026-07-03T00:00:0${n++}Z`,
        pid: 7,
        intervalMs: 5,
      })
      const first = readHeartbeat(p)?.ts
      await sleep(30)
      const advanced = readHeartbeat(p)?.ts
      expect(advanced).not.toBe(first)
      hb.stop()
      const afterStop = readHeartbeat(p)?.ts
      await sleep(30)
      // No further writes after stop().
      expect(readHeartbeat(p)?.ts).toBe(afterStop)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("stop() is idempotent", () => {
    const dir = tmp()
    try {
      const hb = startHeartbeat({
        path: heartbeatPath(dir),
        now: () => "2026-07-03T00:00:00Z",
        intervalMs: 1_000_000,
      })
      hb.stop()
      expect(() => hb.stop()).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("write failure never throws", () => {
    // Point at a directory path so writeFileSync would EISDIR.
    const dir = tmp()
    try {
      expect(() => writeHeartbeat(dir, { ts: "x", pid: 1 })).not.toThrow()
      expect(existsSync(join(dir, "heartbeat.json"))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("isHeartbeatStale", () => {
  const nowMs = Date.parse("2026-07-03T12:00:00Z")

  test("null heartbeat → stale", () => {
    expect(isHeartbeatStale({ heartbeat: null, nowMs })).toBe(true)
  })

  test("fresh heartbeat (5s old) → not stale", () => {
    const hb = { ts: new Date(nowMs - 5_000).toISOString(), pid: 1 }
    expect(isHeartbeatStale({ heartbeat: hb, nowMs })).toBe(false)
  })

  test("stale heartbeat (120s old) → stale", () => {
    const hb = { ts: new Date(nowMs - 120_000).toISOString(), pid: 1 }
    expect(isHeartbeatStale({ heartbeat: hb, nowMs })).toBe(true)
  })

  test("unparseable ts → stale", () => {
    expect(
      isHeartbeatStale({ heartbeat: { ts: "not-a-date", pid: 1 }, nowMs }),
    ).toBe(true)
  })

  test("boundary: exactly HEARTBEAT_STALE_MS old → fresh; one ms older → stale", () => {
    const exact = {
      ts: new Date(nowMs - HEARTBEAT_STALE_MS).toISOString(),
      pid: 1,
    }
    expect(isHeartbeatStale({ heartbeat: exact, nowMs })).toBe(false)
    const older = {
      ts: new Date(nowMs - HEARTBEAT_STALE_MS - 1).toISOString(),
      pid: 1,
    }
    expect(isHeartbeatStale({ heartbeat: older, nowMs })).toBe(true)
  })
})
