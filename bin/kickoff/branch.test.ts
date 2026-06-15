import { describe, expect, test } from "bun:test"
import { kickoffBranch, slugify } from "./branch"

describe("slugify", () => {
  test("kebab-cases and lowercases", () => {
    expect(slugify("Make Reads Bounded!")).toBe("make-reads-bounded")
  })

  test("caps length and trims trailing dashes", () => {
    const slug = slugify("a".repeat(80))
    expect(slug.length).toBeLessThanOrEqual(50)
    expect(slug.endsWith("-")).toBe(false)
  })

  test("falls back to 'task' for empty input", () => {
    expect(slugify("!!!")).toBe("task")
  })

  test("is stable for the same title", () => {
    expect(slugify("Fix the thing")).toBe(slugify("Fix the thing"))
  })
})

describe("kickoffBranch", () => {
  test("always embeds the lowercased Linear id", () => {
    expect(kickoffBranch("DIS-123", "make-reads-bounded")).toBe(
      "kickoff/dis-123-make-reads-bounded",
    )
  })

  test("honors a custom prefix", () => {
    expect(kickoffBranch("DIS-9", "x", "maint")).toBe("maint/dis-9-x")
  })
})
