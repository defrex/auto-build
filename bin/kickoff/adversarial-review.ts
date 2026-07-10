/**
 * ENTRYPOINT: run ONE adversarial-review round over a candidate ticket's brief.
 *
 *   bun run bin/kickoff/adversarial-review.ts --input <path-to-json>
 *
 * The skill (triage-sentry) calls this once per round: it writes a JSON input
 * (`{ shortId, round, cap, brief, evidence, priorRounds }`), runs this script,
 * and reads the JSON result to decide whether to continue / file / quarantine.
 *
 * Read-only is a STRUCTURAL boundary, not a prompt instruction: Codex runs with
 * `cwd` = a throwaway git worktree checked out at HEAD (created with
 * `git worktree add --detach`, torn down in a `finally`), so any write it makes
 * lands in the disposable copy and is deleted — the live kickoff worktree is
 * never the spawn cwd. As a detection layer we also run `git status --porcelain`
 * inside the throwaway and surface whatever Codex touched in `wroteFiles`.
 *
 * Fail-soft like `slug-llm.ts`: a failed isolation, a missing/erroring codex
 * CLI, a non-zero exit, or an unparseable verdict all resolve to
 * `status:"unavailable"` (+ `action:"stop-unavailable"`) — never a thrown error
 * into the loop and never a false "sufficient".
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { reviewerArgs, runHarness } from "../build/harness"
import {
  detectRepoRoot,
  forceRemoveWorktreeDir,
  removeWorktree,
  type ShResult,
  sh,
} from "../build/repo"
import { buildReviewPrompt } from "./adversarial-review-prompt"
import {
  type ClassifiedHole,
  collectOpenHoles,
  decideReviewAction,
  parseAdversarialVerdict,
  parseReviewInput,
  type ResolutionVerdict,
  type ReviewAction,
  splitHolesBySeverity,
  type ValidatedReviewInput,
  validateResolutionVerdicts,
} from "./adversarial-review-verdict"

/** Codex's `-o` final-message file, written inside the throwaway worktree. */
const OUTPUT_FILE_NAME = ".adv-review-last-message.txt"

export type ReviewInput = ValidatedReviewInput

export type ReviewResult = {
  status: "ok" | "unavailable"
  /** Populated when unavailable (exit code / parse / spawn / isolation error). */
  reason?: string
  round: number
  verdict?: "sufficient" | "holes"
  confidence?: "low" | "medium" | "high"
  summary?: string
  holes: ClassifiedHole[] // [] when sufficient/unavailable
  blockingHoles: ClassifiedHole[] // severity high — block a clean filing
  caveatHoles: ClassifiedHole[] // low/medium — recorded as caveats
  resolutions: ResolutionVerdict[] // reviewer accept/reject on prior holes (round ≥ 2)
  action: ReviewAction
  rawReview: string // codex's full final message — for the trail
  wroteFiles: string[] // files Codex touched in the throwaway (should be [])
}

export type ReviewDeps = {
  runHarnessFn?: typeof runHarness
  exec?: (cmd: string[], cwd: string) => ShResult
}

/**
 * Spawn- and git-injectable for tests (mirrors the orchestrator's `runHarnessFn`
 * and repo.ts's injectable `exec`).
 */
