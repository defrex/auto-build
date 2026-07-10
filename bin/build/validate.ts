/**
 * The deterministic validation gate (phase 5).
 *
 * Run by the script, not an agent, so it can't be faked or hand-waved:
 * `bun run typecheck`, `bun run lint`, `bun run test`, and an optional e2e step.
 * Any failure routes back to the builder with the captured failure output.
 *
 * See `build/build-flow/design.html` → "Gate: deterministic validation".
 */

import { spawn } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { boundedConcat, safeAppend, safeStreamWrite } from "./safe-output"

export type CheckResult = { name: string; ok: boolean; output: string }

export type ValidateResult = {
  pass: boolean
  results: CheckResult[]
  /** Markdown digest of every failed check, for the builder's next attempt. */
  failureText: string
}

/** The deterministic checks, in order, run from the repo root. */
export const VALIDATE_CHECKS: { name: string; cmd: string[] }[] = [
  { name: "typecheck", cmd: ["bun", "run", "typecheck"] },
  { name: "lint", cmd: ["bun", "run", "lint"] },
  { name: "test", cmd: ["bun", "run", "test"] },
]

/** Path the validate phase writes failure output to for the build loop to read. */
export function validateFailuresPath(buildDir: string): string {
  return join(buildDir, "validate-failures.md")
}

/** Aggregate check results into a pass/fail verdict + a failure digest. (pure) */
export function summarizeValidation(results: CheckResult[]): ValidateResult {
  const failed = results.filter((r) => !r.ok)
  const failureText = failed
    .map((r) => `## ${r.name} failed\n\n\`\`\`\n${r.output.trim()}\n\`\`\``)
    .join("\n\n")
  return { pass: failed.length === 0, results, failureText }
}

export type RunCommand = (
  cmd: string[],
  cwd: string,
) => Promise<{ code: number | null; output: string }>

function defaultRunCommand(logPath: string): RunCommand {
  return (cmd, cwd) =>
    new Promise((resolve, reject) => {
      mkdirSync(dirname(logPath), { recursive: true })
      appendFileSync(logPath, `\n$ ${cmd.join(" ")}\n`)
      const child = spawn(cmd[0], cmd.slice(1), {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let output = ""
      const onData = (chunk: Buffer) => {
        const text = chunk.toString()
        // Same crash-proofing as the harness sink: the pipe echo and log append
        // must never escape, and the in-memory copy is tail-bounded (validate
        // output feeds only pass/fail + a failure digest).
        safeStreamWrite(process.stdout, text)
        safeAppend(logPath, text)
        output = boundedConcat(output, text)
      }
      child.stdout.on("data", onData)
      child.stderr.on("data", onData)
      child.on("error", reject)
      child.on("close", (code) => resolve({ code, output }))
    })
}

export type RunValidateArgs = {
  repoRoot: string
  logPath: string
  runCommand?: RunCommand
  /** Optional e2e step (dev-server-guarded browser run); skipped if omitted. */
  e2e?: () => Promise<CheckResult>
  /** Optional evals step (Convex-dev + model-API-key guarded eval run); skipped if omitted. */
  evals?: () => Promise<CheckResult>
}

/**
 * Run the deterministic checks in order (short-circuiting on the first failure
 * to fail fast), then the optional e2e step, and return the aggregate verdict.
 */
export async function runValidate({
  repoRoot,
  logPath,
  runCommand,
  e2e,
  evals,
}: RunValidateArgs): Promise<ValidateResult> {
  const run = runCommand ?? defaultRunCommand(logPath)
  const results: CheckResult[] = []

  for (const check of VALIDATE_CHECKS) {
    const { code, output } = await run(check.cmd, repoRoot)
    results.push({ name: check.name, ok: code === 0, output })
    if (code !== 0) return summarizeValidation(results) // fail fast
  }

  if (e2e) results.push(await e2e())
  // Evals runs AFTER e2e (both quality gates; both only reached once
  // typecheck/lint/test pass via the fail-fast above).
  if (evals) results.push(await evals())

  return summarizeValidation(results)
}
