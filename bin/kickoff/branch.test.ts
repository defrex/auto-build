import { describe, expect, test } from "bun:test"
import {
  gwtWorktreeDir,
  kickoffBranch,
  slugFromKickoffBranch,
  slugify,
} from "./branch"

describe("slugify", () => {
  test("kebab-cases and lowercases", () => {
    expect(slugify("Make Reads Bounded!")).toBe("make-reads-bounded")
  })

  test("caps to three words and trims trailing dashes", () => {
    expect(slugify("one two three four five")).toBe("one-two-three")
    expect(slugify("Fix the flaky webhook retry logic")).toBe("fix-the-flaky")
  })

  test("caps length as a safety guard and trims trailing dashes", () => {
    const slug = slugify("a".repeat(80))
    expect(slug.length).toBeLessThanOrEqual(50)
    expect(slug.endsWith("-")).toBe(false)
  })

  test("falls back to 'task' for empty input", () => {
    expect(slugify("!!!")).toBe("task")
  })

  test("never yields the reserved bare slug 'kickoff'", () => {
    expect(slugify("kickoff")).not.toBe("kickoff")
  })

  test("is stable for the same title", () => {
    expect(slugify("Fix the thing")).toBe(slugify("Fix the thing"))
  })
})

describe("kickoffBranch", () => {
  test("is `<id>-<slug>` with the lowercased Linear id, no prefix", () => {
    expect(kickoffBranch("DIS-123", "make-reads-bounded")).toBe(
      "dis-123-make-reads-bounded",
    )
  })
})

describe("gwtWorktreeDir", () => {
  test("is a sibling <project>-<safe-branch> dir off the main checkout", () => {
    expect(
      gwtWorktreeDir("/Users/me/code/product", "dis-123-make-reads-bounded"),
    ).toBe("/Users/me/code/product-dis-123-make-reads-bounded")
  })

  test("lowercases and replaces every slash with a dash (mirrors gwt)", () => {
    expect(gwtWorktreeDir("/a/b/repo", "Feature/Foo/Bar")).toBe(
      "/a/b/repo-feature-foo-bar",
    )
  })
})

describe("slugFromKickoffBranch", () => {
  test("extracts the slug after <id> from an `<id>-<slug>` branch", () => {
    expect(slugFromKickoffBranch("pro-532-my-cool-slug")).toBe("my-cool-slug")
  })

  test("still parses legacy `kickoff/<id>-<slug>` branches (transition)", () => {
    expect(slugFromKickoffBranch("kickoff/pro-532-my-cool-slug")).toBe(
      "my-cool-slug",
    )
  })

  test("is case-insensitive on the id segment", () => {
    expect(slugFromKickoffBranch("PRO-1-foo")).toBe("foo")
    expect(slugFromKickoffBranch("kickoff/PRO-1-foo")).toBe("foo")
  })

  test("returns null for a non-scheme branch", () => {
    expect(slugFromKickoffBranch("feature/some-rename")).toBeNull()
    expect(slugFromKickoffBranch("main")).toBeNull()
  })
})
