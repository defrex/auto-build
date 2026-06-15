/**
 * Render the Linear brief into the worktree's `build/<slug>/spec.md`
 * (pure). The brief is authored as a proto-spec, so this is a *verbatim*
 * passthrough — the spec body IS the issue description, so the `/build`
 * file→ticket sync (which compares spec.md to the description verbatim) sees no
 * difference on a freshly-launched build. No generated header/footer.
 *
 * The slug/branch still derive from the selection's title/issueId in
 * `kickoff.ts`; the issue id lives on the branch name + in `state.json`, not in
 * the spec body.
 */
export function specDocFromBrief(brief: string): string {
  return `${brief.trim()}\n`
}
