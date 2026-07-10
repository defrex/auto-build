import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { AutoMergeView } from "./auto-merge"
import {
  deriveLiveness,
  parseDashboardArg,
  readDashboardSnapshot,
  readLogMtime,
  renderDashboard,
  renderDevServerLines,
  renderOptionalStepLine,
  resolveBuildDir,
  wrapSummary,
} from "./dashboard"
import type { DevServerView } from "./dev-server-status"
import type { BuildState } from "./state"

const tmpDirs: string[] = []
function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-test-"))
  tmpDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function validState(over: Partial<BuildState> = {}): BuildState {
  return {
    feature: "herdr-build-monitor",
    phase: "build",
    status: "running",
    reviewRound: 0,
    branch: "kickoff/pro-493-herdr-build-monitor",
    harnessMap: {
      plan: { bin: "claude", model: "opus" },
      "plan-review": { bin: "codex" },
      build: { bin: "claude", model: "opus" },
      review: { bin: "codex" },
      pr: { bin: "claude", model: "opus" },
    },
    updatedAt: "2026-06-18T00:00:00.000Z",
    ...over,
  }
}

describe("parseDashboardArg", () => {
  test("bare slug captures no directory (runner resolves via repo root)", () => {
    expect(parseDashboardArg("herdr-build-monitor")).toEqual({
      slug: "herdr-build-monitor",
      buildDir: null,
    })
  })

  test("relative path resolves to that directory under the cwd", () => {
    expect(parseDashboardArg("build/herdr-build-monitor")).toEqual({
      slug: "herdr-build-monitor",
      buildDir: resolve("build/herdr-build-monitor"),
    })
  })

  test("trailing slash is stripped", () => {
    expect(parseDashboardArg("build/herdr-build-monitor/")).toEqual({
      slug: "herdr-build-monitor",
      buildDir: resolve("build/herdr-build-monitor"),
    })
  })

  test("absolute path is honored verbatim, independent of cwd", () => {
    expect(
      parseDashboardArg("/some/other/worktree/build/herdr-build-monitor"),
    ).toEqual({
      slug: "herdr-build-monitor",
      buildDir: "/some/other/worktree/build/herdr-build-monitor",
    })
  })

  test("a trailing state.json resolves to the parent build dir", () => {
    expect(
      parseDashboardArg("/wt/build/herdr-build-monitor/state.json"),
    ).toEqual({
      slug: "herdr-build-monitor",
      buildDir: "/wt/build/herdr-build-monitor",
    })
  })

  test("a trailing spec.md resolves to the parent build dir", () => {
    expect(parseDashboardArg("/wt/build/herdr-build-monitor/spec.md")).toEqual({
      slug: "herdr-build-monitor",
      buildDir: "/wt/build/herdr-build-monitor",
    })
  })

  test("empty/whitespace throws a usage error", () => {
    expect(() => parseDashboardArg("")).toThrow()
    expect(() => parseDashboardArg("   ")).toThrow()
  })
})

describe("resolveBuildDir", () => {
  test("bare-slug target resolves against the detected repo root", () => {
    let invoked = false
    const dir = resolveBuildDir({ slug: "x", buildDir: null }, () => {
      invoked = true
      return "/repo"
    })
    expect(dir).toBe(join("/repo", "build", "x"))
    expect(invoked).toBe(true)
  })

  test("explicit-path target never consults the repo-root detector", () => {
    const dir = resolveBuildDir(
      { slug: "x", buildDir: "/other/build/x" },
      () => {
        throw new Error(
          "detectRepoRoot must not be called for an explicit path",
        )
      },
    )
    expect(dir).toBe("/other/build/x")
  })
})

describe("deriveLiveness", () => {
  test("unknown when mtime is null", () => {
    expect(deriveLiveness(null, 1000)).toBe("unknown")
  })

  test("live within the threshold", () => {
    const now = 1_000_000
    expect(deriveLiveness(now - 5_000, now)).toBe("live")
  })

  test("stalled past the threshold", () => {
    const now = 1_000_000
    expect(deriveLiveness(now - 200_000, now)).toBe("stalled")
  })
})

