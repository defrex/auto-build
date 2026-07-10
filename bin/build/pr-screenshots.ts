/**
 * PR-body screenshot embedding for the /build PR phase.
 *
 * Splits cleanly into:
 *  - pure markdown helpers (block build + upsert into an existing body), so the
 *    body manipulation is fully unit-testable; and
 *  - `embedScreenshotsInPrBody`, a deterministic IO orchestrator with injected
 *    deps that PUBLISHES the build record to the PR branch FIRST, then embeds
 *    SHA-pinned blob-view links that reference those just-published files — the
 *    publish-before-embed ordering is the load-bearing correctness property (the
 *    SHA must name the commit that actually contains the screenshots).
 *
 * Embedding runs as a deterministic post-step AFTER the `/pr` skill writes the
 * body, re-applied on every PR-phase run via `upsertScreenshotBlock`, so it
 * survives `/pr` regenerating the body (spec).
 */

import { existsSync, readdirSync } from "node:fs"
import type { PublishResult } from "./repo"

export const SCREENSHOT_BLOCK_START = "<!-- build-screenshots:start -->"
export const SCREENSHOT_BLOCK_END = "<!-- build-screenshots:end -->"

/** Image extensions an embedded screenshot may use. */
const IMAGE_RE = /\.(png|jpe?g|webp)$/i

/**
 * Shared image-file lister: the image files directly under `dir`, sorted for a
 * stable order. Returns `[]` when the dir is absent (existsSync-guarded). Reused
 * by the orchestrator's `listScreenshots` so the image regex lives in one place.
 */
export function listImageFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => IMAGE_RE.test(f))
    .sort()
}

/**
 * GitHub blob-view URL for a committed screenshot, pinned to a commit SHA.
 *
 * The SHA (not the branch name) is load-bearing: the repo auto-deletes branches
 * on squash-merge, but GitHub permanently retains PR head commits via
 * `refs/pull/<n>/head`, so a SHA-pinned blob link keeps resolving after merge.
 * A blob link (not an inline raw image) is the only private-safe, zero-infra
 * mechanism — raw images don't render for private repos.
 */
export function blobScreenshotUrl(
  owner: string,
  repo: string,
  sha: string,
  feature: string,
  file: string,
): string {
  return `https://github.com/${owner}/${repo}/blob/${sha}/build/${feature}/screenshots/${file}`
}

/**
 * The delimited markdown block — a `## Verification` heading plus one
 * `- [file](blobUrl)` link per file, wrapped in the start/end markers. Returns
 * "" when `files` is empty (nothing to embed).
 */
export function buildScreenshotBlock(args: {
  owner: string
  repo: string
  sha: string
  feature: string
  files: string[]
}): string {
  const { owner, repo, sha, feature, files } = args
  if (files.length === 0) return ""
  const links = files.map(
    (f) => `- [${f}](${blobScreenshotUrl(owner, repo, sha, feature, f)})`,
  )
  return [
    SCREENSHOT_BLOCK_START,
    "## Verification",
    "",
    ...links,
    SCREENSHOT_BLOCK_END,
  ].join("\n")
}

/**
 * Upsert the delimited block into an existing PR body:
 *  - if start/end markers are present, REPLACE the inner block (no stacking);
 *  - else APPEND the block (separated by a blank line);
 *  - if `block === ""`, STRIP any existing block (re-run with no shots cleans up).
 * Preserves all other body text. Returns the new body.
 */
export function upsertScreenshotBlock(body: string, block: string): string {
  const start = body.indexOf(SCREENSHOT_BLOCK_START)
  const end = body.indexOf(SCREENSHOT_BLOCK_END)
  const hasBlock = start !== -1 && end !== -1 && end > start

  if (hasBlock) {
    const before = body.slice(0, start)
    const after = body.slice(end + SCREENSHOT_BLOCK_END.length)
    if (block === "") {
      // Strip: drop the block and collapse the surrounding blank lines so the
      // body doesn't accumulate whitespace across re-runs.
      return `${before.replace(/\n+$/, "")}${after.replace(/^\n+/, "")}`.trim()
    }
    return `${before}${block}${after}`
  }
  if (block === "") return body
  // Append, separated by a blank line from existing content.
  return body.trim().length === 0
    ? block
    : `${body.replace(/\n+$/, "")}\n\n${block}`
}

