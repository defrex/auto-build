import { describe, expect, test } from "bun:test"
import {
  detectNewFeaturedSections,
  type MarketingDeps,
  validateMarketingScreenshots,
} from "./marketing-screenshots"

describe("detectNewFeaturedSections", () => {
  test("empty diff → []", () => {
    expect(detectNewFeaturedSections("")).toEqual([])
  })

  test("diff adding only `## Smaller changes` + bullets → []", () => {
    const diff = [
      "+++ b/apps/docs/content/docs/changelog/2026-06-22.mdx",
      "+## Smaller changes",
      "+- **Fixed a typo** — somewhere",
    ].join("\n")
    expect(detectNewFeaturedSections(diff)).toEqual([])
  })

  test("diff adding one featured heading → one section with file from the header", () => {
    const diff = [
      "diff --git a/apps/docs/content/docs/changelog/2026-06-22.mdx b/apps/docs/content/docs/changelog/2026-06-22.mdx",
      "--- a/apps/docs/content/docs/changelog/2026-06-22.mdx",
      "+++ b/apps/docs/content/docs/changelog/2026-06-22.mdx",
      "@@ -1,3 +1,8 @@",
      "+## New thing",
      "+",
      "+It does a thing.",
    ].join("\n")
    expect(detectNewFeaturedSections(diff)).toEqual([
      {
        file: "apps/docs/content/docs/changelog/2026-06-22.mdx",
        heading: "## New thing",
      },
    ])
  })

  test("diff adding two featured headings → both returned", () => {
    const diff = [
      "+++ b/apps/docs/content/docs/changelog/2026-06-22.mdx",
      "+## First thing",
      "+++ b/apps/docs/content/docs/changelog/2026-06-15.mdx",
      "+## Second thing",
    ].join("\n")
    expect(detectNewFeaturedSections(diff)).toEqual([
      {
        file: "apps/docs/content/docs/changelog/2026-06-22.mdx",
        heading: "## First thing",
      },
      {
        file: "apps/docs/content/docs/changelog/2026-06-15.mdx",
        heading: "## Second thing",
      },
    ])
  })

  test("a `+++ b/...` header line is not mistaken for a heading", () => {
    const diff = [
      "+++ b/apps/docs/content/docs/changelog/2026-06-22.mdx",
      "+regular content",
    ].join("\n")
    expect(detectNewFeaturedSections(diff)).toEqual([])
  })
})

