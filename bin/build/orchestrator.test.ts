import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { crashLogPath, launchContextPath, readCrashRecords } from "./forensics"
import {
  chooseReviewVerdict,
  createCtx,
  decideStartup,
  EscalateError,
  type GitRunner,
  hasEvalApiKeys,
  makeE2e,
  makeE2eDevServerRunner,
  makeEvalConvexRunner,
  makeEvals,
  normalizeEnvOverrides,
  notifyPrReady,
  noVerdictEscalate,
  prPhase,
  readBaselineBefore,
  readEnvFileKeys,
  recordOptionalStepsDeclaration,
  runFeatureCoverageGate,
  writeRelaunchAutopsy,
} from "./orchestrator"
import type { EmbedScreenshotDeps } from "./pr-screenshots"
import type { PublishResult } from "./repo"
import {
  type BuildState,
  defaultHarnessMap,
  initState,
  readState,
} from "./state"

const now = "2026-05-28T00:00:00Z"

describe("createCtx", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orchestrator-ctx-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function ctxFor(buildDir: string) {
    return createCtx({
      repoRoot: dir,
      feature: "feat",
      buildDir,
      baseBranch: "main",
      env: process.env,
      now: () => now,
    })
  }

  test("specPath getter resolves spec.md when present", () => {
    writeFileSync(join(dir, "spec.md"), "# spec")
    const ctx = ctxFor(dir)
    expect(ctx.specPath).toBe(join(dir, "spec.md"))
  })

  test("specPath getter resolves legacy design.md when spec.md is absent", () => {
    writeFileSync(join(dir, "design.md"), "# design")
    const ctx = ctxFor(dir)
    expect(ctx.specPath).toBe(join(dir, "design.md"))
  })

  test("picks up a rename mid-run from the same ctx object", () => {
    writeFileSync(join(dir, "design.md"), "# design")
    const ctx = ctxFor(dir)
    // First resolution sees the legacy artifact.
    expect(ctx.specPath.endsWith("design.md")).toBe(true)

    // Simulate the A8 design.md → spec.md migration mid-run.
    rmSync(join(dir, "design.md"))
    writeFileSync(join(dir, "spec.md"), "# spec")

    // The same ctx object now resolves the new name — path is not cached.
    expect(ctx.specPath.endsWith("spec.md")).toBe(true)
  })
})

describe("chooseReviewVerdict", () => {
  test("prefers the round-file verdict over the chat-message verdict", () => {
    // The round file's bare sentinel is authoritative; even if the message
    // parsed to something else, the file wins.
    expect(
      chooseReviewVerdict({ kind: "blocking" }, { kind: "clean" }, 4),
    ).toEqual({ kind: "blocking" })
  })

  test("falls back to the message verdict when the file has none", () => {
    expect(chooseReviewVerdict(null, { kind: "clean" }, 2)).toEqual({
      kind: "clean",
    })
  })

  test("escalates only when neither source yields a verdict", () => {
    expect(chooseReviewVerdict(null, null, 4)).toEqual({
      kind: "escalate",
      reason: "code-review round 4 produced no CLEAN/BLOCKING/ESCALATE verdict",
    })
  })
})

describe("notifyPrReady", () => {
  test("writes only to its sink — never touches build.log", () => {
    const logDir = mkdtempSync(join(tmpdir(), "ready-"))
    const logPath = join(logDir, "build.log")
    writeFileSync(logPath, "original\n")
    const written: string[] = []
    try {
      notifyPrReady((s) => written.push(s))
      // The build.log on disk is untouched — the notification is stdout-only.
      expect(readFileSync(logPath, "utf-8")).toBe("original\n")
      // It did emit a bell + a status line to its sink.
      expect(written.join("")).toContain("\x07")
      expect(written.join("")).toContain("PR ready")
    } finally {
      rmSync(logDir, { recursive: true, force: true })
    }
  })
})

describe("noVerdictEscalate (PRO-639)", () => {
  test("reason states auto-retry was attempted, with the count (plural)", () => {
    const v = noVerdictEscalate("build", 2)
    expect(v.kind).toBe("escalate")
    if (v.kind === "escalate") {
      expect(v.reason).toContain("build")
      expect(v.reason).toContain("2 auto-retries")
      expect(v.reason).toContain("no completion sentinel")
    }
  })

  test("singular grammar for a single retry", () => {
    const v = noVerdictEscalate("plan", 1)
    if (v.kind === "escalate") {
      expect(v.reason).toContain("1 auto-retry")
      expect(v.reason).not.toContain("auto-retries")
    }
  })

  test("zero retries still reads as auto-retries (plural)", () => {
    const v = noVerdictEscalate("build", 0)
    if (v.kind === "escalate") expect(v.reason).toContain("0 auto-retries")
  })
})

