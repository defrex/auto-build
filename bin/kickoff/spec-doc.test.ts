import { describe, expect, test } from "bun:test"
import { specDocFromBrief } from "./spec-doc"

describe("specDocFromBrief", () => {
  test("emits the brief verbatim (trimmed)", () => {
    const brief =
      "Several `.collect()` calls scan unbounded tables.\n\nPaginate them."
    expect(specDocFromBrief(brief).trim()).toBe(brief.trim())
  })

  test("imposes no structure and no footer", () => {
    const out = specDocFromBrief("Make reads bounded.\n\nPaginate them.")
    expect(out).not.toContain("## Overview")
    expect(out).not.toContain("# ")
    expect(out).not.toContain("---")
    expect(out).not.toMatch(/auto-resolves/)
    expect(out).not.toContain("source:")
  })

  test("ends with a single trailing newline", () => {
    expect(specDocFromBrief("body")).toBe("body\n")
  })
})
