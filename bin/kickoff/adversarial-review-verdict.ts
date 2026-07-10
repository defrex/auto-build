/**
 * Pure core of the adversarial review step: the structured-verdict schema, a
 * robust parser for Codex's final message, repeat-detection across rounds, and
 * the deterministic stop/continue decision.
 *
 * This module has NO I/O — it is the unit-testable judgment that the skill must
 * never hand-eyeball. The impure single-round executor (`adversarial-review.ts`)
 * spawns Codex, then funnels its output through `parseAdversarialVerdict` →
 * `classifyHoles` → `decideReviewAction`.
 *
 * Parsing mirrors the robustness of `bin/build/verdicts.ts` ("last block wins /
 * trailing prose is fine"), but the verdict here is a fenced JSON object rather
 * than a bare sentinel line.
 */

import { z } from "zod"

export const severitySchema = z.enum(["low", "medium", "high"])

/** One hole Codex raised against the brief. */
export const holeSchema = z.object({
  id: z.string(), // stable id; Codex reuses it verbatim when re-raising
  claim: z.string(), // the specific claim under attack
  weakness: z.string(), // why it's weak / unsupported
  resolution: z.string(), // the specific evidence or change that would resolve it
  severity: severitySchema,
})
export type Hole = z.infer<typeof holeSchema>

/** Reviewer's accept/reject judgment on one prior-round hole's resolution. */
export const resolutionVerdictSchema = z.object({
  id: z.string(), // matches a prior hole's id
  accepted: z.boolean(), // did the author's response close this prior hole?
  reason: z.string(), // one line: why accepted / why still open
})
export type ResolutionVerdict = z.infer<typeof resolutionVerdictSchema>

export const adversarialVerdictSchema = z
  .object({
    verdict: z.enum(["sufficient", "holes"]),
    holes: z.array(holeSchema).default([]), // empty when sufficient
    // From round 2 on, the reviewer accepts/rejects each prior hole here. Round
    // 1 leaves it empty (defaults to []).
    resolutions: z.array(resolutionVerdictSchema).default([]),
    confidence: severitySchema, // reviewer's confidence in the verdict
    summary: z.string(),
  })
  // The verdict must agree with what is actually still open — both the new
  // `holes` array AND the accept/reject `resolutions` — or downstream
  // stop/continue logic acts on a lie:
  //   - `sufficient` with holes → `decideReviewAction` would stop clean while
  //     unresolved concerns sit in the array.
  //   - `sufficient` with a REJECTED prior resolution → the reviewer says
  //     "nothing open" while explicitly leaving a prior hole open.
  //   - `holes` with no new hole AND no rejected resolution → claims something
  //     is open with nothing to show for it (loops to the cap for nothing).
  // Both refines are context-free (they read only fields of this verdict), so
  // they belong in the schema. A malformed Codex response fails to parse and
  // fails soft as `stop-unavailable` rather than parsing into a bad decision.
  .refine(
    (v) =>
      v.verdict === "sufficient"
        ? v.holes.length === 0 && v.resolutions.every((r) => r.accepted)
        : true,
    {
      message:
        "verdict 'sufficient' must have no holes and no rejected resolutions",
      path: ["holes"],
    },
  )
  .refine(
    (v) =>
      v.verdict === "holes"
        ? v.holes.length > 0 || v.resolutions.some((r) => !r.accepted)
        : true,
    {
      message:
        "verdict 'holes' must carry at least one hole or one rejected resolution",
      path: ["holes"],
    },
  )
export type AdversarialVerdict = z.infer<typeof adversarialVerdictSchema>

/** How the skill answered a hole, carried into the next round's prompt. */
export const holeResolutionSchema = z.object({
  hole: holeSchema, // FULL hole object — not an id string
  response: z.string(), // evidence fetched or brief revision; "" if open
  status: z.enum(["resolved", "open"]),
})
export type HoleResolution = z.infer<typeof holeResolutionSchema>

/** A completed round: what Codex raised + how the skill answered each. */
export const reviewRoundSchema = z.object({
  round: z.number().int().positive(),
  holes: z.array(holeSchema),
  resolutions: z.array(holeResolutionSchema),
})
export type ReviewRound = z.infer<typeof reviewRoundSchema>

/** Full entrypoint input contract — schema-validated before any prompt render. */
export const reviewInputSchema = z.object({
  shortId: z.string(),
  brief: z.string(),
  evidence: z.string(),
  round: z.number().int().positive(),
  cap: z.number().int().positive().default(3),
  priorRounds: z.array(reviewRoundSchema).default([]),
})
export type ValidatedReviewInput = z.infer<typeof reviewInputSchema>