describe("prPhase", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "orchestrator-pr-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function stateFor() {
    return {
      ...initState("feat", "battle-silene", now, "PRO-123"),
      phase: "pr" as const,
      harnessMap: defaultHarnessMap(),
    }
  }

  /** Embed deps double recording call order; resolvable lookups, no screenshots. */
  function embedDouble(
    opts: {
      publish?: PublishResult
      files?: string[]
      record?: string[]
      edits?: string[]
      editOk?: boolean
    } = {},
  ): EmbedScreenshotDeps {
    const record = opts.record ?? []
    const edits = opts.edits ?? []
    return {
      publish: () => {
        record.push("publish")
        return opts.publish ?? { status: "clean" }
      },
      listScreenshots: () => opts.files ?? [],
      nameWithOwner: () => "o/r",
      headSha: () => {
        record.push("headSha")
        return "5f2e9c1a3b7d4e6f8a0c2b4d6e8f0a1c3e5d7f90"
      },
      prBody: () => "Body",
      editPrBody: (b) => {
        record.push("editPrBody")
        edits.push(b)
        return opts.editOk ?? true
      },
      log: () => {},
    }
  }

  test("threads sentry-fixes short-ids from the spec into the PR prompt", async () => {
    writeFileSync(
      join(dir, "spec.md"),
      "# Spec\n<!-- sentry-fixes: PRODUCT-WEB-1A2 -->\n",
    )
    const ctx = createCtx({
      repoRoot: dir,
      feature: "feat",
      buildDir: dir,
      baseBranch: "main",
      env: process.env,
      now: () => now,
    })
    let seenPrompt = ""
    const signal = await prPhase(
      ctx,
      stateFor(),
      async (_c, _h, prompt) => {
        seenPrompt = prompt
        return { kind: "done" }
      },
      embedDouble(),
    )
    expect(signal.phase).toBe("pr")
    expect(seenPrompt).toContain("fixes PRODUCT-WEB-1A2")
    expect(seenPrompt).toContain("--allow-empty")
  })

  test("no marker in the spec → no `fixes` instruction reaches the prompt", async () => {
    writeFileSync(join(dir, "spec.md"), "# Spec\n\nNo markers.\n")
    const ctx = createCtx({
      repoRoot: dir,
      feature: "feat",
      buildDir: dir,
      baseBranch: "main",
      env: process.env,
      now: () => now,
    })
    let seenPrompt = ""
    await prPhase(
      ctx,
      stateFor(),
      async (_c, _h, prompt) => {
        seenPrompt = prompt
        return { kind: "done" }
      },
      embedDouble(),
    )
    expect(seenPrompt).not.toContain("fixes ")
    expect(seenPrompt).not.toContain("--allow-empty")
  })

  test("publish runs before embed; editPrBody gets a body with a SHA-pinned blob URL", async () => {
    writeFileSync(join(dir, "spec.md"), "# Spec\n")
    const ctx = createCtx({
      repoRoot: dir,
      feature: "feat",
      buildDir: dir,
      baseBranch: "main",
      env: process.env,
      now: () => now,
    })
    const record: string[] = []
    const edits: string[] = []
    await prPhase(
      ctx,
      stateFor(),
      async () => ({ kind: "done" }),
      embedDouble({
        publish: { status: "pushed" },
        files: ["login.png"],
        record,
        edits,
      }),
    )
    expect(record.indexOf("publish")).toBeLessThan(record.indexOf("editPrBody"))
    expect(record.indexOf("publish")).toBeLessThan(record.indexOf("headSha"))
    expect(edits[0]).toContain(
      "github.com/o/r/blob/5f2e9c1a3b7d4e6f8a0c2b4d6e8f0a1c3e5d7f90/build/feat/screenshots/login.png",
    )
    expect(edits[0]).not.toContain("raw.githubusercontent.com")
  })

  test("escalate verdict → embed skipped (no publish, no editPrBody)", async () => {
    writeFileSync(join(dir, "spec.md"), "# Spec\n")
    const ctx = createCtx({
      repoRoot: dir,
      feature: "feat",
      buildDir: dir,
      baseBranch: "main",
      env: process.env,
      now: () => now,
    })
    const record: string[] = []
    await prPhase(
      ctx,
      stateFor(),
      async () => ({ kind: "escalate", reason: "merge conflict" }),
      embedDouble({ files: ["login.png"], record }),
    )
    expect(record).toEqual([])
  })

  test("embed fails WITH screenshots → prPhase escalates (no silent success)", async () => {
    writeFileSync(join(dir, "spec.md"), "# Spec\n")
    const ctx = createCtx({
      repoRoot: dir,
      feature: "feat",
      buildDir: dir,
      baseBranch: "main",
      env: process.env,
      now: () => now,
    })
    // Publish fails while screenshots exist: the PR would otherwise ship without
    // the required verification block, so the phase must block.
    await expect(
      prPhase(
        ctx,
        stateFor(),
        async () => ({ kind: "done" }),
        embedDouble({
          publish: { status: "failed", detail: "push rejected" },
          files: ["login.png"],
        }),
      ),
    ).rejects.toThrow(/verification screenshots could not be embedded/)
  })

  test("embed fails WITHOUT screenshots → prPhase still succeeds (nothing at stake)", async () => {
    writeFileSync(join(dir, "spec.md"), "# Spec\n")
    const ctx = createCtx({
      repoRoot: dir,
      feature: "feat",
      buildDir: dir,
      baseBranch: "main",
      env: process.env,
      now: () => now,
    })
    const signal = await prPhase(
      ctx,
      stateFor(),
      async () => ({ kind: "done" }),
      embedDouble({
        publish: { status: "failed", detail: "push rejected" },
        files: [],
      }),
    )
    expect(signal.phase).toBe("pr")
  })
})

