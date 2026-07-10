/**
 * Cheap-LLM slug generation for kickoff branches.
 *
 * Given a Linear ticket's title + description, asks a cheap model
 * (`google/gemini-3.1-flash-lite`, via the Vercel AI Gateway — see
 * `AI_GATEWAY_API_KEY` in `.env`) for a 1–3 word slug that names the core change,
 * then normalizes it through {@link slugify}. On ANY failure (gateway down,
 * timeout, empty/garbage output) it falls back to the deterministic
 * `slugify(title)` so the kickoff loop never breaks — same fail-soft philosophy
 * as `bin/permission-hook.ts`.
 */

import { generateObject } from "ai"
import z from "zod"
import { slugify } from "./branch"

/** Cheapest gateway model in use (also the summarizer in the web app). */
const MODEL = "google/gemini-3.1-flash-lite"
/** Keep the prompt cheap — the first paragraph or two carry the intent. */
const BRIEF_MAX_CHARS = 1200

const SYSTEM_PROMPT = `
You name git branches for engineering tickets. Given a ticket title and
description, output a slug of ONE to THREE words that captures the core change.

Rules:
- lowercase, hyphen-separated, letters and digits only
- prefer the salient noun/verb of the work; drop filler ("the", "a", "add",
  "fix", "update") unless a word is essential to disambiguate
- at most three words

Examples:
- "Add a snooze button to todos" -> todo-snooze
- "Make getOrgTimeZone tolerate duplicate organizationSettings rows" -> org-timezone-dedupe
- "De-noise transient Convex-edge 5xx in calendar webhooks" -> calendar-webhook-5xx
`.trim()

export type SlugInput = { title: string; brief: string }

/** Calls the model and returns its raw (un-normalized) slug suggestion. */
export type SlugCompletion = (input: SlugInput) => Promise<string>

const llmComplete: SlugCompletion = async ({ title, brief }) => {
  const result = await generateObject({
    model: MODEL,
    schema: z.object({
      slug: z.string().describe("1-3 word, lowercase, hyphen-separated slug"),
    }),
    system: SYSTEM_PROMPT,
    prompt: `Title: ${title}\n\nDescription:\n${brief.slice(0, BRIEF_MAX_CHARS)}`,
  })
  return result.object.slug
}

/**
 * Slug generation telemetry — the slug plus how it was derived. Surfaced to
 * analytics (`kickoff_slug_derived`) without breaking the bare-string callers.
 */
export type SlugResult = {
  slug: string
  /** True when the deterministic `slugify(title)` fallback was used. */
  usedFallback: boolean
  /** The model id consulted (constant). */
  model: string
  /** Wall-clock of the `complete` call, in ms. */
  durationMs: number
}

/**
 * Produce the base slug (before any collision suffix) for a ticket, with
 * telemetry. `complete` is injectable so the normalize/fallback logic is
 * unit-testable without a network call; production passes the default
 * {@link llmComplete}. On ANY failure (gateway down, garbage output) it falls
 * back to `slugify(title)` and sets `usedFallback: true`.
 */
export async function generateSlugDetailed(
  input: SlugInput,
  complete: SlugCompletion = llmComplete,
): Promise<SlugResult> {
  const fallback = slugify(input.title)
  const startedAt = Date.now()
  try {
    const normalized = slugify(await complete(input))
    const durationMs = Date.now() - startedAt
    // `slugify` returns the "task" sentinel for empty/garbage/reserved output —
    // a real title-derived slug beats it.
    if (normalized === "task") {
      console.warn(
        `[kickoff] slug model returned unusable output for "${input.title}"; using slugify(title)`,
      )
      return { slug: fallback, usedFallback: true, model: MODEL, durationMs }
    }
    return { slug: normalized, usedFallback: false, model: MODEL, durationMs }
  } catch (err) {
    // Fail soft — never block the kickoff loop on a flaky/misconfigured gateway —
    // but log so a PERMANENTLY broken gateway (bad key, invalid model id) is
    // visible instead of silently degrading every slug to slugify(title).
    console.warn(
      `[kickoff] slug model call failed; using slugify(title): ${(err as Error).message}`,
    )
    return {
      slug: fallback,
      usedFallback: true,
      model: MODEL,
      durationMs: Date.now() - startedAt,
    }
  }
}

/** Thin back-compat wrapper returning the bare slug string. */
export async function generateSlug(
  input: SlugInput,
  complete: SlugCompletion = llmComplete,
): Promise<string> {
  return (await generateSlugDetailed(input, complete)).slug
}
