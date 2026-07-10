/**
 * Parse `build/<dir>/observations.md` files into stable, source-occurrence-specific
 * signals, and hash each into a durable `signalId`.
 *
 * The entry format is exactly what the build agents write (`bin/build/prompts.ts`):
 *
 *   ## <short title>
 *   - **kind:** bug | refactor | tech-debt | test-gap | perf | e2e-infra | eval-infra | schema-narrow
 *   - **where:** path/to/file.ts:42
 *   - **why out of scope:** <one line>
 *   - **suggestion:** <what a future engineer should do>
 *
 * Identity is per-occurrence: `sha256(sourcePath + "\0" + normalize(raw))`. Two
 * identical entries in two different build dirs therefore get DIFFERENT ids —
 * they are distinct occurrences, each its own ledger row. The agent clusters
 * related occurrences into one Linear issue downstream; we never collapse here.
 * (LLMs can't hash reliably, so this must be code — the design's central rule.)
 */

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

export type ObservationKind =
  | "bug"
  | "refactor"
  | "tech-debt"
  | "test-gap"
  | "perf"
  | "e2e-infra"
  | "eval-infra"
  | "schema-narrow"

export type ObservationSignal = {
  /** Repo-relative source path, e.g. `build/payg/observations.md`. */
  sourcePath: string
  /** The feature dir name, e.g. `payg`. */
  featureDir: string
  title: string
  /** Parsed `kind:` if it matched a known value, else null (files vary). */
  kind: ObservationKind | null
  where: string | null
  why: string | null
  suggestion: string | null
  /** The raw entry text (heading + body), used for hashing + briefs. */
  raw: string
}

const KNOWN_KINDS: ReadonlySet<string> = new Set([
  "bug",
  "refactor",
  "tech-debt",
  "test-gap",
  "perf",
  "e2e-infra",
  "eval-infra",
  "schema-narrow",
])

/** Collapse whitespace so a reflowed-but-identical entry hashes the same. */
function normalize(raw: string): string {
  return raw.trim().replace(/\s+/g, " ")
}

/** Stable, source-occurrence-specific identity for an observation signal. */
export function signalIdFor(sig: { sourcePath: string; raw: string }): string {
  const hash = createHash("sha256")
    .update(sig.sourcePath)
    .update("\0")
    .update(normalize(sig.raw))
    .digest("hex")
  return `sha256:${hash}`
}

/** Pull the value out of a `- **field:** value` bullet line, if present. */
function bulletValue(body: string, field: string): string | null {
  const re = new RegExp(`^\\s*-\\s*\\*\\*${field}:\\*\\*\\s*(.+)$`, "im")
  const m = body.match(re)
  return m ? m[1].trim() : null
}

/**
 * Parse one observations file into its signals. Splits on `^## ` headings and
 * tolerates missing fields (real files vary — some omit `why`/`suggestion`).
 * The leading `# ...` document title (if any) is ignored.
 */
export function parseObservationsFile(
  sourcePath: string,
  contents: string,
): ObservationSignal[] {
  const featureDir = featureDirOf(sourcePath)
  const signals: ObservationSignal[] = []

  // Split into chunks each beginning with a level-2 heading.
  const lines = contents.split("\n")
  let current: string[] | null = null
  const chunks: string[] = []
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (current) chunks.push(current.join("\n"))
      current = [line]
    } else if (current) {
      current.push(line)
    }
  }
  if (current) chunks.push(current.join("\n"))

  for (const raw of chunks) {
    const headingMatch = raw.match(/^##\s+(.+)$/m)
    const title = headingMatch ? headingMatch[1].trim() : ""
    if (!title) continue
    const kindRaw = bulletValue(raw, "kind")
    const kind =
      kindRaw && KNOWN_KINDS.has(kindRaw) ? (kindRaw as ObservationKind) : null
    signals.push({
      sourcePath,
      featureDir,
      title,
      kind,
      where: bulletValue(raw, "where"),
      why: bulletValue(raw, "why out of scope"),
      suggestion: bulletValue(raw, "suggestion"),
      raw: raw.trimEnd(),
    })
  }

  return signals
}

/** `build/<dir>/observations.md` → `<dir>`. */
export function featureDirOf(sourcePath: string): string {
  const parts = sourcePath.split("/")
  const idx = parts.indexOf("build")
  return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : ""
}

/**
 * Glob `build/<dir>/observations.md` (skipping `build/kickoff/`, the system's
 * own dir), parse each, and return the FLAT list of all occurrences — no
 * cross-dir dedup/collapsing (that is the agent's clustering job downstream).
 */
export function collectObservationSignals(
  repoRoot: string,
): ObservationSignal[] {
  const buildRoot = join(repoRoot, "build")
  if (!existsSync(buildRoot)) return []

  const out: ObservationSignal[] = []
  for (const entry of readdirSync(buildRoot).sort()) {
    if (entry === "kickoff") continue
    const dir = join(buildRoot, entry)
    if (!statSync(dir).isDirectory()) continue
    const file = join(dir, "observations.md")
    if (!existsSync(file)) continue
    const sourcePath = relative(repoRoot, file).split("\\").join("/")
    out.push(...parseObservationsFile(sourcePath, readFileSync(file, "utf-8")))
  }
  return out
}
