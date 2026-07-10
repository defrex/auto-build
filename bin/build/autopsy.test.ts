import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildAutopsyLines,
  memorystatusProbeCommand,
  parseWrapperExit,
  readLogTail,
  runMemorystatusProbe,
} from "./autopsy"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "autopsy-"))
}

describe("readLogTail", () => {
  test("returns the full contents when smaller than maxBytes", () => {
    const dir = tmp()
    try {
      const p = join(dir, "build.log")
      writeFileSync(p, "hello world")
      expect(readLogTail(p)).toBe("hello world")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns only the trailing bytes for a large file, keeping the wrapper line", () => {
    const dir = tmp()
    try {
      const p = join(dir, "build.log")
      const maxBytes = 1024
      const filler = "x".repeat(maxBytes * 2)
      writeFileSync(
        p,
        `${filler}\n[ts] wrapper: bun process exited (code=137, signal=SIGKILL)\n`,
      )
      const tail = readLogTail(p, maxBytes)
      expect(tail.length).toBeLessThanOrEqual(maxBytes + 8)
      expect(tail).toContain("wrapper: bun process exited (code=137")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("returns empty string on a missing file (no throw)", () => {
    expect(readLogTail(join(tmp(), "nope.log"))).toBe("")
  })
})

describe("parseWrapperExit", () => {
  test("extracts the code from a trailing wrapper line", () => {
    expect(
      parseWrapperExit("[ts] wrapper: bun process exited (code=137)"),
    ).toBe("137")
  })

  test("tolerates a , signal=… suffix", () => {
    expect(
      parseWrapperExit(
        "[ts] wrapper: bun process exited (code=143, signal=SIGTERM)",
      ),
    ).toBe("143")
  })

  test("returns the last match when several are present", () => {
    const log = [
      "[a] wrapper: bun process exited (code=1)",
      "[b] wrapper: bun process exited (code=137, signal=SIGKILL)",
    ].join("\n")
    expect(parseWrapperExit(log)).toBe("137")
  })

  test("returns null when absent", () => {
    expect(parseWrapperExit("nothing here")).toBeNull()
  })
})

describe("buildAutopsyLines", () => {
  test("heartbeat present → last-alive uses hb.ts + pid, wrapper present", () => {
    const lines = buildAutopsyLines({
      priorPhase: "build",
      heartbeat: { ts: "2026-07-03T10:00:00Z", pid: 555 },
      priorUpdatedAt: "2026-07-03T09:00:00Z",
      wrapperExit: "137",
    })
    expect(lines[0]).toContain("ended abnormally")
    expect(lines[1]).toContain("last phase=build")
    expect(lines[1]).toContain("2026-07-03T10:00:00Z")
    expect(lines[1]).toContain("(heartbeat)")
    expect(lines[1]).toContain("pid=555")
    expect(lines[2]).toContain("wrapper recorded bun exit code=137")
  })

  test("heartbeat absent → falls back to priorUpdatedAt labelled a fallback, wrapper absent", () => {
    const lines = buildAutopsyLines({
      priorPhase: "monitor",
      heartbeat: null,
      priorUpdatedAt: "2026-07-03T09:00:00Z",
      wrapperExit: null,
    })
    expect(lines[1]).toContain("2026-07-03T09:00:00Z")
    expect(lines[1]).toContain("state.updatedAt fallback")
    expect(lines[1]).toContain("pid=?")
    expect(lines[2]).toContain("no wrapper exit line found")
    expect(lines[2]).toContain("killed together")
    expect(lines[2]).toContain("group-wide")
  })
})

describe("memorystatusProbeCommand", () => {
  test("darwin → predicate contains jetsam", () => {
    const cmd = memorystatusProbeCommand("darwin")
    expect(cmd).not.toBeNull()
    expect(cmd?.cmd).toBe("log")
    expect(cmd?.args.join(" ")).toContain("jetsam")
  })

  test("linux → null", () => {
    expect(memorystatusProbeCommand("linux")).toBeNull()
  })
})

describe("runMemorystatusProbe", () => {
  test("darwin with matches → filters/caps and prefixes autopsy: mem:", () => {
    const lines = runMemorystatusProbe({
      platform: "darwin",
      pid: 999,
      run: () => ({
        ok: true,
        stdout: [
          "irrelevant line",
          "jetsam killed pid 999 (bun)",
          "another jetsam event",
        ].join("\n"),
      }),
    })
    expect(lines.every((l) => l.startsWith("autopsy: mem: "))).toBe(true)
    expect(lines.some((l) => l.includes("999"))).toBe(true)
  })

  test("darwin, injected run throws → documented fallback (no throw)", () => {
    const lines = runMemorystatusProbe({
      platform: "darwin",
      run: () => {
        throw new Error("log missing")
      },
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("run manually")
  })

  test("linux → documented fallback line", () => {
    const lines = runMemorystatusProbe({ platform: "linux" })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain("run manually")
  })

  test("darwin, ok but no matches → explicit 'no kill events' line (H1 ruled unlikely)", () => {
    const lines = runMemorystatusProbe({
      platform: "darwin",
      run: () => ({ ok: true, stdout: "\n  \n" }),
    })
    expect(lines).toEqual([
      expect.stringContaining("no memorystatus/jetsam kill events"),
    ])
  })

  test("filters the probe's own invocation lines and runningboardd chatter", () => {
    const lines = runMemorystatusProbe({
      platform: "darwin",
      pid: 999,
      run: () => ({
        ok: true,
        stdout: [
          "2026-07-07 14:54:09 Df log[66566] [com.apple.log:] log run noninteractively, parent: 66541 (bun), args: 'log' 'show' …",
          "2026-07-07 14:11:14 Df runningboardd[414] [anon<bun>(501):59691] is not RunningBoard jetsam managed.",
        ].join("\n"),
      }),
    })
    // Both lines are noise → the probe found nothing meaningful.
    expect(lines).toEqual([
      expect.stringContaining("no memorystatus/jetsam kill events"),
    ])
  })

  test("keeps genuine kill events while dropping interleaved noise", () => {
    const lines = runMemorystatusProbe({
      platform: "darwin",
      pid: 999,
      run: () => ({
        ok: true,
        stdout: [
          "log run noninteractively, parent: 66541 (bun)",
          "memorystatus: killing_specific_process pid 999 [bun] (per-process-limit)",
          "[anon<bun>(501):59691] is not RunningBoard jetsam managed.",
        ].join("\n"),
      }),
    })
    expect(lines).toEqual([
      "autopsy: mem: memorystatus: killing_specific_process pid 999 [bun] (per-process-limit)",
    ])
  })
})