describe("runFeatureCoverageGate", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "coverage-gate-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("no assert-e2e-coverage.ts → no-op pass (feature opt-in)", () => {
    expect(runFeatureCoverageGate(dir, process.cwd())).toEqual({
      ok: true,
      output: "",
    })
  })

  test("checker exits 0 → ok", () => {
    writeFileSync(join(dir, "assert-e2e-coverage.ts"), "process.exit(0)\n")
    expect(runFeatureCoverageGate(dir, process.cwd())).toEqual({
      ok: true,
      output: "",
    })
  })

  test("checker exits non-zero → not-ok, carries its output", () => {
    writeFileSync(
      join(dir, "assert-e2e-coverage.ts"),
      'console.log("MARCUS_NATURAL_WIDTH_ZERO")\nprocess.exit(1)\n',
    )
    const result = runFeatureCoverageGate(dir, process.cwd())
    expect(result.ok).toBe(false)
    expect(result.output).toContain("exited 1")
    expect(result.output).toContain("MARCUS_NATURAL_WIDTH_ZERO")
  })
})

describe("decideStartup", () => {
  test("no state + no design → halt (run /spec first)", () => {
    const d = decideStartup(
      { specExists: false, state: null, needsInputExists: false },
      "feat",
      "br",
      now,
    )
    expect(d.kind).toBe("halt")
    if (d.kind === "halt") expect(d.message).toContain("/spec")
  })

  test("no state + design → start fresh at plan", () => {
    const d = decideStartup(
      { specExists: true, state: null, needsInputExists: false },
      "feat",
      "br",
      now,
    )
    expect(d.kind).toBe("start")
    if (d.kind === "start") {
      expect(d.state.phase).toBe("plan")
      expect(d.state.status).toBe("running")
    }
  })

  test("existing state + NEEDS-INPUT present → halt", () => {
    const state = {
      ...initState("feat", "br", now),
      phase: "build" as const,
      status: "blocked" as const,
    }
    const d = decideStartup(
      { specExists: true, state, needsInputExists: true },
      "feat",
      "br",
      now,
    )
    expect(d.kind).toBe("halt")
    if (d.kind === "halt") expect(d.message).toContain("NEEDS-INPUT.md")
  })

  test("blocked but NEEDS-INPUT deleted → resume running from same phase", () => {
    const state = {
      ...initState("feat", "br", now),
      phase: "review" as const,
      status: "blocked" as const,
      reviewRound: 2,
    }
    const d = decideStartup(
      { specExists: true, state, needsInputExists: false },
      "feat",
      "br",
      now,
    )
    expect(d.kind).toBe("start")
    if (d.kind === "start") {
      expect(d.state.phase).toBe("review")
      expect(d.state.status).toBe("running")
      expect(d.state.reviewRound).toBe(2)
    }
  })

  test("monitor running interrupted → resume monitor, do not treat as done", () => {
    const state = {
      ...initState("feat", "br", now),
      phase: "monitor" as const,
      status: "running" as const,
    }
    const d = decideStartup(
      { specExists: true, state, needsInputExists: false },
      "feat",
      "br",
      now,
    )
    expect(d.kind).toBe("start")
    if (d.kind === "start") {
      expect(d.state.phase).toBe("monitor")
      expect(d.state.status).toBe("running")
    }
  })

  test("already done → halt", () => {
    const state = {
      ...initState("feat", "br", now),
      phase: "done" as const,
      status: "done" as const,
    }
    const d = decideStartup(
      { specExists: true, state, needsInputExists: false },
      "feat",
      "br",
      now,
    )
    expect(d.kind).toBe("halt")
    if (d.kind === "halt") expect(d.message).toContain("already done")
  })

  test("fresh start seeds linearIssueId from the passed ticket ref", () => {
    const d = decideStartup(
      { specExists: true, state: null, needsInputExists: false },
      "feat",
      "br",
      now,
      "PRO-123",
    )
    expect(d.kind).toBe("start")
    if (d.kind === "start") expect(d.state.linearIssueId).toBe("PRO-123")
  })

  test("resume ignores the passed ticket ref — the recorded state wins", () => {
    const state = {
      ...initState("feat", "br", now),
      phase: "build" as const,
      status: "running" as const,
    }
    const d = decideStartup(
      { specExists: true, state, needsInputExists: false },
      "feat",
      "br",
      now,
      "PRO-999",
    )
    expect(d.kind).toBe("start")
    if (d.kind === "start") expect(d.state.linearIssueId).toBeUndefined()
  })
})