describe("readLogMtime", () => {
  test("returns the file's mtime when the log exists", () => {
    const dir = makeTmp()
    const logPath = join(dir, "build.log")
    writeFileSync(logPath, "one\ntwo\nthree\n")
    expect(typeof readLogMtime(logPath)).toBe("number")
  })

  test("returns null when the log is absent", () => {
    const dir = makeTmp()
    expect(readLogMtime(join(dir, "build.log"))).toBeNull()
  })
})

describe("readDashboardSnapshot", () => {
  test("a directory not under any repo build/ is read directly when passed", () => {
    const dir = makeTmp()
    writeFileSync(join(dir, "state.json"), JSON.stringify(validState()))
    const snap = readDashboardSnapshot(dir, "herdr-build-monitor")
    expect(snap.dirExists).toBe(true)
    expect(snap.state?.phase).toBe("build")
  })

  test("empty dir → starting up (dirExists, no state, all flags false)", () => {
    const dir = makeTmp()
    const snap = readDashboardSnapshot(dir, "x")
    expect(snap.dirExists).toBe(true)
    expect(snap.state).toBeNull()
    expect(snap.specExists).toBe(false)
    expect(snap.needsInput).toBe(false)
    expect(snap.validateFailures).toBe(false)
  })

  test("missing dir → dirExists false, no throw", () => {
    const snap = readDashboardSnapshot("/no/such/dir/anywhere", "x")
    expect(snap.dirExists).toBe(false)
    expect(snap.state).toBeNull()
  })

  test("only spec.md → specExists true, state null", () => {
    const dir = makeTmp()
    writeFileSync(join(dir, "spec.md"), "# spec")
    const snap = readDashboardSnapshot(dir, "x")
    expect(snap.specExists).toBe(true)
    expect(snap.state).toBeNull()
  })

  test("valid state.json with linearIssueId is parsed", () => {
    const dir = makeTmp()
    writeFileSync(
      join(dir, "state.json"),
      JSON.stringify(validState({ linearIssueId: "PRO-493" })),
    )
    const snap = readDashboardSnapshot(dir, "x")
    expect(snap.state?.linearIssueId).toBe("PRO-493")
    expect(snap.stateError).toBeNull()
  })

  test("valid state.json without linearIssueId is parsed", () => {
    const dir = makeTmp()
    writeFileSync(join(dir, "state.json"), JSON.stringify(validState()))
    const snap = readDashboardSnapshot(dir, "x")
    expect(snap.state?.linearIssueId).toBeUndefined()
    expect(snap.state?.phase).toBe("build")
  })

  test("corrupt state.json → state null + stateError, no throw", () => {
    const dir = makeTmp()
    writeFileSync(join(dir, "state.json"), "{ not valid json")
    const snap = readDashboardSnapshot(dir, "x")
    expect(snap.state).toBeNull()
    expect(snap.stateError).not.toBeNull()
  })

  test("partial state.json (schema mismatch) → state null + stateError", () => {
    const dir = makeTmp()
    writeFileSync(join(dir, "state.json"), JSON.stringify({ feature: "x" }))
    const snap = readDashboardSnapshot(dir, "x")
    expect(snap.state).toBeNull()
    expect(snap.stateError).not.toBeNull()
  })

  test("NEEDS-INPUT.md and validate-failures.md presence sets flags", () => {
    const dir = makeTmp()
    writeFileSync(join(dir, "NEEDS-INPUT.md"), "help")
    writeFileSync(join(dir, "validate-failures.md"), "fail")
    const snap = readDashboardSnapshot(dir, "x")
    expect(snap.needsInput).toBe(true)
    expect(snap.validateFailures).toBe(true)
  })
})

