import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  boundedConcat,
  CHILD_OUTPUT_CAP,
  isEpipe,
  safeAppend,
  safeStreamWrite,
} from "./safe-output"

describe("boundedConcat", () => {
  test("passes small inputs through unchanged", () => {
    expect(boundedConcat("a", "b")).toBe("ab")
    expect(boundedConcat("", "hello")).toBe("hello")
  })

  test("never exceeds the cap and retains the tail", () => {
    const out = boundedConcat("x".repeat(100), "y".repeat(100), 50)
    expect(out.length).toBe(50)
    expect(out).toBe("y".repeat(50))
  })

  test("a trailing sentinel survives after appending a > cap blob", () => {
    const prev = ""
    const blob = "x".repeat(CHILD_OUTPUT_CAP * 2)
    const out = boundedConcat(prev, `${blob}\nPLAN_DONE\n`)
    expect(out.length).toBeLessThanOrEqual(CHILD_OUTPUT_CAP)
    expect(out).toContain("PLAN_DONE")
  })
})

describe("isEpipe", () => {
  test("true for an EPIPE-coded error", () => {
    expect(isEpipe({ code: "EPIPE" })).toBe(true)
    const err = Object.assign(new Error("broken pipe"), { code: "EPIPE" })
    expect(isEpipe(err)).toBe(true)
  })

  test("false for other errors, non-objects, and null", () => {
    expect(isEpipe({ code: "ENOENT" })).toBe(false)
    expect(isEpipe(new Error("nope"))).toBe(false)
    expect(isEpipe("EPIPE")).toBe(false)
    expect(isEpipe(null)).toBe(false)
    expect(isEpipe(undefined)).toBe(false)
  })
})

describe("safeStreamWrite", () => {
  test("swallows a throwing stream", () => {
    const stream = {
      write() {
        throw Object.assign(new Error("EPIPE"), { code: "EPIPE" })
      },
    } as unknown as NodeJS.WritableStream
    expect(() => safeStreamWrite(stream, "text")).not.toThrow()
  })

  test("passes text through to a working stream", () => {
    let seen = ""
    const stream = {
      write(t: string) {
        seen += t
        return true
      },
    } as unknown as NodeJS.WritableStream
    safeStreamWrite(stream, "hi")
    expect(seen).toBe("hi")
  })
})

describe("safeAppend", () => {
  test("swallows an appendFileSync failure (unwritable path)", () => {
    const dir = mkdtempSync(join(tmpdir(), "safe-append-"))
    try {
      // Appending to a directory path throws EISDIR — must be swallowed.
      expect(() => safeAppend(dir, "text")).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