describe("normalizeEnvOverrides", () => {
  const base = (): BuildState => initState("feat", "br", now)

  test("BUILD_SKIP_E2E=1 + no prior override → new state with e2e off", () => {
    const state = base()
    const next = normalizeEnvOverrides(state, { BUILD_SKIP_E2E: "1" })
    expect(next).not.toBe(state)
    expect(next.optionalStepOverrides?.e2e).toBe("off")
  })

  test("already off → SAME reference (no churn)", () => {
    const state = { ...base(), optionalStepOverrides: { e2e: "off" as const } }
    const next = normalizeEnvOverrides(state, { BUILD_SKIP_E2E: "1" })
    expect(next).toBe(state)
  })

  test("env unset → SAME reference, existing overrides untouched", () => {
    const state = { ...base(), optionalStepOverrides: { e2e: "on" as const } }
    const next = normalizeEnvOverrides(state, {})
    expect(next).toBe(state)
    expect(next.optionalStepOverrides?.e2e).toBe("on")
  })

  test("BUILD_SKIP_EVALS=1 folds evals off (preserving any e2e override)", () => {
    const state = { ...base(), optionalStepOverrides: { e2e: "on" as const } }
    const next = normalizeEnvOverrides(state, { BUILD_SKIP_EVALS: "1" })
    expect(next).not.toBe(state)
    expect(next.optionalStepOverrides?.evals).toBe("off")
    expect(next.optionalStepOverrides?.e2e).toBe("on")
  })

  test("both BUILD_SKIP_E2E and BUILD_SKIP_EVALS fold together", () => {
    const next = normalizeEnvOverrides(base(), {
      BUILD_SKIP_E2E: "1",
      BUILD_SKIP_EVALS: "1",
    })
    expect(next.optionalStepOverrides?.e2e).toBe("off")
    expect(next.optionalStepOverrides?.evals).toBe("off")
  })

  test("evals already off → SAME reference (no churn)", () => {
    const state = {
      ...base(),
      optionalStepOverrides: { evals: "off" as const },
    }
    const next = normalizeEnvOverrides(state, { BUILD_SKIP_EVALS: "1" })
    expect(next).toBe(state)
  })
})

describe("hasEvalApiKeys", () => {
  test("both present → ok, no missing", () => {
    expect(
      hasEvalApiKeys({ AI_GATEWAY_API_KEY: "x", ANTHROPIC_API_KEY: "y" }),
    ).toEqual({ ok: true, missing: [] })
  })

  test("names each missing key", () => {
    expect(hasEvalApiKeys({ ANTHROPIC_API_KEY: "y" })).toEqual({
      ok: false,
      missing: ["AI_GATEWAY_API_KEY"],
    })
    expect(hasEvalApiKeys({ AI_GATEWAY_API_KEY: "x" })).toEqual({
      ok: false,
      missing: ["ANTHROPIC_API_KEY"],
    })
    expect(hasEvalApiKeys({})).toEqual({
      ok: false,
      missing: ["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY"],
    })
  })

  test("dotenv-file keys satisfy the requirement even when the shell env lacks them", () => {
    // Mirrors evalite: `bunx evalite run` loads apps/web/.env[.local] itself, so a
    // key present only in those files is still available to the run.
    expect(
      hasEvalApiKeys({}, new Set(["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY"])),
    ).toEqual({ ok: true, missing: [] })
    // env and file sources union.
    expect(
      hasEvalApiKeys(
        { AI_GATEWAY_API_KEY: "x" },
        new Set(["ANTHROPIC_API_KEY"]),
      ),
    ).toEqual({ ok: true, missing: [] })
    // still names what neither source provides.
    expect(hasEvalApiKeys({}, new Set(["AI_GATEWAY_API_KEY"]))).toEqual({
      ok: false,
      missing: ["ANTHROPIC_API_KEY"],
    })
  })
})

describe("readEnvFileKeys", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eval-envkeys-"))
    mkdirSync(join(dir, "apps", "web"), { recursive: true })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("collects key NAMES from both .env and .env.local (union, no values)", () => {
    writeFileSync(
      join(dir, "apps", "web", ".env"),
      "AI_GATEWAY_API_KEY=secret-value\n# comment\nexport ANTHROPIC_API_KEY = another\n",
    )
    writeFileSync(
      join(dir, "apps", "web", ".env.local"),
      "NEXT_PUBLIC_CONVEX_URL=https://x.convex.cloud\n",
    )
    const keys = readEnvFileKeys(dir)
    expect(keys.has("AI_GATEWAY_API_KEY")).toBe(true)
    expect(keys.has("ANTHROPIC_API_KEY")).toBe(true)
    expect(keys.has("NEXT_PUBLIC_CONVEX_URL")).toBe(true)
    // never leaks a value into the name set
    expect(keys.has("secret-value")).toBe(false)
  })

  test("missing files contribute nothing (empty set)", () => {
    expect(readEnvFileKeys(dir).size).toBe(0)
  })
})

