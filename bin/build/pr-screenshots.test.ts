import { describe, expect, test } from "bun:test"
import {
  blobScreenshotUrl,
  buildScreenshotBlock,
  type EmbedScreenshotDeps,
  embedScreenshotsInPrBody,
  SCREENSHOT_BLOCK_END,
  SCREENSHOT_BLOCK_START,
  upsertScreenshotBlock,
} from "./pr-screenshots"
import type { PublishResult } from "./repo"

// A realistic full 40-char SHA so the URL contract isn't accidentally defined
// around abbreviated SHAs.
const SHA = "5f2e9c1a3b7d4e6f8a0c2b4d6e8f0a1c3e5d7f90"

describe("blobScreenshotUrl", () => {
  test("produces the exact github.com blob URL pinned to the SHA", () => {
    expect(
      blobScreenshotUrl("dispatch", "product", SHA, "my-feat", "login.png"),
    ).toBe(
      `https://github.com/dispatch/product/blob/${SHA}/build/my-feat/screenshots/login.png`,
    )
  })
})

describe("buildScreenshotBlock", () => {
  const base = {
    owner: "dispatch",
    repo: "product",
    sha: SHA,
    feature: "my-feat",
  }

  test("empty files → ''", () => {
    expect(buildScreenshotBlock({ ...base, files: [] })).toBe("")
  })

  test("non-empty → contains markers, the heading, one blob link per file", () => {
    const block = buildScreenshotBlock({
      ...base,
      files: ["login.png", "dash.png"],
    })
    expect(block).toContain(SCREENSHOT_BLOCK_START)
    expect(block).toContain(SCREENSHOT_BLOCK_END)
    expect(block).toContain("## Verification")
    expect(block).toContain(
      `- [login.png](https://github.com/dispatch/product/blob/${SHA}/build/my-feat/screenshots/login.png)`,
    )
    expect(block).toContain(
      `- [dash.png](https://github.com/dispatch/product/blob/${SHA}/build/my-feat/screenshots/dash.png)`,
    )
    // No inline image embed, no private-repo raw URL.
    expect(block).not.toContain("![")
    expect(block).not.toContain("raw.githubusercontent.com")
  })
})

describe("upsertScreenshotBlock", () => {
  const block = buildScreenshotBlock({
    owner: "o",
    repo: "r",
    sha: "b",
    feature: "f",
    files: ["a.png"],
  })

  test("append when absent → markers added once", () => {
    const body = "Existing PR body.\n\nCloses PRO-1"
    const next = upsertScreenshotBlock(body, block)
    expect(next).toContain("Existing PR body.")
    expect(next).toContain("Closes PRO-1")
    expect(next.match(/build-screenshots:start/g)).toHaveLength(1)
  })

  test("replace when present → idempotent (running twice = no duplicate markers)", () => {
    const body = "Body text"
    const once = upsertScreenshotBlock(body, block)
    const twice = upsertScreenshotBlock(once, block)
    expect(twice).toBe(once)
    expect(twice.match(/build-screenshots:start/g)).toHaveLength(1)
  })

  test("strip when block === '' and a block exists", () => {
    const body = "Keep me"
    const withBlock = upsertScreenshotBlock(body, block)
    const stripped = upsertScreenshotBlock(withBlock, "")
    expect(stripped).not.toContain("build-screenshots:start")
    expect(stripped).toContain("Keep me")
  })

  test("no-op when block === '' and no block exists", () => {
    const body = "Nothing to strip"
    expect(upsertScreenshotBlock(body, "")).toBe(body)
  })
})