describe("wrapSummary", () => {
  test("returns [] for empty/whitespace-only input", () => {
    expect(wrapSummary("", 40, 2)).toEqual([])
    expect(wrapSummary("   \n  ", 40, 2)).toEqual([])
  })

  test("every line is ≤ columns for normal multi-word overflow", () => {
    const lines = wrapSummary(
      "the quick brown fox jumps over the lazy dog repeatedly",
      20,
      2,
    )
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(20)
  })

  test("hard-splits a single word longer than the terminal width", () => {
    const lines = wrapSummary("x".repeat(200), 40, 2)
    expect(lines.length).toBe(2)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(40)
    // content was dropped → last kept line ends in …
    expect(lines[lines.length - 1]).toMatch(/…$/)
  })

  test("appends … only when content overflows maxLines", () => {
    const fits = wrapSummary("short summary", 40, 2)
    expect(fits.join(" ")).toContain("short summary")
    expect(fits.some((l) => l.endsWith("…"))).toBe(false)
  })

  test("normalizes columns of 0/negative to ≥ 1 without looping", () => {
    expect(wrapSummary("hello world", 0, 2).every((l) => l.length <= 1)).toBe(
      true,
    )
    expect(wrapSummary("hello world", -5, 2).every((l) => l.length <= 1)).toBe(
      true,
    )
  })
})

