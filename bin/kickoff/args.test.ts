import { describe, expect, test } from "bun:test"
import {
  isCleanupMode,
  isHelpMode,
  isRestoreMode,
  parseCleanupArgs,
} from "./args"

describe("isCleanupMode / isRestoreMode", () => {
  test("detects --cleanup", () => {
    expect(isCleanupMode(["bun", "kickoff.ts", "--cleanup"])).toBe(true)
    expect(isCleanupMode(["bun", "kickoff.ts"])).toBe(false)
  })

  test("detects --restore", () => {
    expect(isRestoreMode(["bun", "kickoff.ts", "--restore"])).toBe(true)
    expect(isRestoreMode(["bun", "kickoff.ts"])).toBe(false)
  })
})

describe("isHelpMode", () => {
  test("detects --help and -h", () => {
    expect(isHelpMode(["bun", "kickoff.ts", "--help"])).toBe(true)
    expect(isHelpMode(["bun", "kickoff.ts", "-h"])).toBe(true)
    expect(isHelpMode(["bun", "kickoff.ts"])).toBe(false)
  })
})

describe("parseCleanupArgs", () => {
  test("no flags → all defaults", () => {
    expect(parseCleanupArgs(["bun", "kickoff.ts", "--cleanup"])).toEqual({
      slug: null,
      branch: null,
      force: false,
      merged: false,
    })
  })

  test("--slug <slug> and --slug=<slug>", () => {
    expect(parseCleanupArgs(["--cleanup", "--slug", "my-slug"]).slug).toBe(
      "my-slug",
    )
    expect(parseCleanupArgs(["--cleanup", "--slug=my-slug"]).slug).toBe(
      "my-slug",
    )
  })

  test("--branch <name> and --branch=<name>", () => {
    expect(
      parseCleanupArgs(["--cleanup", "--branch", "kickoff/x"]).branch,
    ).toBe("kickoff/x")
    expect(parseCleanupArgs(["--cleanup", "--branch=kickoff/x"]).branch).toBe(
      "kickoff/x",
    )
  })

  test("--force and --merged", () => {
    const a = parseCleanupArgs(["--cleanup", "--force", "--merged"])
    expect(a.force).toBe(true)
    expect(a.merged).toBe(true)
  })

  test("does NOT reject --slug + --branch together (parsing stays mechanical)", () => {
    const a = parseCleanupArgs(["--cleanup", "--slug", "s", "--branch", "b"])
    expect(a.slug).toBe("s")
    expect(a.branch).toBe("b")
  })

  test("a trailing --slug with no value → null", () => {
    expect(parseCleanupArgs(["--cleanup", "--slug"]).slug).toBeNull()
  })
})
