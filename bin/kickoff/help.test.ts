import { describe, expect, test } from "bun:test"
import { kickoffHelpText } from "./help"

describe("kickoffHelpText", () => {
  const text = kickoffHelpText()

  test("documents every mode flag", () => {
    for (const flag of [
      "--watch",
      "--monitor",
      "--restore",
      "--cleanup",
      "--help",
    ]) {
      expect(text).toContain(flag)
    }
  })

  test("documents cleanup flags", () => {
    for (const flag of ["--slug", "--branch", "--force", "--merged"]) {
      expect(text).toContain(flag)
    }
  })

  test("documents the monitor interval env var", () => {
    expect(text).toContain("KICKOFF_MONITOR_INTERVAL_SECONDS")
  })

  test("opens with a usage section", () => {
    expect(text).toContain("USAGE")
    expect(text).toContain("bun run kickoff")
  })
})