describe("renderDashboard", () => {
  const nowMs = Date.parse("2026-06-18T00:00:00.000Z")

  function snap(over: Partial<Parameters<typeof renderDashboard>[0]> = {}) {
    return {
      slug: "herdr-build-monitor",
      dirExists: true,
      state: validState(),
      stateError: null,
      specExists: true,
      needsInput: false,
      validateFailures: false,
      logMtimeMs: nowMs - 1000,
      ...over,
    }
  }

  test("renders the mono build path breadcrumb", () => {
    const out = renderDashboard(snap(), { nowMs })
    expect(out).toContain("build/herdr-build-monitor/")
  })

  test("emphasizes the current phase within the full pipeline", () => {
    const out = renderDashboard(snap(), { nowMs })
    expect(out).toContain("plan")
    expect(out).toContain("validate")
    expect(out).toContain("monitor")
    // current phase ("build") is marked
    expect(out).toMatch(/\[build\]/)
  })

  test("blocked status is prominent", () => {
    const out = renderDashboard(
      snap({ state: validState({ status: "blocked" }) }),
      { nowMs },
    )
    expect(out.toLowerCase()).toContain("blocked")
  })

  test("failed status is prominent", () => {
    const out = renderDashboard(
      snap({ state: validState({ status: "failed" }) }),
      { nowMs },
    )
    expect(out.toLowerCase()).toContain("failed")
  })

  test("needsInput renders a banner", () => {
    const out = renderDashboard(snap({ needsInput: true }), { nowMs })
    expect(out).toContain("NEEDS INPUT")
  })

  test("starting-up text when state is null but spec exists", () => {
    const out = renderDashboard(snap({ state: null, specExists: true }), {
      nowMs,
    })
    expect(out.toLowerCase()).toContain("starting up")
  })

  test("waiting-for-directory text when dir does not exist", () => {
    const out = renderDashboard(
      snap({ state: null, dirExists: false, specExists: false }),
      { nowMs },
    )
    expect(out.toLowerCase()).toContain("waiting for build directory")
  })

  test("state-unreadable note when stateError is set", () => {
    const out = renderDashboard(snap({ state: null, stateError: "bad json" }), {
      nowMs,
    })
    expect(out.toLowerCase()).toContain("unreadable")
  })

  test("branch and linearIssueId shown; no bold kebab feature line or dim linear line", () => {
    const out = renderDashboard(
      snap({ state: validState({ linearIssueId: "PRO-493" }) }),
      { nowMs },
    )
    expect(out).toContain("kickoff/pro-493-herdr-build-monitor")
    // Linear ref now appears via the prominent link, not the old dim `linear <id>` line
    expect(out).toContain("PRO-493")
    expect(out).not.toContain("linear PRO-493")
    // the kebab `feature` token is no longer its own line; the heading owns it
    expect(out).toContain("▸ PRO-493")
  })

  test("absent linearIssueId does not crash and is omitted", () => {
    const out = renderDashboard(snap(), { nowMs })
    expect(out).not.toContain("PRO-493")
    expect(out).not.toContain("▸ PRO")
  })

  test("Linear title is the primary heading when present", () => {
    const out = renderDashboard(
      snap({
        state: validState({
          linearTitle: "Redesign the build dashboard header",
        }),
      }),
      { nowMs },
    )
    expect(out).toContain("Redesign the build dashboard header")
  })

  test("falls back to feature/slug heading when no linearTitle", () => {
    const out = renderDashboard(
      snap({ state: validState({ feature: "herdr-build-monitor" }) }),
      { nowMs },
    )
    expect(out).toContain("herdr-build-monitor")
  })

  test("summary is shown when present and omitted when absent", () => {
    const withSummary = renderDashboard(
      snap({
        state: validState({
          linearSummary: "Reorient the header around a human title.",
        }),
      }),
      { nowMs },
    )
    expect(withSummary).toContain("Reorient the header around a human title.")
    // no summary → no broken/empty summary artifacts; heading still present
    const noSummary = renderDashboard(snap(), { nowMs })
    expect(noSummary).toContain("herdr-build-monitor")
  })

  test("prominent Linear link with URL uses the same ▸ prefix as the PR link", () => {
    const out = renderDashboard(
      snap({
        state: validState({
          linearIssueId: "PRO-507",
          linearUrl: "https://linear.app/dispatch/issue/PRO-507",
        }),
      }),
      { nowMs },
    )
    expect(out).toContain("PRO-507")
    expect(out).toContain("https://linear.app/dispatch/issue/PRO-507")
    expect(out).toContain("▸ PRO-507")
  })

  test("Linear ref shown without a broken empty URL when linearUrl is absent", () => {
    const out = renderDashboard(
      snap({ state: validState({ linearIssueId: "PRO-507" }) }),
      { nowMs },
    )
    expect(out).toContain("▸ PRO-507")
    expect(out).not.toContain("https://linear.app")
  })

  test("no Linear link when neither id nor url present", () => {
    const out = renderDashboard(snap(), { nowMs })
    expect(out).not.toContain("▸ PRO")
    expect(out).not.toContain("https://linear.app")
  })

  test("prominent PR link with number is rendered when prUrl is present", () => {
    const out = renderDashboard(
      snap({
        state: validState({
          prNumber: 595,
          prUrl: "https://github.com/dispatch/dispatch/pull/595",
        }),
      }),
      { nowMs },
    )
    expect(out).toContain("https://github.com/dispatch/dispatch/pull/595")
    expect(out).toContain("#595")
  })

  test("no PR line when prUrl is absent (back-compat)", () => {
    const out = renderDashboard(snap(), { nowMs })
    expect(out).not.toContain("https://github.com/")
    expect(out).not.toContain("▸ PR")
  })

  test("reviewRound > 0 is surfaced", () => {
    const out = renderDashboard(
      snap({ state: validState({ phase: "review", reviewRound: 2 }) }),
      { nowMs },
    )
    expect(out).toContain("2")
    expect(out.toLowerCase()).toContain("review round")
  })

  test("validateFailures is surfaced", () => {
    const out = renderDashboard(snap({ validateFailures: true }), { nowMs })
    expect(out.toLowerCase()).toContain("validate")
  })

  test("never throws on a fully-null snapshot", () => {
    expect(() =>
      renderDashboard(
        {
          slug: "x",
          dirExists: false,
          state: null,
          stateError: null,
          specExists: false,
          needsInput: false,
          validateFailures: false,
          logMtimeMs: null,
        },
        { nowMs },
      ),
    ).not.toThrow()
  })

  test("e2e needed reads running at validate, done at review, pending at plan", () => {
    const decl = { e2e: { needed: true, rationale: "x" } }
    const atValidate = renderDashboard(
      snap({ state: validState({ phase: "validate", optionalSteps: decl }) }),
      { nowMs },
    )
    expect(atValidate).toContain("e2e — running")
    const atReview = renderDashboard(
      snap({ state: validState({ phase: "review", optionalSteps: decl }) }),
      { nowMs },
    )
    expect(atReview).toContain("e2e — done")
    const atPlan = renderDashboard(
      snap({ state: validState({ phase: "plan", optionalSteps: decl }) }),
      { nowMs },
    )
    expect(atPlan).toContain("e2e — pending")
  })

  test("e2e not-needed reads skipped (not needed)", () => {
    const out = renderDashboard(
      snap({
        state: validState({
          phase: "validate",
          optionalSteps: { e2e: { needed: false, rationale: "x" } },
        }),
      }),
      { nowMs },
    )
    expect(out).toContain("e2e — skipped (not needed)")
  })

  test("forced off reads skipped (forced off)", () => {
    const out = renderDashboard(
      snap({
        state: validState({
          phase: "validate",
          optionalSteps: { e2e: { needed: true, rationale: "x" } },
          optionalStepOverrides: { e2e: "off" },
        }),
      }),
      { nowMs },
    )
    expect(out).toContain("e2e — skipped (forced off)")
  })

  test("a state without optionalSteps renders e2e per the fail-safe (not skipped)", () => {
    const out = renderDashboard(
      snap({ state: validState({ phase: "validate" }) }),
      { nowMs },
    )
    expect(out).toContain("e2e — running")
    expect(out).not.toContain("skipped")
  })

  test("evals needed reads running at validate, done at review, pending at plan", () => {
    const decl = {
      e2e: { needed: false, rationale: "x" },
      evals: { needed: true, rationale: "y" },
    }
    expect(
      renderDashboard(
        snap({ state: validState({ phase: "validate", optionalSteps: decl }) }),
        { nowMs },
      ),
    ).toContain("evals — running")
    expect(
      renderDashboard(
        snap({ state: validState({ phase: "review", optionalSteps: decl }) }),
        { nowMs },
      ),
    ).toContain("evals — done")
    expect(
      renderDashboard(
        snap({ state: validState({ phase: "plan", optionalSteps: decl }) }),
        { nowMs },
      ),
    ).toContain("evals — pending")
  })

  test("evals not-needed reads skipped (not needed)", () => {
    const out = renderDashboard(
      snap({
        state: validState({
          phase: "validate",
          optionalSteps: {
            e2e: { needed: false, rationale: "x" },
            evals: { needed: false, rationale: "y" },
          },
        }),
      }),
      { nowMs },
    )
    expect(out).toContain("evals — skipped (not needed)")
  })

  test("evals forced off reads skipped (forced off)", () => {
    const out = renderDashboard(
      snap({
        state: validState({
          phase: "validate",
          optionalSteps: { evals: { needed: true, rationale: "y" } },
          optionalStepOverrides: { evals: "off" },
        }),
      }),
      { nowMs },
    )
    expect(out).toContain("evals — skipped (forced off)")
  })
})

