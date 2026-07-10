/**
 * Extract Sentry short-ids from the hidden `<!-- sentry-fixes: X -->` markers
 * that `/triage-sentry` writes into a Linear ticket description (and which the
 * ticket-mode build syncs verbatim into `spec.md`). The build PR phase reads
 * these and emits a `fixes <SHORT-ID>` line so Sentry auto-resolves the issue
 * once the fix ships in a release. Pure (no fs). See plan.md D2.
 *
 * Note on the broad token class: the regex accepts any `[A-Z0-9-]+` token rather
 * than re-encoding Sentry's `PROJECT-KEY-SUFFIX` grammar. The short-id that
 * lands in the marker is whatever `/triage-sentry` round-tripped through Sentry
 * MCP for this project, so this is an EXTRACTOR, not a validator — a stricter
 * regex risks silently dropping a legitimate id if Sentry's format shifts.
 */

const SENTRY_FIXES_MARKER = /<!--\s*sentry-fixes:\s*([A-Z0-9-]+)\s*-->/g

/** Extract Sentry short-ids from `<!-- sentry-fixes: X -->` markers, de-duped, in order. */
export function extractSentryFixes(specContents: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of specContents.matchAll(SENTRY_FIXES_MARKER)) {
    const id = match[1]
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
