/**
 * Pure slug + branch-name helpers for the kickoff run.
 *
 * The Linear identifier in the branch name is the loop-closer: Linear's GitHub
 * integration auto-links a PR to the issue by branch name and auto-resolves the
 * issue on merge (design "Closing the loop"). The id is therefore a HARD part of
 * the branch name — tests assert it is always present.
 */

const MAX_SLUG_LEN = 50

/** Kebab-case, lowercased, alphanumeric-only, length-capped. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, "")
  return slug || "task"
}

/**
 * `kickoff/dis-123-make-reads-bounded`. The Linear id is lowercased and
 * always embedded so the resulting PR auto-links + auto-resolves the issue.
 */
export function kickoffBranch(
  linearId: string,
  slug: string,
  prefix = "kickoff",
): string {
  const id = linearId.toLowerCase().trim()
  return `${prefix}/${id}-${slug}`
}
