/**
 * Integration coverage for `defaultEnsureDeps` — the production wiring that
 * spawns the ensure-ticket agent and reads its result file back. The spawn
 * layer (`runHarness`) is stubbed via constructor DI, so no subprocess runs;
 * the fake writes the fixture to the `resultPath` the deps computed, pinning
 * the mkdir → stale-clear → read-back round-trip.
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
import type { RunHarnessArgs, RunResult } from "./harness"
import { type Ctx, defaultEnsureDeps } from "./orchestrator"

/** A complete `Ctx` rooted at `tmp` — throwaway values for the fields the
 * ensure step doesn't read (it reads repoRoot, logPath, now). */
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
  }
}

/** Build a `typeof runHarness` fake: records its args, optionally writes a
 * fixture to a path, returns a caller-supplied result. */
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

describe("defaultEnsureDeps.runEnsureAgent", () => {
  let tmp: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ensure-deps-"))
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test("happy round-trip: creates dir, forwards cwd/logPath/prompt, reads result back", async () => {
    const ctx = makeCtx(tmp)
    // dirname does NOT exist yet — the fake's write only succeeds if mkdir ran.
    const resultPath = join(tmp, ".build", "ensure-ticket-result.json")
    const fixture = '{"issueId":"DIS-1","issueUuid":"u-1"}'
    const { fn, calls } = makeFakeHarness({
      onCall: (args) => {
        expect(args.cwd).toBe(ctx.repoRoot)
        expect(args.logPath).toBe(ctx.logPath)
        expect(args.bin).toBe("claude")
        // builderArgs passes the prompt as the last positional arg.
        expect(args.argv.at(-1)).toBe("p")
      },
      write: { path: resultPath, contents: fixture },
      result: { code: 0, output: "" },
    })

    const deps = defaultEnsureDeps(ctx, fn)
    const out = await deps.runEnsureAgent({ prompt: "p", resultPath })

    expect(calls).toHaveLength(1)
    expect(out).toEqual({ code: 0, resultRaw: fixture })
  })

  test("stale-clear: removes a pre-existing result before the agent runs", async () => {
    const ctx = makeCtx(tmp)
    const resultPath = join(tmp, ".build", "ensure-ticket-result.json")
    // Seed a stale result so there is something for rmSync to clear.
    mkdirSync(join(tmp, ".build"), { recursive: true })
    writeFileSync(resultPath, '{"issueId":"OLD","issueUuid":"old"}')

    const { fn } = makeFakeHarness({
      // Pins rmSync: if production dropped it, the stale file would still exist
      // at the moment the agent (this fake) runs.
      onCall: () => {
        expect(existsSync(resultPath)).toBe(false)
      },
      result: { code: 0, output: "" },
    })

    const deps = defaultEnsureDeps(ctx, fn)
    const out = await deps.runEnsureAgent({ prompt: "p", resultPath })

    // The fake wrote nothing, so read-back finds no file.
    expect(out).toEqual({ code: 0, resultRaw: null })
  })

  test("non-zero exit is forwarded; missing result reads back as null", async () => {
    const ctx = makeCtx(tmp)
    const resultPath = join(tmp, ".build", "ensure-ticket-result.json")
    const { fn } = makeFakeHarness({ result: { code: 7, output: "" } })

    const deps = defaultEnsureDeps(ctx, fn)
    const out = await deps.runEnsureAgent({ prompt: "p", resultPath })

    expect(out).toEqual({ code: 7, resultRaw: null })
  })

  test("null exit code is coerced to 1", async () => {
    const ctx = makeCtx(tmp)
    const resultPath = join(tmp, ".build", "ensure-ticket-result.json")
    const { fn } = makeFakeHarness({ result: { code: null, output: "" } })

    const deps = defaultEnsureDeps(ctx, fn)
    const out = await deps.runEnsureAgent({ prompt: "p", resultPath })

    expect(out).toEqual({ code: 1, resultRaw: null })
  })
})