describe("embedScreenshotsInPrBody", () => {
  function makeDeps(
    opts: {
      publish?: PublishResult
      files?: string[]
      nameWithOwner?: string | null
      sha?: string | null
      body?: string | null
      editOk?: boolean // gh pr edit result (default success)
    },
    record: string[] = [],
  ): { deps: EmbedScreenshotDeps; edits: string[]; record: string[] } {
    const edits: string[] = []
    const deps: EmbedScreenshotDeps = {
      publish: () => {
        record.push("publish")
        return opts.publish ?? { status: "clean" }
      },
      listScreenshots: () => opts.files ?? [],
      nameWithOwner: () =>
        opts.nameWithOwner === undefined ? "o/r" : opts.nameWithOwner,
      headSha: () => {
        record.push("headSha")
        return opts.sha === undefined ? SHA : opts.sha
      },
      prBody: () => (opts.body === undefined ? "Body" : opts.body),
      editPrBody: (b) => {
        record.push("editPrBody")
        edits.push(b)
        return opts.editOk ?? true
      },
      log: () => {},
    }
    return { deps, edits, record }
  }

  test("publish is invoked BEFORE headSha BEFORE editPrBody (ordering regression test)", () => {
    const { deps, record } = makeDeps({ files: ["a.png"] })
    embedScreenshotsInPrBody("f", deps)
    expect(record).toEqual(["publish", "headSha", "editPrBody"])
  })

  test("publish failed WITH screenshots → no edit, returns failed (caller blocks)", () => {
    const { deps, edits } = makeDeps({
      publish: { status: "failed", detail: "push rejected" },
      files: ["a.png"],
    })
    const result = embedScreenshotsInPrBody("f", deps)
    expect(edits).toHaveLength(0)
    expect(result.status).toBe("failed")
  })

  test("publish failed WITHOUT screenshots → noop (nothing at stake)", () => {
    const { deps, edits } = makeDeps({
      publish: { status: "failed", detail: "push rejected" },
      files: [],
    })
    const result = embedScreenshotsInPrBody("f", deps)
    expect(edits).toHaveLength(0)
    expect(result.status).toBe("noop")
  })

  test("happy path → editPrBody with a body containing the SHA-pinned blob URLs + markers", () => {
    const { deps, edits } = makeDeps({
      publish: { status: "pushed" },
      files: ["login.png"],
    })
    const result = embedScreenshotsInPrBody("f", deps)
    expect(edits).toHaveLength(1)
    expect(edits[0]).toContain(SCREENSHOT_BLOCK_START)
    expect(edits[0]).toContain(
      `https://github.com/o/r/blob/${SHA}/build/f/screenshots/login.png`,
    )
    expect(edits[0]).not.toContain("raw.githubusercontent.com")
    expect(result).toEqual({ status: "embedded", count: 1 })
  })

  test("no screenshots + no existing block → editPrBody not called (no-op)", () => {
    const { deps, edits } = makeDeps({ files: [], body: "Plain body" })
    const result = embedScreenshotsInPrBody("f", deps)
    expect(edits).toHaveLength(0)
    expect(result.status).toBe("noop")
  })

  test("metadata lookup failure WITH screenshots → no strip, returns failed", () => {
    const existing = upsertScreenshotBlock(
      "Body",
      buildScreenshotBlock({
        owner: "o",
        repo: "r",
        sha: SHA,
        feature: "f",
        files: ["a.png"],
      }),
    )
    const { deps, edits } = makeDeps({
      files: ["a.png"],
      nameWithOwner: null, // gh repo view failure
      body: existing,
    })
    const result = embedScreenshotsInPrBody("f", deps)
    expect(edits).toHaveLength(0)
    expect(result.status).toBe("failed")
  })

  test("metadata lookup failure WITHOUT screenshots → no strip, returns noop", () => {
    const existing = upsertScreenshotBlock(
      "Body",
      buildScreenshotBlock({
        owner: "o",
        repo: "r",
        sha: SHA,
        feature: "f",
        files: ["a.png"],
      }),
    )
    const { deps, edits } = makeDeps({
      files: [],
      nameWithOwner: null, // gh repo view failure
      body: existing,
    })
    const result = embedScreenshotsInPrBody("f", deps)
    expect(edits).toHaveLength(0)
    expect(result.status).toBe("noop")
  })

  test("headSha failure (null) WITH screenshots → no strip, returns failed", () => {
    const existing = upsertScreenshotBlock(
      "Body",
      buildScreenshotBlock({
        owner: "o",
        repo: "r",
        sha: SHA,
        feature: "f",
        files: ["a.png"],
      }),
    )
    const { deps, edits } = makeDeps({
      files: ["a.png"],
      sha: null, // git rev-parse HEAD failure
      body: existing,
    })
    const result = embedScreenshotsInPrBody("f", deps)
    expect(edits).toHaveLength(0)
    expect(result.status).toBe("failed")
  })

  test("headSha failure (null) WITHOUT screenshots → no strip, returns noop", () => {
    const existing = upsertScreenshotBlock(
      "Body",
      buildScreenshotBlock({
        owner: "o",
        repo: "r",
        sha: SHA,
        feature: "f",
        files: ["a.png"],
      }),
    )
    const { deps, edits } = makeDeps({
      files: [],
      sha: null, // git rev-parse HEAD failure
      body: existing,
    })
    const result = embedScreenshotsInPrBody("f", deps)
    expect(edits).toHaveLength(0)
    expect(result.status).toBe("noop")
  })

  test("gh pr edit failure WITH screenshots → returns failed (caller blocks)", () => {
    const { deps, edits } = makeDeps({
      publish: { status: "pushed" },
      files: ["login.png"],
      editOk: false,
    })
    const result = embedScreenshotsInPrBody("f", deps)
    expect(edits).toHaveLength(1) // edit was attempted
    expect(result.status).toBe("failed")
  })

  test("successful empty listing strips a now-stale block", () => {
    const existing = upsertScreenshotBlock(
      "Body",
      buildScreenshotBlock({
        owner: "o",
        repo: "r",
        sha: SHA,
        feature: "f",
        files: ["a.png"],
      }),
    )
    const { deps, edits } = makeDeps({ files: [], body: existing })
    const result = embedScreenshotsInPrBody("f", deps)
    expect(edits).toHaveLength(1)
    expect(edits[0]).not.toContain("build-screenshots:start")
    expect(edits[0]).toContain("Body")
    expect(result.status).toBe("removed")
  })

  test("re-run idempotency → unchanged body skips editPrBody, still embedded", () => {
    const body = upsertScreenshotBlock(
      "Body",
      buildScreenshotBlock({
        owner: "o",
        repo: "r",
        sha: SHA,
        feature: "f",
        files: ["login.png"],
      }),
    )
    const { deps, edits } = makeDeps({
      publish: { status: "clean" },
      files: ["login.png"],
      body,
    })
    const result = embedScreenshotsInPrBody("f", deps)
    expect(edits).toHaveLength(0)
    expect(result).toEqual({ status: "embedded", count: 1 })
  })
})