describe("readBaselineBefore", () => {
  const path = "apps/web/evals/baselines.json"
  function gitFake(
    handlers: Partial<Record<string, ReturnType<GitRunner>>>,
    fallback: ReturnType<GitRunner> = { code: 0, stdout: "", stderr: "" },
  ): GitRunner {
    return (args) => {
      const key = args[0]
      return handlers[key] ?? fallback
    }
  }

  test("ref resolves + file present + valid JSON → ok with parsed scores", () => {
    const git = gitFake({
      "rev-parse": { code: 0, stdout: "abc123\n", stderr: "" },
      "cat-file": { code: 0, stdout: "", stderr: "" },
      show: {
        code: 0,
        stdout: JSON.stringify({ "gmail/reply": 0.9 }),
        stderr: "",
      },
    })
    expect(readBaselineBefore("main", git)).toEqual({
      status: "ok",
      scores: { "gmail/reply": 0.9 },
    })
  })

  test("ref resolves but file absent (cat-file non-zero) → absent (bootstrap)", () => {
    const git = gitFake({
      "rev-parse": { code: 0, stdout: "abc\n", stderr: "" },
      "cat-file": { code: 1, stdout: "", stderr: "not found" },
    })
    expect(readBaselineBefore("main", git)).toEqual({ status: "absent" })
  })

  test("rev-parse fails (unresolvable ref) → unreadable", () => {
    const git = gitFake({
      "rev-parse": { code: 128, stdout: "", stderr: "unknown ref" },
    })
    const r = readBaselineBefore("main", git)
    expect(r.status).toBe("unreadable")
  })

  test("rev-parse empty stdout → unreadable", () => {
    const git = gitFake({
      "rev-parse": { code: 0, stdout: "  \n", stderr: "" },
    })
    expect(readBaselineBefore("main", git).status).toBe("unreadable")
  })

  test("git runner throws (spawn failure) → unreadable", () => {
    const git: GitRunner = () => {
      throw new Error("spawn ENOENT")
    }
    expect(readBaselineBefore("main", git).status).toBe("unreadable")
  })

  test("ref + file present but malformed JSON → unreadable (must NOT degrade to {})", () => {
    const git = gitFake({
      "rev-parse": { code: 0, stdout: "abc\n", stderr: "" },
      "cat-file": { code: 0, stdout: "", stderr: "" },
      show: { code: 0, stdout: "{not json", stderr: "" },
    })
    const r = readBaselineBefore("main", git)
    expect(r.status).toBe("unreadable")
    if (r.status === "unreadable") expect(r.detail).toContain("malformed")
  })

  test("ref + file present but a JSON array (non-object) → unreadable", () => {
    const git = gitFake({
      "rev-parse": { code: 0, stdout: "abc\n", stderr: "" },
      "cat-file": { code: 0, stdout: "", stderr: "" },
      show: { code: 0, stdout: "[1,2,3]", stderr: "" },
    })
    expect(readBaselineBefore("main", git).status).toBe("unreadable")
    void path
  })
})

describe("makeEvalConvexRunner", () => {
  test("reachable → runs the closure", async () => {
    const withConvex = makeEvalConvexRunner({
      convexUrl: "https://convex.local",
      reachableImpl: async () => true,
    })
    expect(await withConvex(async () => "ran")).toBe("ran")
  })

  test("unreachable → throws EscalateError(validate, evals-infra)", async () => {
    const withConvex = makeEvalConvexRunner({
      convexUrl: "https://convex.local",
      reachableImpl: async () => false,
    })
    await expect(withConvex(async () => "x")).rejects.toThrow(EscalateError)
  })

  test("no convex URL → throws EscalateError", async () => {
    const withConvex = makeEvalConvexRunner({ convexUrl: null })
    await expect(withConvex(async () => "x")).rejects.toThrow(EscalateError)
  })
})