describe("renderOptionalStepLine", () => {
  test("each status maps to expected glyph + text", () => {
    expect(renderOptionalStepLine({ id: "e2e", status: "running" })).toContain(
      "● e2e — running",
    )
    expect(renderOptionalStepLine({ id: "e2e", status: "done" })).toContain(
      "● e2e — done",
    )
    expect(renderOptionalStepLine({ id: "e2e", status: "pending" })).toContain(
      "○ e2e — pending",
    )
    expect(
      renderOptionalStepLine({
        id: "e2e",
        status: "skipped",
        reason: "not needed",
      }),
    ).toContain("○ e2e — skipped (not needed)")
  })

  test("renders the evals step id", () => {
    expect(
      renderOptionalStepLine({ id: "evals", status: "running" }),
    ).toContain("● evals — running")
    expect(renderOptionalStepLine({ id: "evals", status: "done" })).toContain(
      "● evals — done",
    )
    expect(
      renderOptionalStepLine({ id: "evals", status: "pending" }),
    ).toContain("○ evals — pending")
    expect(
      renderOptionalStepLine({
        id: "evals",
        status: "skipped",
        reason: "forced off",
      }),
    ).toContain("○ evals — skipped (forced off)")
  })
})

describe("renderDashboard auto-merge", () => {
  const nowMs = Date.parse("2026-06-18T00:00:00.000Z")

  function snap() {
    return {
      slug: "herdr-build-monitor",
      dirExists: true,
      state: validState({
        prNumber: 595,
        prUrl: "https://github.com/dispatch/dispatch/pull/595",
      }),
      stateError: null,
      specExists: true,
      needsInput: false,
      validateFailures: false,
      logMtimeMs: nowMs - 1000,
    }
  }

  function am(over: Partial<AutoMergeView> = {}): AutoMergeView {
    return {
      prKnown: true,
      state: "off",
      toggleBusy: false,
      notice: null,
      toggleAvailable: true,
      pending: false,
      armAvailable: false,
      applyError: null,
      ...over,
    }
  }

  test("omitting opts.autoMerge renders no auto-merge content (back-compat)", () => {
    const out = renderDashboard(snap(), { nowMs })
    expect(out).not.toContain("auto-merge")
  })

  test("prKnown false renders neutral n/a, never a false On/Off", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({ prKnown: false, state: null, toggleAvailable: false }),
    })
    expect(out).toContain("auto-merge — n/a")
    expect(out).not.toContain("auto-merge: On")
    expect(out).not.toContain("auto-merge: Off")
  })

  test("pending && !prKnown renders a distinct Pending indicator, not n/a/On/Off", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({ prKnown: false, state: null, pending: true }),
    })
    expect(out).toContain("auto-merge: Pending")
    expect(out).not.toContain("auto-merge — n/a")
    expect(out).not.toContain("auto-merge: On")
    expect(out).not.toContain("auto-merge: Off")
  })

  test("pending && prKnown (build-side applying) still renders Pending", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({ prKnown: true, state: "off", pending: true }),
    })
    expect(out).toContain("auto-merge: Pending")
  })

  test("a failed apply renders a red notice on the Pending line", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({
        prKnown: true,
        pending: true,
        applyError: "couldn't enable (branch protection?)",
      }),
    })
    expect(out).toContain("auto-merge: Pending")
    expect(out).toContain("couldn't enable (branch protection?)")
    // Rendered red (error styling) — the same ESC[31m marker the panel uses.
    expect(out).toContain("\x1b[31mcouldn't enable (branch protection?)")
  })

  test("a user transient wins over applyError on the Pending line", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({
        pending: true,
        notice: "auto-merge disarmed",
        applyError: "couldn't enable (branch protection?)",
      }),
    })
    // Dim info notice, not the red apply-error (precedence notice ?? applyError).
    expect(out).toContain("auto-merge disarmed")
    expect(out).not.toContain("couldn't enable (branch protection?)")
  })

  test("applyError does not leak into a live (non-pending) branch", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({
        pending: false,
        prKnown: true,
        state: "off",
        applyError: "couldn't enable (branch protection?)",
      }),
    })
    expect(out).not.toContain("couldn't enable (branch protection?)")
  })

  test("armAvailable && !prKnown && !pending shows the arm hint", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({
        prKnown: false,
        state: null,
        pending: false,
        armAvailable: true,
      }),
    })
    expect(out).toContain("a — arm auto-merge")
  })

  test("pending && armAvailable shows the disarm hint", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({ pending: true, armAvailable: true }),
    })
    expect(out).toContain("a — disarm auto-merge")
  })

  test("prKnown false: an 'auto-merge armed' info notice renders dim, a save-failure renders red", () => {
    const armed = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({
        prKnown: false,
        state: null,
        pending: true,
        notice: "auto-merge armed",
      }),
    })
    expect(armed).toContain("auto-merge armed")
    expect(armed).not.toContain("\x1b[31mauto-merge armed")
    const failed = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({
        prKnown: false,
        state: null,
        notice: "couldn't save auto-merge intent",
      }),
    })
    expect(failed).toContain("\x1b[31mcouldn't save auto-merge intent")
  })

  test("state null with a PR renders checking…", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({ state: null }),
    })
    expect(out).toContain("checking")
  })

  test("state on renders auto-merge: On", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({ state: "on" }),
    })
    expect(out).toContain("auto-merge: On")
  })

  test("state off renders auto-merge: Off", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({ state: "off" }),
    })
    expect(out).toContain("auto-merge: Off")
  })

  test("state unknown renders unknown, not a false Off", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({ state: "unknown" }),
    })
    expect(out).toContain("auto-merge: unknown")
    expect(out).not.toContain("auto-merge: Off")
  })

  test("toggleAvailable shows the keybinding hint", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({ toggleAvailable: true }),
    })
    expect(out).toContain("a — toggle auto-merge")
  })

  test("hint is suppressed when toggle is unavailable (non-TTY)", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({ toggleAvailable: false }),
    })
    expect(out).not.toContain("a — toggle auto-merge")
  })

  test("a notice is surfaced", () => {
    const out = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({ notice: "enabling…" }),
    })
    expect(out).toContain("enabling…")
  })

  test("toggleBusy renders an ack suffix", () => {
    const plain = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({ state: "off", toggleBusy: false }),
    })
    const busy = renderDashboard(snap(), {
      nowMs,
      autoMerge: am({ state: "off", toggleBusy: true }),
    })
    expect(busy).toContain("…")
    expect(busy).not.toBe(plain)
  })

  test("never throws on a partially-populated auto-merge view", () => {
    expect(() =>
      renderDashboard(snap(), {
        nowMs,
        autoMerge: {
          prKnown: true,
          state: null,
          toggleBusy: false,
          notice: null,
          toggleAvailable: false,
          pending: false,
          armAvailable: false,
          applyError: null,
        },
      }),
    ).not.toThrow()
  })
})

