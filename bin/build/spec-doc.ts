/**
 * Canonical-input resolver for the build pipeline.
 *
 * The per-feature input artifact `/spec` produces is `spec.md`. In-flight
 * worktrees on other branches may still carry the old name `design.md`, so the
 * read path falls back to it when `spec.md` is absent. **All writes target
 * `spec.md`** — `design.md` is read-only legacy, never produced.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

/** The canonical input filename produced by `/spec` and read by the pipeline. */
export const SPEC_FILE = "spec.md"
/** The legacy filename, read as a fallback for in-flight worktrees. */
export const LEGACY_DESIGN_FILE = "design.md"

/**
 * Resolve the canonical-input path for a build dir: `spec.md` if it exists,
 * else `design.md` if only it exists, else the `spec.md` path (the default,
 * used for messages and writes — writes always target `spec.md`).
 */
export function resolveSpecPath(buildDir: string): string {
  const specPath = join(buildDir, SPEC_FILE)
  if (existsSync(specPath)) return specPath
  const designPath = join(buildDir, LEGACY_DESIGN_FILE)
  if (existsSync(designPath)) return designPath
  return specPath
}

/** True when either `spec.md` or the legacy `design.md` exists in the build dir. */
export function specExists(buildDir: string): boolean {
  return (
    existsSync(join(buildDir, SPEC_FILE)) ||
    existsSync(join(buildDir, LEGACY_DESIGN_FILE))
  )
}
