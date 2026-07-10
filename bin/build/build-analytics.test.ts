import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  countReviewFindings,
  countReviewFindingsAt,
  diffStat,
  readKickoffIdentity,
} from "./build-analytics"

describe("countReviewFindings", () => {
  test("counts one per finding tag", () => {
    const md = [
      "## Some heading",
      "[blocking] thing is wrong (file.ts:1)",
      "[nit] style",
      "[question] why?",
    ].join("\n")
    expect(countReviewFindings(md)).toBe(3)
  })

  test("zero on an empty string or no tags", () => {
    expect(countReviewFindings("")).toBe(0)
    expect(countReviewFindings("# title\nno findings here\nCLEAN")).toBe(0)
  })

  test("case-insensitive", () => {
    expect(countReviewFindings("[BLOCKING] x\n[Nit] y")).toBe(2)
  })
})

describe("countReviewFindingsAt", () => {
  test("0 on a missing file", () => {
    expect(countReviewFindingsAt("/nonexistent/round-1.md")).toBe(0)
  })

  test("counts from a real file", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-"))
    const f = join(dir, "round-1.md")
    writeFileSync(f, "[blocking] a\n[blocking] b\nBLOCKING")
    expect(countReviewFindingsAt(f)).toBe(2)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("diffStat", () => {
  test("0/0/0 on a non-repo / failure", () => {
    expect(diffStat("/nonexistent/path", "main")).toEqual({
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
    })
  })
})

describe("readKickoffIdentity", () => {
  test("{} on a missing sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "ident-"))
    expect(readKickoffIdentity(dir, "feat")).toEqual({})
    rmSync(dir, { recursive: true, force: true })
  })

  test("reads issueId/issueUuid from the sidecar", () => {
    const dir = mkdtempSync(join(tmpdir(), "ident-"))
    mkdirSync(join(dir, "build", "feat"), { recursive: true })
    writeFileSync(
      join(dir, "build", "feat", ".kickoff-identity.json"),
      JSON.stringify({ issueId: "PRO-9", issueUuid: "uuid-9" }),
    )
    expect(readKickoffIdentity(dir, "feat")).toEqual({
      issueId: "PRO-9",
      issueUuid: "uuid-9",
    })
    rmSync(dir, { recursive: true, force: true })
  })

  test("{} on malformed JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "ident-"))
    mkdirSync(join(dir, "build", "feat"), { recursive: true })
    writeFileSync(
      join(dir, "build", "feat", ".kickoff-identity.json"),
      "{not json",
    )
    expect(readKickoffIdentity(dir, "feat")).toEqual({})
    rmSync(dir, { recursive: true, force: true })
  })
})
