import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildDir,
  buildStateSchema,
  defaultHarnessMap,
  initState,
  readState,
  statePath,
  writeState,
} from "./state"

describe("defaultHarnessMap", () => {
  test("claude/opus plans & builds, codex reviews", () => {
    const map = defaultHarnessMap()
    expect(map.plan).toEqual({ bin: "claude", model: "opus" })
    expect(map.build).toEqual({ bin: "claude", model: "opus" })
    expect(map.pr).toEqual({ bin: "claude", model: "opus" })
    expect(map["plan-review"]).toEqual({ bin: "codex" })
    expect(map.review).toEqual({ bin: "codex" })
  })

  test("validates against the schema", () => {
    expect(() =>
      buildStateSchema.shape.harnessMap.parse(defaultHarnessMap()),
    ).not.toThrow()
  })
})

describe("path helpers", () => {
  test("buildDir and statePath compose under build/[feature]", () => {
    expect(buildDir("/repo", "build-flow")).toBe("/repo/build/build-flow")
    expect(statePath("/repo", "build-flow")).toBe(
      "/repo/build/build-flow/state.json",
    )
  })
})

describe("initState", () => {
  test("starts at plan/running with empty review round", () => {
    const s = initState(
      "build-flow",
      "amplified-geography",
      "2026-05-28T00:00:00Z",
    )
    expect(s.feature).toBe("build-flow")
    expect(s.phase).toBe("plan")
    expect(s.status).toBe("running")
    expect(s.reviewRound).toBe(0)
    expect(s.branch).toBe("amplified-geography")
    expect(s.updatedAt).toBe("2026-05-28T00:00:00Z")
    expect(() => buildStateSchema.parse(s)).not.toThrow()
  })

  test("leaves the Linear issue fields unset (a fresh build has no ticket)", () => {
    const s = initState("build-flow", "br", "2026-05-28T00:00:00Z")
    expect(s.linearIssueId).toBeUndefined()
    expect(s.linearIssueUuid).toBeUndefined()
  })
})

describe("Linear issue fields", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "build-flow-linear-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test("linearIssueId/linearIssueUuid round-trip through write/read", () => {
    const s = {
      ...initState("feat", "br", "2026-05-28T00:00:00Z"),
      linearIssueId: "PRO-123",
      linearIssueUuid: "uuid-abc",
    }
    writeState(repo, s, "2026-05-28T01:00:00Z")
    const read = readState(repo, "feat")
    expect(read?.linearIssueId).toBe("PRO-123")
    expect(read?.linearIssueUuid).toBe("uuid-abc")
  })

  test("an existing state.json without the keys still parses (optional)", () => {
    const s = initState("feat", "br", "2026-05-28T00:00:00Z")
    writeState(repo, s, "2026-05-28T00:00:00Z")
    // simulate a pre-existing file that never had the new keys
    const raw = JSON.parse(
      readFileSync(statePath(repo, "feat"), "utf-8"),
    ) as Record<string, unknown>
    expect("linearIssueId" in raw).toBe(false)
    expect(readState(repo, "feat")?.feature).toBe("feat")
  })
})

describe("readState / writeState round-trip", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "build-flow-state-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  test("readState returns null before any write", () => {
    expect(readState(repo, "feat")).toBeNull()
  })

  test("writeState creates the spec dir and round-trips through readState", () => {
    const s = initState("feat", "branch-x", "2026-05-28T00:00:00Z")
    writeState(repo, s, "2026-05-28T01:00:00Z")
    const read = readState(repo, "feat")
    expect(read?.feature).toBe("feat")
    expect(read?.phase).toBe("plan")
    expect(read?.updatedAt).toBe("2026-05-28T01:00:00Z")
  })

  test("writeState stamps updatedAt and pretty-prints with trailing newline", () => {
    const s = initState("feat", "branch-x", "2026-05-28T00:00:00Z")
    const stamped = writeState(repo, s, "2026-05-28T02:00:00Z")
    expect(stamped.updatedAt).toBe("2026-05-28T02:00:00Z")
    const raw = readFileSync(statePath(repo, "feat"), "utf-8")
    expect(raw.endsWith("}\n")).toBe(true)
    expect(raw).toContain('  "phase": "plan"')
  })

  test("readState rejects malformed state", () => {
    const s = initState("feat", "branch-x", "2026-05-28T00:00:00Z")
    writeState(repo, s, "2026-05-28T00:00:00Z")
    const path = statePath(repo, "feat")
    writeFileSync(path, JSON.stringify({ feature: "feat", phase: "nope" }))
    expect(() => readState(repo, "feat")).toThrow()
  })
})
