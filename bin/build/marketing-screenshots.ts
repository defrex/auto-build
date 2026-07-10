/**
 * Deterministic marketing-screenshot gate for the /build e2e stage.
 *
 * The spec makes a marketing screenshot MANDATORY for every featured `##`
 * changelog section a build introduces. This module supplies a pure detector
 * (`detectNewFeaturedSections`) over a `git diff` of the changelog content dir
 * plus an injectable-deps validator (`validateMarketingScreenshots`) that the
 * e2e check consults after execute returns `E2E_PASS`.
 *
 * It inspects ONLY git state (diff + status) + on-disk files — it opens no
 * browser and no dev server — so it runs as a deterministic gate after the
 * execute agent captured the screenshots, preserving the spec's "all capture in
 * execute" constraint (the capture-vs-validation split). It validates against
 * COMMITTED state: any uncommitted change under the changelog content/image dirs
 * fails the gate closed, because the PR phase pushes only committed state and an
 * uncommitted `.mdx`/`.png` would silently never reach the branch.
 */

import { existsSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { appendLog } from "./log"
import { sh } from "./repo"

/** Canonical heading for the non-featured "minor changes" bucket (docs SKILL). */
const SMALLER_CHANGES_HEADING = "Smaller changes"

/** Repo-relative dir holding the weekly changelog posts. */
const CHANGELOG_CONTENT_DIR = "apps/docs/content/docs/changelog/"

/** Repo-relative dir holding the marketing screenshot images. */
const CHANGELOG_PUBLIC_DIR = "apps/docs/public/changelog/"

export type FeaturedSection = { file: string; heading: string }

/**
 * Parse a `git diff` of apps/docs/content/docs/changelog/ and return the
 * featured `##` sections this build ADDED. A section is "added + featured" when
 * a content line `+## <name>` appears in the diff and `<name>` is not
 * "Smaller changes". `file` is taken from the enclosing `+++ b/<path>` header.
 * `+++` file-header lines begin with `+` but are not content and are ignored.
 * Self-defending: only adds under the changelog content dir count, so an
 * unscoped diff (a `+## Foo` heading in an unrelated markdown file) is ignored
 * even though the production caller already path-scopes its `git diff`.
 */
export function detectNewFeaturedSections(diff: string): FeaturedSection[] {
  const sections: FeaturedSection[] = []
  let currentFile: string | null = null
  for (const line of diff.split("\n")) {
    // File header: `+++ b/<path>` — tracks the file the following adds belong to.
    const header = line.match(/^\+\+\+ b\/(.+)$/)
    if (header) {
      currentFile = header[1].trim()
      continue
    }
    // A content add is a single `+` (not the `+++` header, handled above).
    if (!line.startsWith("+") || line.startsWith("+++")) continue
    if (currentFile === null || !currentFile.startsWith(CHANGELOG_CONTENT_DIR))
      continue
    const content = line.slice(1)
    const headingMatch = content.match(/^##\s+(.+)$/)
    if (!headingMatch) continue
    const name = headingMatch[1].trim()
    if (name === SMALLER_CHANGES_HEADING) continue
    sections.push({ file: currentFile, heading: `## ${name}` })
  }
  return sections
}

/**
 * Result of computing the changelog diff. A failure (missing/stale base ref,
 * corrupt repo, git error) is distinct from an empty diff: empty means "no
 * featured section introduced ⇒ no requirement", whereas a failure means we
 * COULD NOT TELL whether a featured section was introduced — which must fail the
 * gate closed rather than silently passing it.
 */
export type ChangelogDiffResult =
  | { ok: true; diff: string }
  | { ok: false; error: string }

export type MarketingDeps = {
  /**
   * `git diff origin/<base>..HEAD -- apps/docs/content/docs/changelog/`, as a
   * result so a diff failure fails the gate closed instead of reading as "empty
   * diff ⇒ no featured section".
   */
  changelogDiff: () => ChangelogDiffResult
  /** read current content of a repo-relative path, or null if unreadable. */
  readFile: (relPath: string) => string | null
  /** does apps/docs/public/changelog/<name> exist (name includes ".png"). */
  imageExists: (name: string) => boolean
  /**
   * Basenames (incl. ".png") of changelog images THIS build introduces — added
   * or modified relative to origin/<base> AND committed. Working-tree-only files
   * are deliberately excluded: the {@link MarketingDeps.uncommittedChangelogPaths}
   * gate rejects any uncommitted changelog change up-front, so by the time this
   * is consulted the committed set is the only set that matters (and the only
   * one the PR push will carry). Used to reject a featured section that links a
   * pre-existing base-branch image instead of producing its own screenshot.
   */
  newImages: () => string[]
  /**
   * Repo-relative paths of UNCOMMITTED changes under the changelog content/image
   * dirs (working-tree modifications + untracked files). The PR phase pushes
   * only committed state, so any uncommitted changelog asset would be silently
   * dropped from the branch. A non-empty result fails the gate closed, forcing
   * the atomic PNG+`.mdx` commit the capture instructions require.
   */
  uncommittedChangelogPaths: () => string[]
}

/**
 * Validate that every featured changelog section THIS build introduced wires in
 * a marketing screenshot that THIS build produced — a `/changelog/<name>.png`
 * reference whose image both exists on disk AND is introduced by this build's
 * diff (so linking a pre-existing base-branch image cannot satisfy the gate).
 * Returns the list of problems; empty ⇒ satisfied (or no featured section
 * introduced ⇒ no requirement). Pure (logic lives here; IO is injected via
 * {@link MarketingDeps}).
 */
export function validateMarketingScreenshots(deps: MarketingDeps): {
  ok: boolean
  problems: string[]
} {
  const diffResult = deps.changelogDiff()
  if (!diffResult.ok)
    return {
      ok: false,
      problems: [
        `cannot compute changelog diff to validate marketing screenshots (${diffResult.error}) — failing the marketing gate closed rather than passing on an undeterminable diff, since a featured section could be present but unverified`,
      ],
    }
  // Fail closed on ANY uncommitted change under the changelog content/image
  // dirs BEFORE inspecting sections. The PR phase pushes only committed state,
  // and `publishArtifacts()` stages only build/<feature> — so an uncommitted
  // `.mdx` edit or `.png` would never reach the branch. Critically, an
  // uncommitted `.mdx` also hides its featured section from the committed
  // two-dot diff below, so without this guard the gate would false-pass on a
  // featured section whose marketing asset lives only in the working tree.
  const uncommitted = deps.uncommittedChangelogPaths()
  if (uncommitted.length > 0)
    return {
      ok: false,
      problems: [
        `uncommitted changelog changes (${uncommitted.join(", ")}) — the PR phase pushes only committed state, so commit the marketing screenshot PNG and its .mdx edit atomically (per the capture instructions) before the gate can validate them`,
      ],
    }

  const sections = detectNewFeaturedSections(diffResult.diff)
  if (sections.length === 0) return { ok: true, problems: [] }

  const problems: string[] = []
  // Images this build actually introduced — referencing anything outside this
  // set means reusing a base-branch image, which doesn't satisfy the spec.
  const newImages = new Set(deps.newImages())
  // Track which new featured section first claimed each image, so a second new
  // section reusing the same image is flagged (one screenshot per section).
  const seenImages = new Map<string, string>()

  for (const section of sections) {
    const content = deps.readFile(section.file)
    if (content === null) {
      problems.push(
        `${section.file}: cannot read changelog file to validate featured section '${section.heading}'`,
      )
      continue
    }
    const body = extractSectionBody(content, section.heading)
    const ref = body.match(/\/changelog\/([^\s)"'<>]+\.png)/)
    if (!ref) {
      problems.push(
        `${section.file}: featured section '${section.heading}' has no /changelog/<name>.png reference (marketing screenshot required)`,
      )
      continue
    }
    const name = ref[1]
    if (!deps.imageExists(name)) {
      problems.push(
        `${section.file}: featured section '${section.heading}' references /changelog/${name} but apps/docs/public/changelog/${name} does not exist`,
      )
      continue
    }
    if (!newImages.has(name)) {
      problems.push(
        `${section.file}: featured section '${section.heading}' references /changelog/${name}, but that image is not introduced by this build (it already exists on the base branch) — capture a new marketing screenshot for this section`,
      )
      continue
    }
    if (seenImages.has(name)) {
      problems.push(
        `${section.file}: featured section '${section.heading}' reuses /changelog/${name} already wired to another new featured section — each featured section needs its own marketing screenshot`,
      )
      continue
    }
    seenImages.set(name, section.heading)
  }
  return { ok: problems.length === 0, problems }
}

/**
 * Extract a featured section's body: from the line equal to `heading` up to the
 * next `## ` heading (or EOF). The heading line itself is included so a same-line
 * reference would still be found (defensive — references live in the body).
 * Uses the FIRST matching heading; two sections with identical heading text in
 * one post would both resolve here to the first body — the conservative
 * direction (it fails the gate rather than false-passing), and identical
 * featured headings in one weekly post aren't realistic.
 */
function extractSectionBody(content: string, heading: string): string {
  const lines = content.split("\n")
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start === -1) return ""
  const body: string[] = [lines[start]]
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break
    body.push(lines[i])
  }
  return body.join("\n")
}

/** Narrow context shape `defaultMarketingDeps` needs (a subset of Ctx). */
type MarketingCtx = {
  repoRoot: string
  baseBranch: string
  logPath: string
  now: () => string
}

/**
 * Production IO for {@link validateMarketingScreenshots}. Not unit-tested
 * directly (the pure validator carries the logic); only smoke-covered by
 * typecheck.
 */
export function defaultMarketingDeps(ctx: MarketingCtx): MarketingDeps {
  return {
    changelogDiff: () => {
      // Mirror reconcileWithBase's freshness discipline: fetch the base first so
      // origin/<base> is current (an already-landed featured section must not be
      // re-flagged as "introduced by this build"). On fetch failure, log and
      // diff against the available local ref rather than blocking the gate.
      const fetched = sh(
        ["git", "fetch", "origin", ctx.baseBranch],
        ctx.repoRoot,
      )
      if (fetched.code !== 0)
        appendLog(
          ctx.logPath,
          "e2e: marketing gate base fetch failed; using local ref",
          ctx.now(),
        )
      const r = sh(
        [
          "git",
          "diff",
          `origin/${ctx.baseBranch}..HEAD`,
          "--",
          CHANGELOG_CONTENT_DIR,
        ],
        ctx.repoRoot,
      )
      // Fail closed on a diff error (missing/stale base ref, corrupt repo): we
      // can't tell whether a featured section was introduced, so surface it as a
      // gate problem rather than silently collapsing to "no featured section".
      if (r.code !== 0)
        return {
          ok: false,
          error: r.stderr.trim() || `git diff exited with code ${r.code}`,
        }
      return { ok: true, diff: r.stdout }
    },
    readFile: (rel) => {
      const p = join(ctx.repoRoot, rel)
      return existsSync(p) ? readFileSync(p, "utf-8") : null
    },
    imageExists: (name) =>
      existsSync(join(ctx.repoRoot, CHANGELOG_PUBLIC_DIR, name)),
    // Relies on changelogDiff() having fetched origin/<base> first (the validator
    // calls it before touching images), so origin/<base> is current here.
    // COMMITTED adds/mods only — working-tree images are rejected up-front by
    // uncommittedChangelogPaths(), so the committed diff is the set the PR push
    // will actually carry.
    newImages: () => {
      const names = new Set<string>()
      const committed = sh(
        [
          "git",
          "diff",
          "--name-only",
          "--diff-filter=AM",
          `origin/${ctx.baseBranch}..HEAD`,
          "--",
          CHANGELOG_PUBLIC_DIR,
        ],
        ctx.repoRoot,
      )
      if (committed.code === 0)
        for (const line of committed.stdout.split("\n")) {
          const p = line.trim()
          if (p) names.add(basename(p))
        }
      return [...names]
    },
    // Uncommitted (working-tree + untracked) changes under BOTH changelog dirs.
    // `git status --porcelain` emits "XY <path>" / "XY <old> -> <new>"; we keep
    // the repo-relative path (new path on a rename) so the gate message names
    // exactly what must be committed. Path-scoped to the two changelog dirs.
    uncommittedChangelogPaths: () => {
      const status = sh(
        [
          "git",
          "status",
          "--porcelain",
          "--",
          CHANGELOG_CONTENT_DIR,
          CHANGELOG_PUBLIC_DIR,
        ],
        ctx.repoRoot,
      )
      if (status.code !== 0) return []
      const paths: string[] = []
      for (const raw of status.stdout.split("\n")) {
        if (raw.trim() === "") continue
        const p = raw.slice(3).split(" -> ").pop()?.trim()
        if (p) paths.push(p)
      }
      return paths
    },
  }
}