export async function runAdversarialReview(
  input: ReviewInput,
  repoRoot: string,
  deps: ReviewDeps = {},
): Promise<ReviewResult> {
  const runHarnessFn = deps.runHarnessFn ?? runHarness
  const exec = deps.exec ?? sh
  const logPath = join(
    repoRoot,
    "build",
    "kickoff",
    ".kickoff",
    "adversarial-review.log",
  )

  const unavailable = (
    reason: string,
    extra: Partial<ReviewResult> = {},
  ): ReviewResult => ({
    status: "unavailable",
    reason,
    round: input.round,
    holes: [],
    blockingHoles: [],
    caveatHoles: [],
    resolutions: [],
    action: "stop-unavailable",
    rawReview: "",
    wroteFiles: [],
    ...extra,
  })

  // Create the disposable worktree at HEAD. The temp parent dir is real; the
  // worktree itself is whatever `git worktree add` materializes.
  const tmpParent = mkdtempSync(join(tmpdir(), "adv-review-"))
  const wt = join(tmpParent, "wt")
  const head =
    exec(["git", "rev-parse", "HEAD"], repoRoot).stdout.trim() || "HEAD"
  const add = exec(["git", "worktree", "add", "--detach", wt, head], repoRoot)
  if (add.code !== 0) {
    // Nothing was created — skip teardown, just drop the temp parent.
    rmSyncSafe(tmpParent)
    console.warn(
      `[adversarial-review] could not isolate review worktree: ${add.stderr.trim()}`,
    )
    return unavailable(
      `could not isolate review worktree: ${add.stderr.trim() || `git exit ${add.code}`}`,
    )
  }

  try {
    const prompt = buildReviewPrompt(input)
    const outputFile = join(wt, OUTPUT_FILE_NAME)
    const argv = reviewerArgs({ bin: "codex" }, prompt, { outputFile })

    let run: { code: number | null; output: string }
    try {
      run = await runHarnessFn({ bin: "codex", argv, cwd: wt, logPath })
    } catch (err) {
      console.warn(
        `[adversarial-review] codex CLI unavailable: ${(err as Error).message}`,
      )
      return unavailable(`codex CLI unavailable: ${(err as Error).message}`)
    }

    // Detection layer: surface anything Codex touched (expected empty). The
    // `-o` output file lives inside the throwaway, so porcelain always reports
    // it — filter it out so `wroteFiles` reflects only Codex's own writes.
    const wroteFiles = parsePorcelain(
      exec(["git", "status", "--porcelain"], wt).stdout,
    ).filter((p) => p !== OUTPUT_FILE_NAME)

    if (run.code !== 0) {
      console.warn(`[adversarial-review] codex exited ${run.code}`)
      return unavailable(`codex exited ${run.code}`, { wroteFiles })
    }

    const raw = existsSync(outputFile)
      ? readFileSync(outputFile, "utf-8")
      : run.output

    const verdict = parseAdversarialVerdict(raw)
    if (!verdict) {
      console.warn("[adversarial-review] unparseable codex verdict")
      return unavailable("unparseable codex verdict", {
        rawReview: raw,
        wroteFiles,
      })
    }

    // Round-≥2 contract: the reviewer must accept/reject every prior open hole.
    // A missing/duplicate verdict is a reviewer-compliance failure — fail soft
    // to `stop-unavailable` rather than silently clearing a prior hole.
    const check = validateResolutionVerdicts(
      verdict,
      input.priorRounds,
      input.round,
    )
    if (!check.ok) {
      console.warn(`[adversarial-review] ${check.reason}`)
      return unavailable(check.reason, {
        rawReview: raw,
        wroteFiles,
        verdict: verdict.verdict,
        confidence: verdict.confidence,
        summary: verdict.summary,
        // Preserve the partial accept/reject judgments the reviewer DID emit so
        // the `## Adversarial review` trail shows them when a human weighs in.
        resolutions: verdict.resolutions,
      })
    }

    const openHoles = collectOpenHoles(verdict, input.priorRounds)
    const { blocking, caveats } = splitHolesBySeverity(openHoles)
    const action = decideReviewAction({
      available: true,
      verdict,
      openHoles,
      round: input.round,
      cap: input.cap,
      hadPriorHoles: input.priorRounds.some((r) => r.holes.length > 0),
    })

    return {
      status: "ok",
      round: input.round,
      verdict: verdict.verdict,
      confidence: verdict.confidence,
      summary: verdict.summary,
      holes: openHoles,
      blockingHoles: blocking,
      caveatHoles: caveats,
      resolutions: verdict.resolutions,
      action,
      rawReview: raw,
      wroteFiles,
    }
  } finally {
    // Best-effort teardown — never throw into the loop. git refuses to remove a
    // worktree from inside it, so we drive removal from repoRoot (the main tree).
    try {
      const removed = removeWorktree(repoRoot, wt, exec)
      if (removed.code !== 0) forceRemoveWorktreeDir(repoRoot, wt, exec)
    } catch (err) {
      console.warn(
        `[adversarial-review] worktree teardown failed: ${(err as Error).message}`,
      )
    }
    rmSyncSafe(tmpParent)
  }
}

/** Parse `git status --porcelain` into the list of touched paths. */
export function parsePorcelain(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      // Porcelain v1: "XY <path>" (or "XY <old> -> <new>" for renames).
      const rest = line.replace(/^.{1,2}\s+/, "")
      const arrow = rest.split(" -> ")
      return (arrow[1] ?? arrow[0]).trim()
    })
}

function rmSyncSafe(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // best-effort
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const inputIdx = args.indexOf("--input")
  const inputPath = inputIdx >= 0 ? args[inputIdx + 1] : undefined
  const rawInput = inputPath
    ? readFileSync(inputPath, "utf-8")
    : readFileSync(0, "utf-8") // stdin fallback
  // Validate the input contract. THROWS on malformed input (e.g. the July-6
  // `priorRounds[].resolutions[].hole` set to an id string instead of a full
  // hole object) — let it propagate so the process exits non-zero with a clear
  // message on stderr and NO stdout ReviewResult JSON. The skill treats that as
  // a caller bug to fix and re-run, distinct from a `stop-unavailable` result.
  const input = parseReviewInput(JSON.parse(rawInput))

  const repoRoot = detectRepoRoot()
  // Ensure the log dir exists (runHarness also mkdirs, but isolation may fail first).
  mkdirSync(join(repoRoot, "build", "kickoff", ".kickoff"), { recursive: true })
  const result = await runAdversarialReview(input, repoRoot)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.main) {
  await main()
}
