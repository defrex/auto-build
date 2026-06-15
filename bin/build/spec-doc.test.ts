import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  LEGACY_DESIGN_FILE,
  resolveSpecPath,
  SPEC_FILE,
  specExists,
} from "./spec-doc"

describe("spec-doc constants", () => {
  test("SPEC_FILE is spec.md, LEGACY_DESIGN_FILE is design.md", () => {
    expect(SPEC_FILE).toBe("spec.md")
    expect(LEGACY_DESIGN_FILE).toBe("design.md")
  })
})

describe("resolveSpecPath / specExists", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spec-doc-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("returns the spec.md path when spec.md exists", () => {
    writeFileSync(join(dir, "spec.md"), "spec")
    expect(resolveSpecPath(dir)).toBe(join(dir, "spec.md"))
    expect(specExists(dir)).toBe(true)
  })

  test("returns the design.md path when only design.md exists", () => {
    writeFileSync(join(dir, "design.md"), "design")
    expect(resolveSpecPath(dir)).toBe(join(dir, "design.md"))
    expect(specExists(dir)).toBe(true)
  })

  test("prefers spec.md when both exist", () => {
    writeFileSync(join(dir, "spec.md"), "spec")
    writeFileSync(join(dir, "design.md"), "design")
    expect(resolveSpecPath(dir)).toBe(join(dir, "spec.md"))
    expect(specExists(dir)).toBe(true)
  })

  test("returns the spec.md path (default) when neither exists", () => {
    expect(resolveSpecPath(dir)).toBe(join(dir, "spec.md"))
    expect(specExists(dir)).toBe(false)
  })
})