describe("renderDevServerLines", () => {
  function ds(over: Partial<DevServerView> = {}): DevServerView {
    return {
      controlsAvailable: false,
      status: "stopped",
      busy: false,
      notice: null,
      ...over,
    }
  }

  test("running renders a green running line", () => {
    expect(
      renderDevServerLines(ds({ status: "running" })).join("\n"),
    ).toContain("dev server: running")
  })

  test("starting / unreachable render their status", () => {
    expect(
      renderDevServerLines(ds({ status: "starting" })).join("\n"),
    ).toContain("starting")
    expect(
      renderDevServerLines(ds({ status: "unreachable" })).join("\n"),
    ).toContain("unreachable")
  })

  test("stopped renders a calm stopped line", () => {
    expect(
      renderDevServerLines(ds({ status: "stopped" })).join("\n"),
    ).toContain("dev server: stopped")
  })

  test("null status renders a neutral checking…", () => {
    expect(renderDevServerLines(ds({ status: null })).join("\n")).toContain(
      "checking",
    )
  })

  test("controlsAvailable shows the s/x/r hint; hidden otherwise", () => {
    expect(
      renderDevServerLines(ds({ controlsAvailable: true })).join("\n"),
    ).toContain("s — start")
    expect(
      renderDevServerLines(ds({ controlsAvailable: false })).join("\n"),
    ).not.toContain("s — start")
  })

  test("busy renders an ack suffix", () => {
    const plain = renderDevServerLines(ds({ busy: false })).join("\n")
    const busy = renderDevServerLines(ds({ busy: true })).join("\n")
    expect(busy).not.toBe(plain)
    expect(busy).toContain("…")
  })

  test("a notice is surfaced", () => {
    expect(
      renderDevServerLines(ds({ notice: "starting…" })).join("\n"),
    ).toContain("starting…")
  })
})

describe("renderDashboard dev-login URLs", () => {
  const nowMs = Date.parse("2026-06-18T00:00:00.000Z")
  function snap(state: BuildState | null) {
    return {
      slug: "feat",
      dirExists: true,
      state,
      stateError: null,
      specExists: true,
      needsInput: false,
      validateFailures: false,
      logMtimeMs: nowMs - 1000,
    }
  }

  test("renders both dev-login URLs (plain + comped) from state.devUrl", () => {
    const out = renderDashboard(
      snap(validState({ devUrl: "https://feat.dispatch.localhost" })),
      { nowMs },
    )
    expect(out).toContain("https://feat.dispatch.localhost/api/auth/dev-login")
    expect(out).toContain(
      "https://feat.dispatch.localhost/api/auth/dev-login?comp=1",
    )
  })

  test("renders no dev-login URL when devUrl is unset", () => {
    const out = renderDashboard(snap(validState()), { nowMs })
    expect(out).not.toContain("dev-login")
  })

  test("omitting opts.devServer renders no dev-server status (back-compat)", () => {
    const out = renderDashboard(snap(validState()), { nowMs })
    expect(out).not.toContain("dev server")
  })
})
