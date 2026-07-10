import { describe, expect, test } from "bun:test"
import type { RunResult } from "../build/harness"
import type { ShResult } from "../build/repo"
import { runAdversarialReview } from "./adversarial-review"
import type { ReviewRound } from "./adversarial-review-verdict"

const REPO = "/repo"

function verdictJson(over: Record<string, unknown> = {}): string {
  const v = {
    verdict: "holes",
    holes: [
      {
        id: "h1",
        claim: "the mechanism is unproven",
        weakness: "no event cited",
        resolution: "cite an event",
        severity: "high",
      },
    ],
    confidence: "medium",
    summary: "one hole",
    ...over,
  }
  return `prose\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``
}

/**
 * Build an injectable git `exec` fake plus a call log shared with the harness
 * fake so ordering (add → spawn → remove) can be asserted.
 */
function makeExec(opts: {
  log: string[]
  addCode?: number
  porcelain?: string
}): (cmd: string[], cwd: string) => ShResult {
  return (cmd) => {
    const joined = cmd.join(" ")
    if (cmd.includes("rev-parse")) {
      return { code: 0, stdout: "abc123\n", stderr: "" }
    }
    if (cmd.includes("worktree") && cmd.includes("add")) {
      opts.log.push("worktree-add")
      return {
        code: opts.addCode ?? 0,
        stdout: "",
        stderr: opts.addCode ? "add failed" : "",
      }
    }
    if (cmd.includes("status") && cmd.includes("--porcelain")) {
      return { code: 0, stdout: opts.porcelain ?? "", stderr: "" }
    }
    if (cmd.includes("worktree") && cmd.includes("remove")) {
      opts.log.push("worktree-remove")
      return { code: 0, stdout: "", stderr: "" }
    }
    if (cmd.includes("prune") || cmd[0] === "rm") {
      return { code: 0, stdout: "", stderr: "" }
    }
    throw new Error(`unexpected exec: ${joined}`)
  }
}

function makeHarness(
  log: string[],
  result: RunResult | (() => never),
): (args: { argv: string[]; cwd: string }) => Promise<RunResult> {
  return async ({ cwd }) => {
    log.push(`spawn:${cwd}`)
    if (typeof result === "function") return result()
    return result
  }
}

const baseInput = {
  shortId: "DISPATCH-1",
  brief: "root cause + fix",
  evidence: "evidence block",
  priorRounds: [] as ReviewRound[],
  round: 1,
  cap: 3,
}

describe("runAdversarialReview", () => {
  test("isolation happy path: worktree add before spawn, remove after", async () => {
    const log: string[] = []
    const exec = makeExec({ log })
    const runHarnessFn = makeHarness(log, {
      code: 0,
      output: verdictJson({ verdict: "sufficient", holes: [] }),
    }) as never
    await runAdversarialReview(baseInput, REPO, { runHarnessFn, exec })
    expect(log[0]).toBe("worktree-add")
    expect(log.some((l) => l.startsWith("spawn:"))).toBe(true)
    const addIdx = log.indexOf("worktree-add")
    const spawnIdx = log.findIndex((l) => l.startsWith("spawn:"))
    const removeIdx = log.indexOf("worktree-remove")
    expect(addIdx).toBeLessThan(spawnIdx)
    expect(spawnIdx).toBeLessThan(removeIdx)
  })

  test("ok / sufficient → stop-sufficient, no holes", async () => {
    const log: string[] = []
    const exec = makeExec({ log })
    const runHarnessFn = makeHarness(log, {
      code: 0,
      output: verdictJson({ verdict: "sufficient", holes: [] }),
    }) as never
    const r = await runAdversarialReview(baseInput, REPO, {
      runHarnessFn,
      exec,
    })
    expect(r.status).toBe("ok")
    expect(r.action).toBe("stop-sufficient")
    expect(r.holes).toEqual([])
    expect(r.wroteFiles).toEqual([])
    expect(r.verdict).toBe("sufficient")
  })

  test("ok / holes / round 1 < cap → continue, holes all new", async () => {
    const log: string[] = []
    const exec = makeExec({ log })
    const runHarnessFn = makeHarness(log, {
      code: 0,
      output: verdictJson(),
    }) as never
    const r = await runAdversarialReview(baseInput, REPO, {
      runHarnessFn,
      exec,
    })
    expect(r.status).toBe("ok")
    expect(r.action).toBe("continue")
    expect(r.holes).toHaveLength(1)
    expect(r.holes[0]?.isNew).toBe(true)
    expect(r.rawReview).toContain("the mechanism is unproven")
  })

  test("repeat detection across rounds → stop-no-new-holes", async () => {
    const log: string[] = []
    const exec = makeExec({ log })
    // Under the round-2 contract the verdict must judge the prior hole; reject
    // it so the prior high hole carries and the round yields stop-no-new-holes.
    const runHarnessFn = makeHarness(log, {
      code: 0,
      output: verdictJson({
        resolutions: [{ id: "h1", accepted: false, reason: "still unproven" }],
      }),
    }) as never
    const priorRounds: ReviewRound[] = [
      {
        round: 1,
        holes: [
          {
            id: "h1",
            claim: "the mechanism is unproven",
            weakness: "x",
            resolution: "y",
            severity: "high",
          },
        ],
        resolutions: [],
      },
    ]
    const r = await runAdversarialReview(
      { ...baseInput, round: 2, priorRounds },
      REPO,
      { runHarnessFn, exec },
    )
    expect(r.action).toBe("stop-no-new-holes")
    expect(r.holes[0]?.isNew).toBe(false)
  })

  test("stop-clean: only a medium hole at round 1 → file clean with caveats", async () => {
    const log: string[] = []
    const exec = makeExec({ log })
    const runHarnessFn = makeHarness(log, {
      code: 0,
      output: verdictJson({
        holes: [
          {
            id: "h1",
            claim: "minor completeness gap",
            weakness: "not exhaustive",
            resolution: "note it",
            severity: "medium",
          },
        ],
      }),
    }) as never
    const r = await runAdversarialReview(baseInput, REPO, {
      runHarnessFn,
      exec,
    })
    expect(r.action).toBe("stop-clean")
    expect(r.blockingHoles).toEqual([])
    expect(r.caveatHoles).toHaveLength(1)
    expect(r.holes).toHaveLength(1)
  })

  test("blocking: a high hole at round 1 < cap → continue, blockingHoles populated", async () => {
    const log: string[] = []
    const exec = makeExec({ log })
    const runHarnessFn = makeHarness(log, {
      code: 0,
      output: verdictJson(),
    }) as never
    const r = await runAdversarialReview(baseInput, REPO, {
      runHarnessFn,
      exec,
    })
    expect(r.action).toBe("continue")
    expect(r.blockingHoles).toHaveLength(1)
    expect(r.caveatHoles).toEqual([])
  })

  test("rejected-prior path: round 2 rejecting prior high hole → carries with isNew false", async () => {
    const log: string[] = []
    const exec = makeExec({ log })
    const runHarnessFn = makeHarness(log, {
      code: 0,
      output: verdictJson({
        holes: [],
        resolutions: [{ id: "h1", accepted: false, reason: "still unproven" }],
      }),
    }) as never
    const priorRounds: ReviewRound[] = [
      {
        round: 1,
        holes: [
          {
            id: "h1",
            claim: "the mechanism is unproven",
            weakness: "x",
            resolution: "y",
            severity: "high",
          },
        ],
        resolutions: [],
      },
    ]
    const r = await runAdversarialReview(
      { ...baseInput, round: 2, priorRounds },
      REPO,
      { runHarnessFn, exec },
    )
    expect(r.action).toBe("stop-no-new-holes")
    expect(r.holes.map((h) => h.id)).toContain("h1")
    expect(r.holes[0]?.isNew).toBe(false)
    expect(r.resolutions[0]?.accepted).toBe(false)
  })

  test("round-2 non-compliance: no resolution for a prior hole → stop-unavailable", async () => {
    const log: string[] = []
    const exec = makeExec({ log })
    // Raise a brand-new high hole but leave `resolutions` empty — the reviewer
    // failed to judge the prior hole h1.
    const runHarnessFn = makeHarness(log, {
      code: 0,
      output: verdictJson({
        holes: [
          {
            id: "h9",
            claim: "a new concern",
            weakness: "w",
            resolution: "r",
            severity: "high",
          },
        ],
      }),
    }) as never
    const priorRounds: ReviewRound[] = [
      {
        round: 1,
        holes: [
          {
            id: "h1",
            claim: "the mechanism is unproven",
            weakness: "x",
            resolution: "y",
            severity: "high",
          },
        ],
        resolutions: [],
      },
    ]
    const r = await runAdversarialReview(
      { ...baseInput, round: 2, priorRounds },
      REPO,
      { runHarnessFn, exec },
    )
    expect(r.action).toBe("stop-unavailable")
    expect(r.reason).toMatch(/did not judge/)
  })

  test("worktree add fails → unavailable, spawn never called", async () => {
    const log: string[] = []
    const exec = makeExec({ log, addCode: 1 })
    const runHarnessFn = makeHarness(log, {
      code: 0,
      output: verdictJson(),
    }) as never
    const r = await runAdversarialReview(baseInput, REPO, {
      runHarnessFn,
      exec,
    })
    expect(r.status).toBe("unavailable")
    expect(r.reason).toMatch(/isolate/i)
    expect(r.action).toBe("stop-unavailable")
    expect(log.some((l) => l.startsWith("spawn:"))).toBe(false)
    expect(r.wroteFiles).toEqual([])
  })

  test("wroteFiles surfaced from git status --porcelain", async () => {
    const log: string[] = []
    const exec = makeExec({ log, porcelain: " M src/foo.ts\n?? new.ts\n" })
    const runHarnessFn = makeHarness(log, {
      code: 0,
      output: verdictJson(),
    }) as never
    const r = await runAdversarialReview(baseInput, REPO, {
      runHarnessFn,
      exec,
    })
    expect(r.wroteFiles).toContain("src/foo.ts")
    expect(r.wroteFiles).toContain("new.ts")
    expect(log).toContain("worktree-remove") // teardown still ran
  })

  test("excludes the codex -o output file from wroteFiles (no false positive)", async () => {
    const log: string[] = []
    // The `-o` artifact always shows in porcelain; real writes do not.
    const exec = makeExec({
      log,
      porcelain: "?? .adv-review-last-message.txt\n M src/real.ts\n",
    })
    const runHarnessFn = makeHarness(log, {
      code: 0,
      output: verdictJson({ verdict: "sufficient", holes: [] }),
    }) as never
    const r = await runAdversarialReview(baseInput, REPO, {
      runHarnessFn,
      exec,
    })
    expect(r.wroteFiles).not.toContain(".adv-review-last-message.txt")
    expect(r.wroteFiles).toContain("src/real.ts")
  })

  test("wroteFiles is [] when only the output file is present", async () => {
    const log: string[] = []
    const exec = makeExec({
      log,
      porcelain: "?? .adv-review-last-message.txt\n",
    })
    const runHarnessFn = makeHarness(log, {
      code: 0,
      output: verdictJson({ verdict: "sufficient", holes: [] }),
    }) as never
    const r = await runAdversarialReview(baseInput, REPO, {
      runHarnessFn,
      exec,
    })
    expect(r.wroteFiles).toEqual([])
  })

  test("non-zero exit → unavailable, teardown ran", async () => {
    const log: string[] = []
    const exec = makeExec({ log })
    const runHarnessFn = makeHarness(log, {
      code: 1,
      output: "",
    }) as never
    const r = await runAdversarialReview(baseInput, REPO, {
      runHarnessFn,
      exec,
    })
    expect(r.status).toBe("unavailable")
    expect(r.reason).toMatch(/exit/i)
    expect(r.action).toBe("stop-unavailable")
    expect(log).toContain("worktree-remove")
  })

  test("unparseable output → unavailable, rawReview preserved", async () => {
    const log: string[] = []
    const exec = makeExec({ log })
    const runHarnessFn = makeHarness(log, {
      code: 0,
      output: "not json at all",
    }) as never
    const r = await runAdversarialReview(baseInput, REPO, {
      runHarnessFn,
      exec,
    })
    expect(r.status).toBe("unavailable")
    expect(r.reason).toMatch(/unparseable/i)
    expect(r.rawReview).toContain("not json at all")
  })

  test("spawn error (CLI missing) → unavailable, teardown ran", async () => {
    const log: string[] = []
    const exec = makeExec({ log })
    const runHarnessFn = makeHarness(log, () => {
      throw new Error("spawn codex ENOENT")
    }) as never
    const r = await runAdversarialReview(baseInput, REPO, {
      runHarnessFn,
      exec,
    })
    expect(r.status).toBe("unavailable")
    expect(r.reason).toMatch(/codex/i)
    expect(r.action).toBe("stop-unavailable")
    expect(log).toContain("worktree-remove")
  })

  test("spawned argv is codex-exec headless shape; cwd is the throwaway", async () => {
    const log: string[] = []
    const exec = makeExec({ log })
    let seenArgv: string[] = []
    let seenCwd = ""
    const runHarnessFn = (async (args: { argv: string[]; cwd: string }) => {
      seenArgv = args.argv
      seenCwd = args.cwd
      log.push(`spawn:${args.cwd}`)
      return {
        code: 0,
        output: verdictJson({ verdict: "sufficient", holes: [] }),
      }
    }) as never
    await runAdversarialReview(baseInput, REPO, { runHarnessFn, exec })
    expect(seenArgv[0]).toBe("exec")
    expect(seenArgv).toContain("--dangerously-bypass-approvals-and-sandbox")
    expect(seenArgv).toContain("-o")
    expect(seenCwd).not.toBe(REPO)
    expect(seenCwd).toContain("adv-review-")
  })
})
