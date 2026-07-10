/**
 * Pure slug + branch-name helpers for the kickoff run.
 *
 * The Linear identifier in the branch name is the loop-closer: Linear's GitHub
 * integration auto-links a PR to the issue by branch name and auto-resolves the
 * issue on merge (design "Closing the loop"). The id is therefore a HARD part of
 * the branch name — tests assert it is always present.
 */

import { basename, dirname, join } from "node:path"

const MAX_SLUG_WORDS = 3
/** Safety cap for pathological single tokens — the 3-word cut is the real limit. */
const MAX_SLUG_LEN = 50

/**
 * Kebab-case, lowercased, alphanumeric-only, capped to {@link MAX_SLUG_WORDS}
 * words (with {@link MAX_SLUG_LEN} as a single-token safety guard). Doubles as
 * the normalizer for LLM-suggested slugs (see `slug-llm.ts`) and the
 * deterministic fallback when the model is unavailable — keep it pure.
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, MAX_SLUG_WORDS)
    .join("-")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, "")
  // `kickoff` is the orchestration's own reserved build dir — never emit it bare.
  if (slug === "" || slug === "kickoff") return "task"
  return slug
}

/**
 * `dis-123-make-reads-bounded`. The Linear id is lowercased and always embedded
 * (no scheme prefix) so the resulting PR auto-links + auto-resolves the issue —
 * Linear keys off the id token, not a prefix.
 */
export function kickoffBranch(linearId: string, slug: string): string {
  const id = linearId.toLowerCase().trim()
  return `${id}-${slug}`
}

/**
 * The worktree directory `gwt add <branch>` creates for `branch`: a sibling of
 * the main worktree named `<project>-<safe-branch>`, where `<safe-branch>` is the
 * branch lowercased with every `/` replaced by `-` (mirrors `gwt` add, which does
 * `tr '[:upper:]' '[:lower:]'` then `${branch//\//-}`). Pure — used both as the
 * pre-create collision/idempotency prediction and (in restore) as the actual
 * per-ticket path. `gwt` prints the path it created to stdout, so for the build
 * path itself the captured stdout is authoritative and this prediction is only a
 * fallback. Assumes `mainWorktreePath` is the MAIN checkout (gwt always anchors
 * to the first `git worktree list` entry).
 */
export function gwtWorktreeDir(
  mainWorktreePath: string,
  branch: string,
): string {
  const safe = branch.toLowerCase().replaceAll("/", "-")
  return join(
    dirname(mainWorktreePath),
    `${basename(mainWorktreePath)}-${safe}`,
  )
}

/**
 * Extract the `<slug>` from an `<id>-<slug>` branch name (`<id>` = `<team>-<n>`),
 * or null when the branch doesn't fit `<letters>-<digits>-<rest>`. The optional
 * `kickoff/` prefix is tolerated so in-flight legacy `kickoff/<id>-<slug>`
 * branches/worktrees still parse during the transition. Without the prefix the
 * shape match is looser — a coincidental `feat-2-x` branch now yields `x` rather
 * than null — but the only caller that runs over arbitrary branches
 * (`kickoff --cleanup`) treats a non-kickoff slug as a safe teardown no-op. The
 * single parser for this scheme — `resolveRestoreSlug` and `kickoff --cleanup`
 * both call it so the slug (the `/build` arg + herdr label) never diverges. Pure.
 */
export function slugFromKickoffBranch(branch: string): string | null {
  const m = branch.match(/^(?:kickoff\/)?[a-z]+-\d+-(.+)$/i)
  return m?.[1] ?? null
}