export type EmbedScreenshotDeps = {
  /**
   * Commit + push build/<feature> (screenshots + e2e-report.md) to the PR
   * branch. MUST run before any URL is written. Reuses repo.publishArtifacts.
   */
  publish: () => PublishResult
  listScreenshots: () => string[]
  nameWithOwner: () => string | null // "owner/repo" or null
  // read AFTER publish; the commit that contains the published screenshots; null on failure
  headSha: () => string | null
  prBody: () => string | null // current PR body, or null
  editPrBody: (body: string) => boolean // gh pr edit --body; false on failure
  log: (msg: string) => void
}

/**
 * Outcome of an embed attempt, so the PR phase can BLOCK rather than silently
 * report success when screenshots exist but couldn't be published/embedded:
 *  - `embedded`  — block written (or already correct) for `count` screenshots;
 *  - `removed`   — a now-stale block was stripped (successful empty listing);
 *  - `noop`      — nothing at stake (no screenshots and nothing to clean up),
 *                  including a publish/metadata failure with zero screenshots;
 *  - `failed`    — screenshots EXIST but publish/metadata/edit failed; the PR
 *                  would otherwise ship without the verification block (spec
 *                  violation), so the caller must escalate/retry.
 */
export type EmbedResult =
  | { status: "embedded"; count: number }
  | { status: "removed" }
  | { status: "noop" }
  | { status: "failed"; reason: string }

/**
 * Deterministically embed the committed verification screenshots into the PR
 * body. Ordering is enforced by code structure (the load-bearing fix):
 *  1. publish FIRST — abort embedding if it failed (never write dangling URLs);
 *  2. resolve owner/sha/body — the SHA is read AFTER publish so it names the
 *     commit that contains the screenshots; a transient lookup failure aborts
 *     WITHOUT editing (never strips on a metadata failure, only on a successful
 *     empty listing);
 *  3. build the block and upsert it; call editPrBody only when the body changed.
 *
 * Returns an `EmbedResult`. When screenshots exist but any step fails, the
 * result is `failed` (with a reason) so the PR phase blocks instead of moving on
 * to monitor with a screenshot-less PR — there is no guaranteed later retry once
 * the state machine advances. Failures with zero screenshots are `noop` (nothing
 * at stake) and are logged but never block.
 */
export function embedScreenshotsInPrBody(
  feature: string,
  deps: EmbedScreenshotDeps,
): EmbedResult {
  // Local read, safe before publish (writes no URLs): lets us distinguish a
  // failure that drops required screenshots from one with nothing at stake.
  const files = deps.listScreenshots()

  const pub = deps.publish()
  if (pub.status === "failed") {
    const reason = `screenshot publish failed (${pub.detail})`
    deps.log(`pr: ${reason}; skipping PR-body embed`)
    return files.length === 0
      ? { status: "noop" }
      : { status: "failed", reason }
  }

  const nameWithOwner = deps.nameWithOwner()
  const sha = deps.headSha()
  const body = deps.prBody()
  if (nameWithOwner === null || sha === null || body === null) {
    // A metadata-lookup failure must NOT trigger a strip — leave any existing
    // block intact and retry on the next PR-phase run.
    const reason = "could not resolve repo/sha/body for screenshot embed"
    deps.log(`pr: ${reason}; leaving PR body untouched`)
    return files.length === 0
      ? { status: "noop" }
      : { status: "failed", reason }
  }
  const [owner, repo] = nameWithOwner.split("/")

  const block = buildScreenshotBlock({ owner, repo, sha, feature, files })
  const next = upsertScreenshotBlock(body, block)
  if (next === body) {
    // No change needed: either nothing to do, or the block is already correct.
    return files.length === 0
      ? { status: "noop" }
      : { status: "embedded", count: files.length }
  }
  const edited = deps.editPrBody(next)
  if (!edited) {
    const reason = "gh pr edit failed to update the PR body"
    deps.log(`pr: ${reason}`)
    // A strip that fails leaves a stale block but loses nothing required; only
    // a failed embed of existing screenshots is a spec violation.
    return files.length === 0
      ? { status: "noop" }
      : { status: "failed", reason }
  }
  deps.log(
    files.length === 0
      ? "pr: removed stale screenshot block from PR body"
      : `pr: embedded ${files.length} screenshot(s) in PR body`,
  )
  return files.length === 0
    ? { status: "removed" }
    : { status: "embedded", count: files.length }
}