describe("validateMarketingScreenshots", () => {
  function makeDeps(opts: {
    diff?: string
    diffError?: string
    files?: Record<string, string | null>
    images?: string[]
    // Images introduced by this build. Defaults to `images` so existing
    // happy-path cases (an existing image is also new) stay green; set it
    // distinctly to model a base-branch image reused without a new capture.
    newImages?: string[]
    // Uncommitted changelog paths (working-tree changes the PR push would drop).
    // Defaults to [] so existing committed-state cases stay green.
    uncommittedChangelogPaths?: string[]
  }): MarketingDeps {
    return {
      changelogDiff: () =>
        opts.diffError !== undefined
          ? { ok: false, error: opts.diffError }
          : { ok: true, diff: opts.diff ?? "" },
      readFile: (rel) => opts.files?.[rel] ?? null,
      imageExists: (name) => (opts.images ?? []).includes(name),
      newImages: () => opts.newImages ?? opts.images ?? [],
      uncommittedChangelogPaths: () => opts.uncommittedChangelogPaths ?? [],
    }
  }

  test("no changelog diff → ok", () => {
    const result = validateMarketingScreenshots(makeDeps({ diff: "" }))
    expect(result).toEqual({ ok: true, problems: [] })
  })

  test("changelog diff fails (missing/stale base ref) → not ok, fails closed", () => {
    const result = validateMarketingScreenshots(
      makeDeps({ diffError: "fatal: bad revision 'origin/main'" }),
    )
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain(
      "cannot compute changelog diff",
    )
  })

  test("uncommitted changelog changes → not ok, fails closed (PR pushes only committed state)", () => {
    // An uncommitted .mdx edit hides the featured section from the committed
    // two-dot diff, so detectNewFeaturedSections sees nothing — the gate must
    // still fail closed instead of passing on assets the PR push would drop.
    const result = validateMarketingScreenshots(
      makeDeps({
        diff: "",
        uncommittedChangelogPaths: [
          "apps/docs/content/docs/changelog/2026-06-22.mdx",
          "apps/docs/public/changelog/foo.png",
        ],
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("uncommitted")
    expect(result.problems.join("\n")).toContain(
      "apps/docs/public/changelog/foo.png",
    )
  })

  test("uncommitted check fires before the no-featured-section early return", () => {
    // Even with a featured section already committed and wired, a leftover
    // uncommitted changelog change must fail the gate (it would not be pushed).
    const file = "apps/docs/content/docs/changelog/2026-06-22.mdx"
    const diff = [`+++ b/${file}`, "+## New thing"].join("\n")
    const result = validateMarketingScreenshots(
      makeDeps({
        diff,
        files: { [file]: "## New thing\n\n![s](/changelog/foo.png)\n" },
        images: ["foo.png"],
        uncommittedChangelogPaths: ["apps/docs/public/changelog/foo.png"],
      }),
    )
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("uncommitted")
  })

  test("only `## Smaller changes` → ok", () => {
    const diff = [
      "+++ b/apps/docs/content/docs/changelog/2026-06-22.mdx",
      "+## Smaller changes",
      "+- **x** — y",
    ].join("\n")
    expect(validateMarketingScreenshots(makeDeps({ diff })).ok).toBe(true)
  })

  test("one new featured section, wired + image exists → ok", () => {
    const file = "apps/docs/content/docs/changelog/2026-06-22.mdx"
    const diff = [`+++ b/${file}`, "+## New thing"].join("\n")
    const deps = makeDeps({
      diff,
      files: {
        [file]: "## New thing\n\n![shot](/changelog/foo.png)\n",
      },
      images: ["foo.png"],
    })
    expect(validateMarketingScreenshots(deps)).toEqual({
      ok: true,
      problems: [],
    })
  })

  test("one new featured section, no image reference → not ok", () => {
    const file = "apps/docs/content/docs/changelog/2026-06-22.mdx"
    const diff = [`+++ b/${file}`, "+## New thing"].join("\n")
    const deps = makeDeps({
      diff,
      files: { [file]: "## New thing\n\nNo image here.\n" },
    })
    const result = validateMarketingScreenshots(deps)
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("no /changelog")
  })

  test("featured section reusing a pre-existing base-branch image → not ok", () => {
    const file = "apps/docs/content/docs/changelog/2026-06-22.mdx"
    const diff = [`+++ b/${file}`, "+## New thing"].join("\n")
    const deps = makeDeps({
      diff,
      files: { [file]: "## New thing\n\n![s](/changelog/old.png)\n" },
      images: ["old.png"], // exists on disk...
      newImages: [], // ...but not introduced by this build
    })
    const result = validateMarketingScreenshots(deps)
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("not introduced by this build")
  })

  test("featured section referencing a missing image file → not ok", () => {
    const file = "apps/docs/content/docs/changelog/2026-06-22.mdx"
    const diff = [`+++ b/${file}`, "+## New thing"].join("\n")
    const deps = makeDeps({
      diff,
      files: { [file]: "## New thing\n\n![s](/changelog/foo.png)\n" },
      images: [],
    })
    const result = validateMarketingScreenshots(deps)
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("does not exist")
  })

  test("multiple new featured sections, one missing an image → one problem naming the second", () => {
    const file = "apps/docs/content/docs/changelog/2026-06-22.mdx"
    const diff = [`+++ b/${file}`, "+## First thing", "+## Second thing"].join(
      "\n",
    )
    const deps = makeDeps({
      diff,
      files: {
        [file]: [
          "## First thing",
          "",
          "![a](/changelog/first.png)",
          "",
          "## Second thing",
          "",
          "No image.",
        ].join("\n"),
      },
      images: ["first.png"],
    })
    const result = validateMarketingScreenshots(deps)
    expect(result.ok).toBe(false)
    expect(result.problems).toHaveLength(1)
    expect(result.problems[0]).toContain("Second thing")
  })

  test("cannot read the changelog file → problem", () => {
    const file = "apps/docs/content/docs/changelog/2026-06-22.mdx"
    const diff = [`+++ b/${file}`, "+## New thing"].join("\n")
    const deps = makeDeps({ diff, files: { [file]: null } })
    const result = validateMarketingScreenshots(deps)
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("cannot read")
  })

  test("uniqueness: two new featured sections reusing the same image → not ok, names second + 'reuses'", () => {
    const file = "apps/docs/content/docs/changelog/2026-06-22.mdx"
    const diff = [`+++ b/${file}`, "+## First thing", "+## Second thing"].join(
      "\n",
    )
    const deps = makeDeps({
      diff,
      files: {
        [file]: [
          "## First thing",
          "",
          "![a](/changelog/foo.png)",
          "",
          "## Second thing",
          "",
          "![b](/changelog/foo.png)",
        ].join("\n"),
      },
      images: ["foo.png"],
    })
    const result = validateMarketingScreenshots(deps)
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("reuses")
    expect(result.problems.join("\n")).toContain("Second thing")
  })

  test("uniqueness inverse: distinct references both exist → ok", () => {
    const file = "apps/docs/content/docs/changelog/2026-06-22.mdx"
    const diff = [`+++ b/${file}`, "+## First thing", "+## Second thing"].join(
      "\n",
    )
    const deps = makeDeps({
      diff,
      files: {
        [file]: [
          "## First thing",
          "",
          "![a](/changelog/foo.png)",
          "",
          "## Second thing",
          "",
          "![b](/changelog/bar.png)",
        ].join("\n"),
      },
      images: ["foo.png", "bar.png"],
    })
    expect(validateMarketingScreenshots(deps)).toEqual({
      ok: true,
      problems: [],
    })
  })
})