describe("makeE2e gating", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "orchestrator-e2e-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  function ctxWith(env: NodeJS.ProcessEnv) {
    return createCtx({
      repoRoot: repo,
      feature: "feat",
      buildDir: join(repo, "build", "feat"),
      baseBranch: "main",
      env,
      now: () => now,
    })
  }

  function stateWith(over: Partial<BuildState>): BuildState {
    return { ...initState("feat", "br", now), ...over }
  }

  test("returns undefined when the declaration marks e2e not needed", () => {
    const ctx = ctxWith({})
    const result = makeE2e(
      ctx,
      stateWith({ optionalSteps: { e2e: { needed: false, rationale: "x" } } }),
    )
    expect(result).toBeUndefined()
  })

  test("returns undefined when forced off even if otherwise needed", () => {
    const ctx = ctxWith({})
    const result = makeE2e(
      ctx,
      stateWith({
        optionalSteps: { e2e: { needed: true, rationale: "x" } },
        optionalStepOverrides: { e2e: "off" },
      }),
    )
    expect(result).toBeUndefined()
  })

  test("throws EscalateError when needed but infra missing", () => {
    // No .mcp.json in repo, no BUILD_E2E_MCP → infra unavailable.
    const ctx = ctxWith({})
    expect(() =>
      makeE2e(
        ctx,
        stateWith({ optionalSteps: { e2e: { needed: true, rationale: "x" } } }),
      ),
    ).toThrow(EscalateError)
  })

  test("returns a function (runs) when needed and BUILD_E2E_MCP is set", () => {
    const mcpPath = join(repo, "custom.mcp.json")
    writeFileSync(mcpPath, "{}")
    const ctx = ctxWith({ BUILD_E2E_MCP: mcpPath })
    const result = makeE2e(
      ctx,
      stateWith({ optionalSteps: { e2e: { needed: true, rationale: "x" } } }),
    )
    expect(typeof result).toBe("function")
  })
})

