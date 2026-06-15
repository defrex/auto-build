/**
 * Integration coverage for `defaultDeps().runSelect` — the production wiring
 * that spawns the select+claim agent and reads its result file back. The spawn
 * layer (`runHarness`) is stubbed via constructor DI, so no subprocess runs.
 *
 * `runSelect` computes the result/log paths internally, so the test recomputes
 * the expected paths and pins them: if the writer's and reader's paths ever
 * drift apart, the read-back hits a missing file and the test fails.
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
import { dirname, join } from "node:path"
import type { RunHarnessArgs, RunResult } from "../build/harness"
import { type KickoffConfig, resolveConfig } from "./config"
import { defaultDeps } from "./kickoff"

const LINEAR = {
  teamId: "t",
  projectId: "p",
  triageStateId: "s_t",
  readyStateId: "s_r",
  inProgressStateId: "s_p",
  doneStateId: "s_d",
  rejectedStateIds: [],
  sourceObservationsLabelId: "l_o",
  sourceSentryLabelId: "l_s",
  needsDefinitionLabelId: "l_nd",
}

/** Pin the git provider so construction doesn't depend on a clean env — a
 * `superset` value would make `makeWorktreeProvider` throw at build time. */
const config: KickoffConfig = resolveConfig({
  linear: LINEAR,
  maxConcurrentBuilds: 1,
  worktree: { provider: "git" },
})

/** Build a `typeof runHarness` fake: records its args, optionally writes a
 * fixture, returns a caller-supplied result. */
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

const VALID_RESULT = JSON.stringify({
  inProgressCount: 0,
  issueId: "DIS-1",
  issueUuid: "u-1",
  title: "t",
  brief: "b",
  source: "observations",
})

describe("defaultDeps.runSelect", () => {
  let repoRoot: string
  let expected: string
  let logPath: string
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "kickoff-deps-"))
    expected = join(
      repoRoot,
      "build",
      "kickoff",
      ".kickoff",
      "select-result.json",
    )
    logPath = join(repoRoot, "build", "kickoff", ".kickoff", "select.log")
  })
  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true })
  })

  test("happy round-trip: creates dir, forwards cwd/logPath, parses result back", async () => {
    const { fn, calls } = makeFakeHarness({
      onCall: (args) => {
        expect(args.cwd).toBe(repoRoot)
        expect(args.logPath).toBe(logPath)
        expect(args.bin).toBe("claude")
      },
      write: { path: expected, contents: VALID_RESULT },
      result: { code: 0, output: "" },
    })

    const result = await defaultDeps(repoRoot, config, fn).runSelect({
      repoRoot,
      config,
    })

    expect(calls).toHaveLength(1)
    expect(result).toEqual({
      inProgressCount: 0,
      issueId: "DIS-1",
      issueUuid: "u-1",
      title: "t",
      brief: "b",
      source: "observations",
    })
  })

  test("stale-clear: pre-existing valid result is removed before the agent runs", async () => {
    // A FULLY valid stale result: if rmSync were dropped, read-back would parse
    // this successfully and return the wrong issue. The `existsSync` check in
    // `onCall` is the primary pin (it fires the moment stale-clear breaks); the
    // "wrote no result" rejection below is the downstream consequence when the
    // fake then writes nothing.
    const { fn } = makeFakeHarness({
      onCall: () => {
        expect(existsSync(expected)).toBe(false)
      },
      result: { code: 0, output: "" },
    })
    // Seed a stale, fully-valid result before the run.
    mkdirSync(dirname(expected), { recursive: true })
    writeFileSync(expected, VALID_RESULT)

    await expect(
      defaultDeps(repoRoot, config, fn).runSelect({ repoRoot, config }),
    ).rejects.toThrow("exited 0 but wrote no result")
  })

  test("non-zero exit throws (failure, not empty queue)", async () => {
    const { fn } = makeFakeHarness({ result: { code: 4, output: "" } })
    await expect(
      defaultDeps(repoRoot, config, fn).runSelect({ repoRoot, config }),
    ).rejects.toThrow("select agent exited 4")
  })

  test("malformed JSON throws", async () => {
    const { fn } = makeFakeHarness({
      write: { path: expected, contents: "{not json" },
      result: { code: 0, output: "" },
    })
    await expect(
      defaultDeps(repoRoot, config, fn).runSelect({ repoRoot, config }),
    ).rejects.toThrow("malformed JSON")
  })
})
