/**
 * Integration coverage for `defaultStatusDeps` — the production wiring that
 * spawns the In-Review move agent and reads its result file back. The spawn
 * layer (`runHarness`) is stubbed via DI, so no subprocess runs; the fake writes
 * the fixture to the `resultPath` the deps computed, pinning the
 * mkdir → stale-clear → read-back round-trip (mirrors orchestrator-ensure-deps).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { noopAnalytics } from "../analytics/pipeline-analytics"
import type { RunHarnessArgs, RunResult } from "./harness"
import { type Ctx, defaultStatusDeps } from "./orchestrator"

function makeCtx(tmp: string): Ctx {
  return {
    repoRoot: tmp,
    feature: "feat",
    buildDir: join(tmp, "build", "feat"),
    specPath: join(tmp, "build", "feat", "spec.md"),
    logPath: join(tmp, "build.log"),
    baseBranch: "main",
    env: process.env,
    now: () => "t",
    analytics: noopAnalytics(),
  }
}

function makeFakeHarness(opts: {
  onCall?: (args: RunHarnessArgs) => void
  write?: { path: string; contents: string }
  result: RunResult
}): {
  fn: (args: RunHarnessArgs) => Promise<RunResult>
  calls: RunHarnessArgs[]
} {
  const calls: RunHarnessArgs[] = []
  const fn = async (args: RunHarnessArgs): Promise<RunResult> => {
    calls.push(args)
    opts.onCall?.(args)
    if (opts.write) writeFileSync(opts.write.path, opts.write.contents)
    return opts.result
  }
  return { fn, calls }
}

describe("defaultStatusDeps.runStatusAgent", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "status-deps-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test("happy round-trip: creates dir, forwards cwd/logPath/prompt, reads result back", async () => {
    const ctx = makeCtx(tmp)
    const resultPath = join(tmp, ".build", "in-review-result.json")
    const fixture = '{"moved":true}'
    const { fn, calls } = makeFakeHarness({
      onCall: (args) => {
        expect(args.cwd).toBe(ctx.repoRoot)
        expect(args.logPath).toBe(ctx.logPath)
        expect(args.bin).toBe("claude")
        expect(args.argv.at(-1)).toBe("p")
      },
      write: { path: resultPath, contents: fixture },
      result: { code: 0, output: "" },
    })

    const deps = defaultStatusDeps(ctx, fn)
    const out = await deps.runStatusAgent({ prompt: "p", resultPath })

    expect(calls).toHaveLength(1)
    expect(out).toEqual({ code: 0, resultRaw: fixture })
  })

  test("stale-clear: removes a pre-existing result before the agent runs", async () => {
    const ctx = makeCtx(tmp)
    const resultPath = join(tmp, ".build", "in-review-result.json")
    mkdirSync(join(tmp, ".build"), { recursive: true })
    writeFileSync(resultPath, '{"moved":false}')

    const { fn } = makeFakeHarness({
      onCall: () => {
        expect(existsSync(resultPath)).toBe(false)
      },
      result: { code: 0, output: "" },
    })

    const deps = defaultStatusDeps(ctx, fn)
    const out = await deps.runStatusAgent({ prompt: "p", resultPath })

    expect(out).toEqual({ code: 0, resultRaw: null })
  })

  test("non-zero exit is forwarded; missing result reads back as null", async () => {
    const ctx = makeCtx(tmp)
    const resultPath = join(tmp, ".build", "in-review-result.json")
    const { fn } = makeFakeHarness({ result: { code: 7, output: "" } })

    const deps = defaultStatusDeps(ctx, fn)
    const out = await deps.runStatusAgent({ prompt: "p", resultPath })

    expect(out).toEqual({ code: 7, resultRaw: null })
  })

  test("null exit code is coerced to 1", async () => {
    const ctx = makeCtx(tmp)
    const resultPath = join(tmp, ".build", "in-review-result.json")
    const { fn } = makeFakeHarness({ result: { code: null, output: "" } })

    const deps = defaultStatusDeps(ctx, fn)
    const out = await deps.runStatusAgent({ prompt: "p", resultPath })

    expect(out).toEqual({ code: 1, resultRaw: null })
  })
})
