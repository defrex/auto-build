/**
 * Pure-core tests for the defer-until parsing used by the kickoff selection gate.
 * A Ready ticket can carry a `<!-- defer-until: … -->` marker in its description;
 * a future instant makes kickoff skip it (like an uncleared blocker), a malformed
 * value is treated as not-deferred, and absent/past has no effect. No IO.
 */

import { describe, expect, test } from "bun:test"
import { extractDeferMarker, isDeferred, parseDeferUntil } from "./defer"

describe("extractDeferMarker", () => {
  test("returns the marker value when present", () => {
    expect(extractDeferMarker("<!-- defer-until: 2026-07-15 -->")).toBe(
      "2026-07-15",
    )
  })

  test("returns null when absent", () => {
    expect(extractDeferMarker("just a normal description")).toBeNull()
    expect(extractDeferMarker("")).toBeNull()
  })

  test("finds the marker amid surrounding description text", () => {
    const desc = [
      "# Deploy B",
      "",
      "Delete the tombstone once stale tabs drain.",
      "",
      "<!-- defer-until: 2026-07-20T09:00:00Z -->",
      "",
      "More notes.",
    ].join("\n")
    expect(extractDeferMarker(desc)).toBe("2026-07-20T09:00:00Z")
  })

  test("returns the first marker when several are present", () => {
    const desc =
      "<!-- defer-until: 2026-07-15 -->\n<!-- defer-until: 2026-08-01 -->"
    expect(extractDeferMarker(desc)).toBe("2026-07-15")
  })

  test("is case-insensitive and tolerates extra whitespace", () => {
    expect(extractDeferMarker("<!--   DEFER-UNTIL:   2026-07-15   -->")).toBe(
      "2026-07-15",
    )
  })
})

describe("parseDeferUntil", () => {
  test("absent (null/empty/whitespace) → not deferred, not malformed", () => {
    for (const raw of [null, undefined, "", "   "]) {
      expect(parseDeferUntil(raw)).toEqual({
        deferUntilMs: null,
        malformed: false,
      })
    }
  })

  test("date-only resolves to start of day UTC", () => {
    expect(parseDeferUntil("2026-07-15")).toEqual({
      deferUntilMs: Date.parse("2026-07-15T00:00:00.000Z"),
      malformed: false,
    })
  })

  test("explicit Z instant parses", () => {
    expect(parseDeferUntil("2026-07-15T09:00:00Z")).toEqual({
      deferUntilMs: Date.parse("2026-07-15T09:00:00Z"),
      malformed: false,
    })
  })

  test("±HH:MM offset instant parses", () => {
    expect(parseDeferUntil("2026-07-15T09:00:00-04:00")).toEqual({
      deferUntilMs: Date.parse("2026-07-15T09:00:00-04:00"),
      malformed: false,
    })
  })

  test("garbage → malformed", () => {
    expect(parseDeferUntil("tomorrow")).toEqual({
      deferUntilMs: null,
      malformed: true,
    })
  })

  test("out-of-range date components → malformed", () => {
    expect(parseDeferUntil("2026-13-40")).toEqual({
      deferUntilMs: null,
      malformed: true,
    })
  })

  test("date-only rollover (Feb 30 / Jun 31) → malformed", () => {
    expect(parseDeferUntil("2026-02-30")).toEqual({
      deferUntilMs: null,
      malformed: true,
    })
    expect(parseDeferUntil("2026-06-31")).toEqual({
      deferUntilMs: null,
      malformed: true,
    })
  })

  test("bare datetime without a zone → malformed (avoids local-time ambiguity)", () => {
    expect(parseDeferUntil("2026-07-15T09:00:00")).toEqual({
      deferUntilMs: null,
      malformed: true,
    })
  })

  test("zoned datetime with calendar rollover → malformed (not a silent mis-defer)", () => {
    // Date.parse silently rolls Feb 30 → Mar 2 instead of NaN; must be rejected.
    expect(parseDeferUntil("2026-02-30T09:00:00Z")).toEqual({
      deferUntilMs: null,
      malformed: true,
    })
    expect(parseDeferUntil("2026-06-31T09:00:00-04:00")).toEqual({
      deferUntilMs: null,
      malformed: true,
    })
  })
})

describe("isDeferred", () => {
  const now = Date.parse("2026-07-09T00:00:00.000Z")

  test("future instant → deferred", () => {
    expect(isDeferred(now + 1, now)).toBe(true)
  })

  test("exact-now → not deferred (at/after is eligible)", () => {
    expect(isDeferred(now, now)).toBe(false)
  })

  test("past instant → not deferred", () => {
    expect(isDeferred(now - 1, now)).toBe(false)
  })

  test("null → not deferred", () => {
    expect(isDeferred(null, now)).toBe(false)
  })
})