/**
 * Validate the entrypoint input. THROWS on malformed input — the caller's bug
 * to fix and re-run, NOT a fail-soft `stop-unavailable`. Reusing `holeSchema`
 * for `priorRounds[].resolutions[].hole` is what makes the July-6 bug
 * (`hole: <id-string>` instead of a full hole object) impossible: it fails
 * loudly here instead of silently rendering `hole `undefined`` in the prompt.
 */
export function parseReviewInput(raw: unknown): ValidatedReviewInput {
  const result = reviewInputSchema.safeParse(raw)
  if (!result.success) {
    throw new Error(
      `invalid adversarial review input: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }
  return result.data
}

export type ClassifiedHole = Hole & { isNew: boolean }

export type ReviewAction =
  | "continue"
  | "stop-sufficient"
  | "stop-clean" // only low/medium open holes → file clean WITH caveats
  | "stop-no-new-holes"
  | "stop-cap"
  | "stop-unavailable"

/**
 * Scan `output` for the LAST substring that `JSON.parse`s and validates against
 * `adversarialVerdictSchema`. Prefers fenced ```json blocks (scanned from the
 * end); falls back to the last bare `{…}` object, then the whole trimmed string.
 * Returns null when nothing validates.
 */
export function parseAdversarialVerdict(
  output: string,
): AdversarialVerdict | null {
  for (const candidate of jsonCandidates(output)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    const result = adversarialVerdictSchema.safeParse(parsed)
    if (result.success) return result.data
  }
  return null
}

/**
 * Candidate JSON strings, ordered most-preferred-first (last-block-wins): every
 * fenced ```json block from the end, then every bare `{…}` object from the end,
 * then the whole trimmed string.
 */
function jsonCandidates(output: string): string[] {
  const candidates: string[] = []

  // Fenced ```json … ``` blocks, in reverse (last block wins).
  const fenceRe = /```json\s*\n([\s\S]*?)```/gi
  const fences: string[] = []
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
  while ((m = fenceRe.exec(output)) !== null) fences.push(m[1])
  candidates.push(...fences.reverse())

  // Bare top-level `{…}` objects, in reverse.
  candidates.push(...braceObjects(output).reverse())

  // Whole trimmed string as a last resort.
  candidates.push(output.trim())

  return candidates
}

/**
 * Extract balanced top-level `{…}` substrings from `text` (ignores nested
 * braces by tracking depth). Order is left-to-right; the caller reverses.
 *
 * Brace depth does NOT skip string literals, so a `}` inside a JSON string
 * value could close a candidate early — but that mis-sliced candidate then
 * fails `JSON.parse` in `parseAdversarialVerdict` and is skipped, and the
 * preferred fenced-block path wins anyway. This fallback is the safety net, not
 * the primary parse, so the simplification is safe.
 */
function braceObjects(text: string): string[] {
  const objects: string[] = []
  let depth = 0
  let start = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "{") {
      if (depth === 0) start = i
      depth++
    } else if (ch === "}") {
      if (depth > 0) {
        depth--
        if (depth === 0 && start >= 0) {
          objects.push(text.slice(start, i + 1))
          start = -1
        }
      }
    }
  }
  return objects
}

/** Lowercase, collapse whitespace, strip punctuation — for repeat detection. */
export function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "") // drop punctuation/symbols
    .replace(/\s+/g, " ")
    .trim()
}

/** True when two holes are "the same hole": same id, OR same normalized claim. */
export function sameHole(a: Hole, b: Hole): boolean {
  if (a.id && b.id && a.id === b.id) return true
  return normalizeClaim(a.claim) === normalizeClaim(b.claim)
}

/**
 * Tag each current hole new-vs-repeat against the holes raised in all prior
 * rounds. Round 1 has empty `priorRounds` → all new. A current hole is a repeat
 * (`isNew:false`) when it `sameHole`s ANY hole from ANY prior round.
 */
export function classifyHoles(
  current: Hole[],
  priorRounds: ReviewRound[],
): ClassifiedHole[] {
  const priorHoles = priorRounds.flatMap((r) => r.holes)
  return current.map((h) => ({
    ...h,
    isNew: !priorHoles.some((p) => sameHole(h, p)),
  }))
}

export type ResolutionValidation = { ok: true } | { ok: false; reason: string }

/**
 * Round-≥2 contract enforcement. The reviewer MUST accept/reject every prior
 * open hole (the holes carried into this round == the holes in the latest prior
 * round, since `collectOpenHoles` carries the full open set forward each
 * round). Round 1 is exempt. A missing or duplicated verdict is a
 * reviewer-compliance failure the caller maps to `stop-unavailable` — it must
 * NOT silently clear a prior hole. Unknown ids (no matching prior hole) are
 * tolerated: they can't satisfy a needed judgment and `collectOpenHoles` drops
 * them.
 */