describe("makeEvals gating", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "orchestrator-evals-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  const bothKeys = { AI_GATEWAY_API_KEY: "x", ANTHROPIC_API_KEY: "y" }

  function ctxWith(env: NodeJS.ProcessEnv) {
    return createCtx({
      repoRoot: repo,
      feature: "feat",
      buildDir: join(repo, "build", "feat"),
      baseBranch: "main",
      env,
      now: () => now,
    })
  }
  function stateWith(over: Partial<BuildState>): BuildState {
    return { ...initState("feat", "br", now), ...over }
  }

  test("returns undefined when evals not needed", () => {
    expect(
      makeEvals(
        ctxWith(bothKeys),
        stateWith({
          optionalSteps: { evals: { needed: false, rationale: "x" } },
        }),
      ),
    ).toBeUndefined()
  })

  test("returns undefined when forced off", () => {
    expect(
      makeEvals(
        ctxWith(bothKeys),
        stateWith({
          optionalSteps: { evals: { needed: true, rationale: "x" } },
          optionalStepOverrides: { evals: "off" },
        }),
      ),
    ).toBeUndefined()
  })

  test("throws EscalateError naming the missing key(s) when needed but a key is absent", () => {
    const ctx = ctxWith({ ANTHROPIC_API_KEY: "y" }) // AI_GATEWAY_API_KEY missing
    let thrown: unknown
    try {
      makeEvals(
        ctx,
        stateWith({
          optionalSteps: { evals: { needed: true, rationale: "x" } },
        }),
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(EscalateError)
    expect((thrown as EscalateError).category).toBe("evals-infra")
    expect((thrown as EscalateError).reason).toContain("AI_GATEWAY_API_KEY")
  })

  test("returns a function when needed and both keys present", () => {
    expect(
      typeof makeEvals(
        ctxWith(bothKeys),
        stateWith({
          optionalSteps: { evals: { needed: true, rationale: "x" } },
        }),
      ),
    ).toBe("function")
  })

  describe("R2 baseline resolution inside the closure", () => {
    const needed = () =>
      stateWith({ optionalSteps: { evals: { needed: true, rationale: "x" } } })

    test("unreadable → closure throws EscalateError and NEVER reaches runEvalExecute", async () => {
      let executeCalls = 0
      const step = makeEvals(ctxWith(bothKeys), needed(), {
        readBaselineBeforeImpl: () => ({
          status: "unreadable",
          detail: "base ref origin/main not found",
        }),
        ensureEvalPlanImpl: async () => {},
        runEvalExecuteImpl: async () => {
          executeCalls++
          return { name: "evals", ok: true, output: "" }
        },
      })
      expect(step).toBeDefined()
      await expect((step as () => Promise<unknown>)()).rejects.toThrow(
        EscalateError,
      )
      expect(executeCalls).toBe(0) // no paid run, no false PASS
    })

    test("absent → bootstrap: proceeds with baselineBefore = {}", async () => {
      let seenBaseline: unknown = "unset"
      const step = makeEvals(ctxWith(bothKeys), needed(), {
        readBaselineBeforeImpl: () => ({ status: "absent" }),
        ensureEvalPlanImpl: async () => {},
        runEvalExecuteImpl: async (d) => {
          seenBaseline = d.baselineBefore
          return { name: "evals", ok: true, output: "" }
        },
      })
      const result = await (step as () => Promise<unknown>)()
      expect(seenBaseline).toEqual({})
      expect(result).toEqual({ name: "evals", ok: true, output: "" })
    })

    test("ok → runEvalExecute called with the committed scores", async () => {
      let seenBaseline: unknown = "unset"
      const step = makeEvals(ctxWith(bothKeys), needed(), {
        readBaselineBeforeImpl: () => ({
          status: "ok",
          scores: { "gmail/reply": 0.9 },
        }),
        ensureEvalPlanImpl: async () => {},
        runEvalExecuteImpl: async (d) => {
          seenBaseline = d.baselineBefore
          return { name: "evals", ok: true, output: "" }
        },
      })
      await (step as () => Promise<unknown>)()
      expect(seenBaseline).toEqual({ "gmail/reply": 0.9 })
    })
  })
})

describe("makeE2eDevServerRunner", () => {
  const base = {
    buildDir: "/wt/build/feat",
    devUrl: "https://x.dispatch.localhost",
    controlScriptPath: "/wt/bin/build/dev-server-control.ts",
  }

  test("herdr-framed (pane present): starts the server, runs e2e, leaves it warm", async () => {
    const ensureCalls: unknown[] = []
    let stopped = false
    const withDevServer = makeE2eDevServerRunner({
      ...base,
      readPane: () => ({ paneId: "pane-dev", worktreePath: "/wt" }),
      ensureStarted: async (deps) => {
        ensureCalls.push(deps)
        return true
      },
      // A reachability probe here would mean the external (non-kickoff) path; it
      // must NOT be consulted when a pane handle is present.
      reachableImpl: async () => {
        stopped = true
        return false
      },
    })
    const result = await withDevServer(async (url) => `ran:${url}`)
    expect(result).toBe(`ran:${base.devUrl}`)
    expect(ensureCalls).toHaveLength(1)
    expect(stopped).toBe(false)
  })

  test("herdr-framed but never reachable → throws EscalateError(validate)", async () => {
    const withDevServer = makeE2eDevServerRunner({
      ...base,
      readPane: () => ({ paneId: "pane-dev" }),
      ensureStarted: async () => false,
    })
    await expect(withDevServer(async () => "should not run")).rejects.toThrow(
      EscalateError,
    )
  })

  test("non-kickoff, reachable (no pane): uses the URL as-is, no herdr calls", async () => {
    let ensured = false
    const withDevServer = makeE2eDevServerRunner({
      ...base,
      readPane: () => null,
      ensureStarted: async () => {
        ensured = true
        return true
      },
      reachableImpl: async () => true,
    })
    const result = await withDevServer(async (url) => `ran:${url}`)
    expect(result).toBe(`ran:${base.devUrl}`)
    expect(ensured).toBe(false)
  })

  test("non-kickoff, unreachable → throws EscalateError(validate) (block → NEEDS-INPUT)", async () => {
    const withDevServer = makeE2eDevServerRunner({
      ...base,
      readPane: () => null,
      reachableImpl: async () => false,
    })
    await expect(withDevServer(async () => "should not run")).rejects.toThrow(
      EscalateError,
    )
  })
})

describe("recordOptionalStepsDeclaration", () => {
  let repo: string
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "orchestrator-record-"))
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  function ctxFor() {
    return createCtx({
      repoRoot: repo,
      feature: "feat",
      buildDir: join(repo, "build", "feat"),
      baseBranch: "main",
      env: {},
      now: () => now,
    })
  }

  test("persists a valid declaration into state.optionalSteps + state.json", () => {
    const ctx = ctxFor()
    mkdirSync(ctx.buildDir, { recursive: true })
    writeFileSync(
      join(ctx.buildDir, "optional-steps.json"),
      JSON.stringify({ e2e: { needed: false, rationale: "pure backend" } }),
    )
    const state = initState("feat", "br", now)
    recordOptionalStepsDeclaration(ctx, state)
    expect(state.optionalSteps?.e2e).toEqual({
      needed: false,
      rationale: "pure backend",
    })
    expect(readState(repo, "feat")?.optionalSteps?.e2e?.needed).toBe(false)
  })

  test("absent/malformed file → optionalSteps left undefined (fail-safe)", () => {
    const ctx = ctxFor()
    mkdirSync(ctx.buildDir, { recursive: true })
    // No optional-steps.json written.
    const state = initState("feat", "br", now)
    recordOptionalStepsDeclaration(ctx, state)
    expect(state.optionalSteps).toBeUndefined()
    const log = readFileSync(ctx.logPath, "utf-8")
    expect(log).toContain("defaulting all optional steps to needed")
  })
})