export function validateResolutionVerdicts(
  verdict: AdversarialVerdict,
  priorRounds: ReviewRound[],
  round: number,
): ResolutionValidation {
  if (round < 2 || priorRounds.length === 0) return { ok: true }
  const ids = verdict.resolutions.map((r) => r.id)
  const dup = ids.find((id, i) => ids.indexOf(id) !== i)
  if (dup !== undefined)
    return {
      ok: false,
      reason: `duplicate resolution verdict for hole '${dup}'`,
    }
  const judged = new Set(ids)
  const latest = priorRounds[priorRounds.length - 1]
  const missing = latest.holes.map((h) => h.id).filter((id) => !judged.has(id))
  if (missing.length > 0)
    return {
      ok: false,
      reason: `round ${round} reviewer did not judge prior holes: ${missing.join(", ")}`,
    }
  return { ok: true }
}

/**
 * The still-open holes after a round: the holes raised this round (classified
 * new-vs-repeat as a backstop) PLUS any prior hole whose resolution the
 * reviewer explicitly REJECTED (`accepted: false`), pulled from priorRounds
 * with its ORIGINAL severity. Deduped so a rejected prior that is also re-raised
 * in `holes` appears once. Accepted prior holes are dropped. Because the
 * entrypoint runs `validateResolutionVerdicts` first for round ≥ 2, every prior
 * hole is guaranteed to carry an explicit accept/reject here — so `resolutions`
 * is authoritative and no prior hole clears without an explicit accept.
 *
 * Accept + re-raise contradiction: if a reviewer both accepts a prior hole in
 * `resolutions` and re-lists it in `holes`, the re-raise wins (it appears as a
 * repeat). Conservative (keeps the hole) and rare given the schema forces a
 * genuine open concern for a `"holes"` verdict.
 */
export function collectOpenHoles(
  verdict: AdversarialVerdict,
  priorRounds: ReviewRound[],
): ClassifiedHole[] {
  const raised = classifyHoles(verdict.holes, priorRounds)
  const priorById = new Map(
    priorRounds.flatMap((r) => r.holes).map((h) => [h.id, h]),
  )
  const carried = verdict.resolutions
    .filter((r) => !r.accepted)
    .map((r) => priorById.get(r.id))
    .filter((h): h is Hole => h !== undefined)
    .filter((ph) => !raised.some((h) => sameHole(h, ph)))
    .map((ph) => ({ ...ph, isNew: false }))
  return [...raised, ...carried]
}

/** Split open holes into blocking (high) vs caveat (low/medium). */
export function splitHolesBySeverity(open: ClassifiedHole[]): {
  blocking: ClassifiedHole[] // severity === "high" — blocks a clean filing
  caveats: ClassifiedHole[] // low/medium — recorded as caveats
} {
  return {
    blocking: open.filter((h) => h.severity === "high"),
    caveats: open.filter((h) => h.severity !== "high"),
  }
}

/**
 * Deterministic stop/continue decision. Order matters (precedence):
 *   !available || no verdict → stop-unavailable
 *   verdict==="sufficient" → stop-sufficient
 *   no blocking (high) open hole → stop-clean (file clean WITH caveats)
 *   no NEW blocking hole (and prior holes existed) → stop-no-new-holes
 *   round >= cap → stop-cap
 *   else → continue
 *
 * `hasNewBlocking` keys on the blocking (high) set: `continue` is only
 * warranted when there is a new *high* hole to chase; a high hole that's a pure
 * repeat (author already tried and failed) with nothing new is
 * `stop-no-new-holes`.
 */
export function decideReviewAction(args: {
  available: boolean
  verdict: AdversarialVerdict | null
  openHoles: ClassifiedHole[]
  round: number // 1-based
  cap: number
  hadPriorHoles: boolean
}): ReviewAction {
  const { available, verdict, openHoles, round, cap, hadPriorHoles } = args
  if (!available || !verdict) return "stop-unavailable"
  if (verdict.verdict === "sufficient") return "stop-sufficient"
  const { blocking } = splitHolesBySeverity(openHoles)
  if (blocking.length === 0) return "stop-clean" // only low/med open → file WITH caveats
  const hasNewBlocking = blocking.some((h) => h.isNew)
  if (!hasNewBlocking && hadPriorHoles) return "stop-no-new-holes"
  if (round >= cap) return "stop-cap"
  return "continue"
}