describe("writeRelaunchAutopsy", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "autopsy-relaunch-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  const fixedNow = "2026-07-03T12:00:00Z"

  function runningState(phase: BuildState["phase"]): BuildState {
    return {
      ...initState("feat", "br", "2026-07-03T11:00:00Z"),
      phase,
      status: "running",
    }
  }

  test("fires on a stale/missing heartbeat with the prior phase + wrapper code", () => {
    const logPath = join(dir, "build.log")
    writeFileSync(
      logPath,
      "[t] wrapper: bun process exited (code=137, signal=SIGKILL)\n",
    )
    writeRelaunchAutopsy({
      priorState: runningState("build"),
      buildDir: dir,
      logPath,
      now: () => fixedNow,
      deps: {
        readHeartbeat: () => null, // missing heartbeat ⇒ stale ⇒ autopsy
        readLogTail: (p) => readFileSync(p, "utf-8"),
        runProbe: () => ["autopsy: mem: run manually …"],
      },
    })
    const log = readFileSync(logPath, "utf-8")
    expect(log).toContain("ended abnormally")
    expect(log).toContain("last phase=build")
    expect(log).toContain("wrapper recorded bun exit code=137")
    expect(log).toContain("autopsy: mem:")
  })

  test("appends an autopsy record to crashes.jsonl embedding the dead run's launch context", () => {
    const logPath = join(dir, "build.log")
    writeFileSync(
      logPath,
      "[t] wrapper: bun process exited (code=143, signal=SIGTERM)\n",
    )
    const launch = {
      ts: "2026-07-03T11:00:00Z",
      pid: 555,
      ppid: 444,
      ancestry: [{ pid: 555, command: "bun run bin/build.ts feat" }],
      env: { CONDUCTOR_WORKSPACE_NAME: "product-feat" },
    }
    mkdirSync(join(dir, ".build"), { recursive: true })
    writeFileSync(launchContextPath(dir), JSON.stringify(launch))
    writeRelaunchAutopsy({
      priorState: runningState("build"),
      buildDir: dir,
      logPath,
      now: () => fixedNow,
      deps: {
        readHeartbeat: () => ({ ts: "2026-07-03T11:30:00Z", pid: 555 }),
        readLogTail: (p) => readFileSync(p, "utf-8"),
        runProbe: () => [],
      },
    })
    const records = readCrashRecords(crashLogPath(dir))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      kind: "autopsy",
      ts: fixedNow,
      priorPhase: "build",
      wrapperExit: "143",
      lastAlive: "2026-07-03T11:30:00Z",
      pid: 555,
      launch,
    })
  })

  test("no autopsy on a fresh heartbeat — logs 'skipped', no wrapper line", () => {
    const logPath = join(dir, "build.log")
    writeFileSync(logPath, "[t] wrapper: bun process exited (code=137)\n")
    let probed = false
    writeRelaunchAutopsy({
      priorState: runningState("monitor"),
      buildDir: dir,
      logPath,
      now: () => fixedNow,
      deps: {
        // Fresh: 5 s old relative to fixedNow.
        readHeartbeat: () => ({
          ts: new Date(Date.parse(fixedNow) - 5_000).toISOString(),
          pid: 4242,
        }),
        readLogTail: (p) => readFileSync(p, "utf-8"),
        runProbe: () => {
          probed = true
          return []
        },
      },
    })
    const log = readFileSync(logPath, "utf-8")
    expect(log).toContain("autopsy: skipped — prior heartbeat is fresh")
    expect(log).toContain("pid=4242")
    expect(log).not.toContain("ended abnormally")
    expect(log).not.toContain("wrapper recorded")
    expect(probed).toBe(false)
  })

  test("falls back to the legacy tracked heartbeat when .build/ is missing", () => {
    const logPath = join(dir, "build.log")
    writeFileSync(logPath, "[t] wrapper: bun process exited (code=137)\n")
    let probed = false
    writeRelaunchAutopsy({
      priorState: runningState("monitor"),
      buildDir: dir,
      logPath,
      now: () => fixedNow,
      deps: {
        // Path-aware: the new .build/ location has no heartbeat (this build was
        // mid-run when the PRO-667 move shipped), but the legacy tracked file is
        // fresh — the fallback must read it and treat the run as alive.
        readHeartbeat: (p: string) =>
          p === join(dir, ".build", "heartbeat.json")
            ? null
            : {
                ts: new Date(Date.parse(fixedNow) - 5_000).toISOString(),
                pid: 4242,
              },
        readLogTail: (p) => readFileSync(p, "utf-8"),
        runProbe: () => {
          probed = true
          return []
        },
      },
    })
    const log = readFileSync(logPath, "utf-8")
    expect(log).toContain("autopsy: skipped — prior heartbeat is fresh")
    expect(log).toContain("pid=4242")
    expect(log).not.toContain("ended abnormally")
    expect(probed).toBe(false)
  })

  test("does nothing when the prior run was not 'running'", () => {
    const logPath = join(dir, "build.log")
    writeFileSync(logPath, "seed\n")
    writeRelaunchAutopsy({
      priorState: { ...runningState("build"), status: "blocked" },
      buildDir: dir,
      logPath,
      now: () => fixedNow,
      deps: {
        readHeartbeat: () => null,
        readLogTail: (p) => readFileSync(p, "utf-8"),
        runProbe: () => ["should not run"],
      },
    })
    expect(readFileSync(logPath, "utf-8")).toBe("seed\n")
  })

  test("no prior state → no-op", () => {
    const logPath = join(dir, "build.log")
    writeRelaunchAutopsy({
      priorState: null,
      buildDir: dir,
      logPath,
      now: () => fixedNow,
    })
    // Nothing written (file never created).
    expect(existsSync(logPath)).toBe(false)
  })
})
