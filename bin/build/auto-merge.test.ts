import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  APPLY_ERROR_TTL_MS,
  type AutoMergeState,
  type AutoMergeView,
  applyAutoMergeToggle,
  applyErrorPath,
  applyKeystrokeToView,
  applyPendingAutoMerge,
  autoMergeDisableCommand,
  autoMergeEnableCommand,
  autoMergeReadCommand,
  clearApplyError,
  createAutoMergeCoordinator,
  decideKeystroke,
  decideToggleAction,
  endToggle,
  onReadComplete,
  onToggleFailed,
  onToggleStart,
  type PendingApplyDeps,
  parseApplyError,
  parseAutoMergeState,
  parsePendingIntent,
  pendingIntentPath,
  readApplyError,
  readAutoMergeState,
  readPendingIntent,
  resolveApplyError,
  serializeApplyError,
  serializePendingIntent,
  tickView,
  writeApplyError,
  writePendingIntent,
} from "./auto-merge"
import type { ShResult } from "./repo"

function view(over: Partial<AutoMergeView> = {}): AutoMergeView {
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

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Yield long enough for queued microtasks + a resolved `async () => …` to run. */
const tick = () => new Promise((r) => setTimeout(r, 0))

/** Index helper that throws on a missing element (keeps tests free of `!`). */
function at<T>(arr: T[], i: number): T {
  const v = arr[i]
  if (v === undefined) throw new Error(`expected an element at index ${i}`)
  return v
}

const ok = (stdout: string): ShResult => ({ code: 0, stdout, stderr: "" })

describe("parseAutoMergeState", () => {
  test("non-null autoMergeRequest object → on", () => {
    expect(
      parseAutoMergeState({ autoMergeRequest: { mergeMethod: "SQUASH" } }),
    ).toBe("on")
  })

  test("explicit null autoMergeRequest → off", () => {
    expect(parseAutoMergeState({ autoMergeRequest: null })).toBe("off")
  })

  test("absent key → unknown (never a false off)", () => {
    expect(parseAutoMergeState({})).toBe("unknown")
  })

  test("non-object input → unknown", () => {
    expect(parseAutoMergeState(null)).toBe("unknown")
    expect(parseAutoMergeState("x")).toBe("unknown")
    expect(parseAutoMergeState(42)).toBe("unknown")
  })
})

describe("command builders", () => {
  test("read command keys on the pr number and asks for autoMergeRequest", () => {
    expect(autoMergeReadCommand(595)).toEqual([
      "gh",
      "pr",
      "view",
      "595",
      "--json",
      "autoMergeRequest",
    ])
  })

  test("enable command uses --auto --squash", () => {
    expect(autoMergeEnableCommand(595)).toEqual([
      "gh",
      "pr",
      "merge",
      "595",
      "--auto",
      "--squash",
    ])
  })

  test("disable command uses --disable-auto", () => {
    expect(autoMergeDisableCommand(595)).toEqual([
      "gh",
      "pr",
      "merge",
      "595",
      "--disable-auto",
    ])
  })
})

describe("decideToggleAction", () => {
  test("on → disable", () => {
    expect(decideToggleAction("on")).toBe("disable")
  })
  test("off → enable", () => {
    expect(decideToggleAction("off")).toBe("enable")
  })
  test("unknown → read-first (never guess)", () => {
    expect(decideToggleAction("unknown")).toBe("read-first")
  })
  test("null → read-first (never guess)", () => {
    expect(decideToggleAction(null)).toBe("read-first")
  })
})

describe("decideKeystroke", () => {
  test("a/A → toggle", () => {
    expect(decideKeystroke("a")).toBe("toggle")
    expect(decideKeystroke("A")).toBe("toggle")
  })
  test("ctrl-c/q → quit", () => {
    expect(decideKeystroke("\x03")).toBe("quit")
    expect(decideKeystroke("q")).toBe("quit")
  })
  test("anything else → none", () => {
    expect(decideKeystroke("x")).toBe("none")
  })
})

describe("readAutoMergeState (injectable async exec)", () => {
  test("exit 0 + explicit null → off", async () => {
    const exec = async () => ok('{"autoMergeRequest":null}')
    expect(await readAutoMergeState(1, "/cwd", exec)).toBe("off")
  })

  test("exit 0 + object → on", async () => {
    const exec = async () => ok('{"autoMergeRequest":{"mergeMethod":"SQUASH"}}')
    expect(await readAutoMergeState(1, "/cwd", exec)).toBe("on")
  })

  test("non-zero exit → unknown", async () => {
    const exec = async (): Promise<ShResult> => ({
      code: 1,
      stdout: "",
      stderr: "boom",
    })
    expect(await readAutoMergeState(1, "/cwd", exec)).toBe("unknown")
  })

  test("garbage stdout → unknown", async () => {
    const exec = async () => ok("not json")
    expect(await readAutoMergeState(1, "/cwd", exec)).toBe("unknown")
  })

  test("absent key → unknown", async () => {
    const exec = async () => ok("{}")
    expect(await readAutoMergeState(1, "/cwd", exec)).toBe("unknown")
  })

  test("rejected exec promise → unknown (no unhandled rejection)", async () => {
    const exec = async () => {
      throw new Error("ENOENT gh")
    }
    expect(await readAutoMergeState(1, "/cwd", exec)).toBe("unknown")
  })

  test("issues the read command with the pr number and cwd", async () => {
    const calls: Array<{ cmd: string[]; cwd: string }> = []
    const exec = async (cmd: string[], cwd: string) => {
      calls.push({ cmd, cwd })
      return ok('{"autoMergeRequest":null}')
    }
    await readAutoMergeState(595, "/work", exec)
    expect(at(calls, 0)).toEqual({
      cmd: autoMergeReadCommand(595),
      cwd: "/work",
    })
  })
})

describe("applyAutoMergeToggle", () => {
  test("enable issues the enable argv", async () => {
    const calls: string[][] = []
    const exec = async (cmd: string[]) => {
      calls.push(cmd)
      return ok("")
    }
    await applyAutoMergeToggle("enable", 595, "/cwd", exec)
    expect(at(calls, 0)).toEqual(autoMergeEnableCommand(595))
  })

  test("disable issues the disable argv", async () => {
    const calls: string[][] = []
    const exec = async (cmd: string[]) => {
      calls.push(cmd)
      return ok("")
    }
    await applyAutoMergeToggle("disable", 595, "/cwd", exec)
    expect(at(calls, 0)).toEqual(autoMergeDisableCommand(595))
  })

  test("returns the ShResult with non-zero code preserved", async () => {
    const exec = async (): Promise<ShResult> => ({
      code: 1,
      stdout: "",
      stderr: "protected branch",
    })
    const res = await applyAutoMergeToggle("enable", 1, "/cwd", exec)
    expect(res.code).toBe(1)
    expect(res.stderr).toContain("protected")
  })
})

describe("applyKeystrokeToView", () => {
  test("a with no PR, not pending → arm, notice 'auto-merge armed'", () => {
    const { next, effect } = applyKeystrokeToView(
      view({ prKnown: false, pending: false }),
      "a",
    )
    expect(effect).toBe("arm")
    expect(next.pending).toBe(true)
    expect(next.notice).toBe("auto-merge armed")
  })

  test("a while pending → disarm (pre-PR and post-PR)", () => {
    for (const prKnown of [false, true]) {
      const { next, effect } = applyKeystrokeToView(
        view({ prKnown, pending: true }),
        "a",
      )
      expect(effect).toBe("disarm")
      expect(next.pending).toBe(false)
      expect(next.notice).toBe("auto-merge disarmed")
    }
  })

  test("a while a toggle is in flight → none even when pending (overlap guard)", () => {
    const v = view({ pending: true, toggleBusy: true })
    const { next, effect } = applyKeystrokeToView(v, "a")
    expect(effect).toBe("none")
    expect(next).toBe(v)
  })

  test("a with a PR, not pending → existing toggle path (effect toggle)", () => {
    const { effect } = applyKeystrokeToView(
      view({ prKnown: true, pending: false, state: "off" }),
      "a",
    )
    expect(effect).toBe("toggle")
  })

  test("a with state off → toggle, busy, 'enabling…'", () => {
    const { next, effect } = applyKeystrokeToView(view({ state: "off" }), "a")
    expect(effect).toBe("toggle")
    expect(next.toggleBusy).toBe(true)
    expect(next.notice).toBe("enabling…")
  })

  test("a with state on → toggle, busy, 'disabling…'", () => {
    const { next, effect } = applyKeystrokeToView(view({ state: "on" }), "a")
    expect(effect).toBe("toggle")
    expect(next.toggleBusy).toBe(true)
    expect(next.notice).toBe("disabling…")
  })

  test("a with unknown/null state → toggle, busy, 'checking auto-merge…'", () => {
    for (const state of ["unknown", null] as const) {
      const { next, effect } = applyKeystrokeToView(view({ state }), "a")
      expect(effect).toBe("toggle")
      expect(next.toggleBusy).toBe(true)
      expect(next.notice).toBe("checking auto-merge…")
    }
  })

  test("a while a toggle is in flight → none, view unchanged (overlap guard)", () => {
    const v = view({ state: "off", toggleBusy: true })
    const { next, effect } = applyKeystrokeToView(v, "a")
    expect(effect).toBe("none")
    expect(next).toBe(v)
  })

  test("ctrl-c and q → quit", () => {
    expect(applyKeystrokeToView(view(), "\x03").effect).toBe("quit")
    expect(applyKeystrokeToView(view(), "q").effect).toBe("quit")
  })

  test("unrelated key → none, view unchanged", () => {
    const v = view()
    const { next, effect } = applyKeystrokeToView(v, "x")
    expect(effect).toBe("none")
    expect(next).toBe(v)
  })
})

describe("view reducers", () => {
  test("onReadComplete sets state, leaves toggleBusy untouched", () => {
    const next = onReadComplete(view({ state: "on", toggleBusy: true }), "off")
    expect(next.state).toBe("off")
    expect(next.toggleBusy).toBe(true)
  })

  test("onReadComplete clears a transient checking notice only", () => {
    expect(
      onReadComplete(view({ notice: "checking auto-merge…" }), "on").notice,
    ).toBeNull()
    expect(onReadComplete(view({ notice: "enabling…" }), "on").notice).toBe(
      "enabling…",
    )
  })

  test("onToggleStart sets busy + progress notice", () => {
    const next = onToggleStart(view(), "enable")
    expect(next.toggleBusy).toBe(true)
    expect(next.notice).toBe("enabling…")
  })

  test("onToggleFailed sets an error notice and never flips state", () => {
    const next = onToggleFailed(
      view({ state: "off" }),
      "couldn't enable (branch protection?)",
    )
    expect(next.state).toBe("off")
    expect(next.notice).toBe("couldn't enable (branch protection?)")
  })

  test("endToggle clears a progress notice", () => {
    const next = endToggle(view({ toggleBusy: true, notice: "enabling…" }))
    expect(next.toggleBusy).toBe(false)
    expect(next.notice).toBeNull()
  })

  test("endToggle preserves an error notice", () => {
    const next = endToggle(
      view({
        toggleBusy: true,
        notice: "couldn't enable (branch protection?)",
      }),
    )
    expect(next.toggleBusy).toBe(false)
    expect(next.notice).toBe("couldn't enable (branch protection?)")
  })

  test("tickView clears a transient arm/disarm notice only when clearTransientNotice is set", () => {
    const next = tickView(
      view({ notice: "auto-merge armed", prKnown: false }),
      {
        prKnown: false,
        toggleAvailable: false,
        clearTransientNotice: true,
      },
    )
    expect(next.notice).toBeNull()
    expect(next.prKnown).toBe(false)
    expect(next.toggleAvailable).toBe(false)
  })

  test("tickView preserves a transient notice while clearTransientNotice is false", () => {
    const next = tickView(
      view({ notice: "auto-merge disarmed", prKnown: false }),
      {
        prKnown: false,
        toggleAvailable: false,
        clearTransientNotice: false,
      },
    )
    expect(next.notice).toBe("auto-merge disarmed")
  })

  test("tickView never clears a 'couldn't save' error notice even when the flag is set", () => {
    const next = tickView(
      view({ notice: "couldn't save auto-merge intent", prKnown: false }),
      { prKnown: false, toggleAvailable: false, clearTransientNotice: true },
    )
    expect(next.notice).toBe("couldn't save auto-merge intent")
  })
})

describe("pending marker: pure helpers", () => {
  test("pendingIntentPath points at .build/auto-merge-pending.json", () => {
    expect(pendingIntentPath("/b/dir")).toBe(
      "/b/dir/.build/auto-merge-pending.json",
    )
  })

  test("parsePendingIntent is tolerant", () => {
    expect(parsePendingIntent('{"pending":true}')).toBe(true)
    expect(parsePendingIntent('{"pending":false}')).toBe(false)
    expect(parsePendingIntent("{}")).toBe(false)
    expect(parsePendingIntent("not json")).toBe(false)
    expect(parsePendingIntent('{"pending":"true"}')).toBe(false)
  })

  test("serializePendingIntent round-trips through parsePendingIntent", () => {
    expect(parsePendingIntent(serializePendingIntent(true))).toBe(true)
    expect(parsePendingIntent(serializePendingIntent(false))).toBe(false)
  })
})

describe("apply-error: pure helpers", () => {
  test("applyErrorPath points at .build/auto-merge-apply-error.json", () => {
    expect(applyErrorPath("/b/dir")).toBe(
      "/b/dir/.build/auto-merge-apply-error.json",
    )
  })

  test("parseApplyError is tolerant", () => {
    expect(parseApplyError('{"detail":"x","atMs":123}')).toEqual({
      detail: "x",
      atMs: 123,
    })
    expect(parseApplyError('{"detail":"x"}')).toBeNull()
    expect(parseApplyError('{"atMs":1}')).toBeNull()
    expect(parseApplyError('{"detail":1,"atMs":1}')).toBeNull()
    expect(parseApplyError('{"detail":"x","atMs":"1"}')).toBeNull()
    expect(parseApplyError("garbage")).toBeNull()
  })

  test("serializeApplyError round-trips through parseApplyError", () => {
    expect(parseApplyError(serializeApplyError("boom", 42))).toEqual({
      detail: "boom",
      atMs: 42,
    })
  })

  test("resolveApplyError honors the display TTL", () => {
    expect(resolveApplyError({ detail: "x", atMs: 1000 }, 1000)).toBe("x")
    expect(
      resolveApplyError({ detail: "x", atMs: 0 }, APPLY_ERROR_TTL_MS + 1),
    ).toBeNull()
    expect(resolveApplyError(null, 5)).toBeNull()
  })
})

describe("pending marker + apply-error: fs IO", () => {
  let dir: string
  function fresh(): string {
    return mkdtempSync(join(tmpdir(), "am-marker-"))
  }

  test("writePendingIntent(true) then readPendingIntent → true; false removes it", () => {
    dir = fresh()
    try {
      expect(readPendingIntent(dir)).toBe(false) // fresh dir
      writePendingIntent(dir, true)
      expect(readPendingIntent(dir)).toBe(true)
      writePendingIntent(dir, false)
      expect(readPendingIntent(dir)).toBe(false)
      // Removing an already-absent marker does not throw.
      expect(() => writePendingIntent(dir, false)).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("writeApplyError then readApplyError → object; clearApplyError removes it", () => {
    dir = fresh()
    try {
      expect(readApplyError(dir)).toBeNull() // fresh dir
      writeApplyError(dir, "boom", 42)
      expect(readApplyError(dir)).toEqual({ detail: "boom", atMs: 42 })
      clearApplyError(dir)
      expect(readApplyError(dir)).toBeNull()
      // Clearing an already-absent file does not throw.
      expect(() => clearApplyError(dir)).not.toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("applyPendingAutoMerge", () => {
  /** Build spy deps with sensible defaults; override per case. */
  function makeDeps(over: Partial<PendingApplyDeps> = {}): {
    deps: PendingApplyDeps
    logs: string[]
    calls: Record<string, number>
    recorded: string[]
  } {
    const logs: string[] = []
    const recorded: string[] = []
    const calls = {
      readPending: 0,
      clearPending: 0,
      enable: 0,
      confirmState: 0,
      recordApplyError: 0,
      clearApplyError: 0,
    }
    const deps: PendingApplyDeps = {
      readPending: () => {
        calls.readPending++
        return true
      },
      clearPending: () => {
        calls.clearPending++
      },
      enable: () => {
        calls.enable++
        return ok("")
      },
      confirmState: () => {
        calls.confirmState++
        return "on"
      },
      recordApplyError: (d) => {
        calls.recordApplyError++
        recorded.push(d)
      },
      clearApplyError: () => {
        calls.clearApplyError++
      },
      log: (m) => logs.push(m),
      ...over,
    }
    return { deps, logs, calls, recorded }
  }

  test("not-pending → no gh call; clears any stale error notice", () => {
    const { deps, calls } = makeDeps({ readPending: () => false })
    expect(applyPendingAutoMerge(deps)).toBe("not-pending")
    expect(calls.enable).toBe(0)
    expect(calls.clearPending).toBe(0)
    expect(calls.recordApplyError).toBe(0)
    expect(calls.clearApplyError).toBe(1)
  })

  test("applied (confirm on) → consumes marker, clears error, logs enabled", () => {
    const { deps, calls, logs } = makeDeps({ confirmState: () => "on" })
    expect(applyPendingAutoMerge(deps)).toBe("applied")
    expect(calls.clearPending).toBe(1)
    expect(calls.clearApplyError).toBe(1)
    expect(logs.join("\n")).toContain("enabled on the PR")
  })

  test("applied (instant-merge confirm off) → no false 'enabled' line", () => {
    const { deps, calls, logs } = makeDeps({ confirmState: () => "off" })
    expect(applyPendingAutoMerge(deps)).toBe("applied")
    expect(calls.clearPending).toBe(1)
    expect(calls.clearApplyError).toBe(1)
    const text = logs.join("\n")
    expect(text).toContain("merged instantly")
    expect(text).not.toContain("enabled on the PR")
  })

  test("applied (inconclusive confirm unknown) → logs inconclusive, not instant-merge", () => {
    const { deps, logs } = makeDeps({ confirmState: () => "unknown" })
    expect(applyPendingAutoMerge(deps)).toBe("applied")
    const text = logs.join("\n")
    expect(text).toMatch(/inconclusive|unknown/i)
    expect(text).not.toContain("merged instantly")
  })

  test("failed → records apply-error, keeps marker, logs retry", () => {
    const { deps, calls, logs, recorded } = makeDeps({
      enable: () => ({ code: 1, stdout: "", stderr: "not mergeable" }),
    })
    expect(applyPendingAutoMerge(deps)).toBe("failed")
    expect(calls.clearPending).toBe(0)
    expect(calls.recordApplyError).toBe(1)
    expect(calls.clearApplyError).toBe(0)
    expect(at(recorded, 0)).toMatch(/couldn't enable/)
    expect(logs.join("\n")).toMatch(/⚠ auto-merge.*will retry/)
  })

  test("failed then succeed across two passes (marker survives the failure)", () => {
    let armed = true
    const enableResults: ShResult[] = [
      { code: 1, stdout: "", stderr: "not mergeable" },
      ok(""),
    ]
    let enableIdx = 0
    const { deps, calls } = makeDeps({
      readPending: () => armed,
      clearPending: () => {
        armed = false
      },
      enable: () => at(enableResults, enableIdx++),
      confirmState: () => "on",
    })
    expect(applyPendingAutoMerge(deps)).toBe("failed")
    expect(armed).toBe(true) // marker survives → retried
    expect(applyPendingAutoMerge(deps)).toBe("applied")
    expect(armed).toBe(false) // consumed on success
    expect(calls.recordApplyError).toBe(1)
  })

  test("failure surfaces to a rendered panel notice end-to-end through the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "am-apply-"))
    try {
      writePendingIntent(dir, true)
      const deps: PendingApplyDeps = {
        readPending: () => readPendingIntent(dir),
        clearPending: () => writePendingIntent(dir, false),
        enable: () => ({ code: 1, stdout: "", stderr: "not mergeable" }),
        confirmState: () => "unknown",
        recordApplyError: (d) => writeApplyError(dir, d, 1000),
        clearApplyError: () => clearApplyError(dir),
        log: () => {},
      }
      expect(applyPendingAutoMerge(deps)).toBe("failed")
      expect(readPendingIntent(dir)).toBe(true) // marker remains armed for retry
      expect(resolveApplyError(readApplyError(dir), 1000)).not.toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("createAutoMergeCoordinator concurrency", () => {
  /** An IO whose reads are individually resolvable via a FIFO queue. */
  function makeIo(opts: { savePendingThrows?: boolean } = {}) {
    const readQueue: Array<ReturnType<typeof deferred<AutoMergeState>>> = []
    let toggleResult: ShResult = ok("")
    let toggleCalls = 0
    let lastToggleAction: "enable" | "disable" | null = null
    const savePendingCalls: boolean[] = []
    const io = {
      read: (): Promise<AutoMergeState> => {
        const d = deferred<AutoMergeState>()
        readQueue.push(d)
        return d.promise
      },
      toggle: async (action: "enable" | "disable"): Promise<ShResult> => {
        toggleCalls++
        lastToggleAction = action
        return toggleResult
      },
      savePending: (pending: boolean) => {
        savePendingCalls.push(pending)
        if (opts.savePendingThrows) throw new Error("disk full")
      },
    }
    return {
      io,
      readQueue,
      savePendingCalls,
      setToggleResult: (r: ShResult) => {
        toggleResult = r
      },
      get toggleCalls() {
        return toggleCalls
      },
      get lastToggleAction() {
        return lastToggleAction
      },
    }
  }

  test("(A/B) post-toggle confirm wins over an in-flight, then late, background read", async () => {
    const h = makeIo()
    const coord = createAutoMergeCoordinator(h.io, { now: () => 0 })
    coord.sync({ prKnown: true, toggleAvailable: true })

    // Seed state="off" via a completed initial refresh.
    const seed = coord.refresh(1, "/cwd")
    at(h.readQueue, 0).resolve("off")
    await seed
    expect(coord.getView().state).toBe("off")

    // A background refresh is launched and left in flight (read pending).
    const bg = coord.refresh(1, "/cwd")
    expect(h.readQueue.length).toBe(2) // index 1 pending

    // User toggles: keystroke ack then the async orchestration.
    coord.keystroke("a")
    const toggle = coord.handleToggle(1, "/cwd")
    await tick() // toggle command resolves, confirm read registers (index 2)
    expect(h.readQueue.length).toBe(3)
    at(h.readQueue, 2).resolve("on") // confirm read = the new truth
    await toggle
    expect(coord.getView().state).toBe("on")

    // The stale background read resolves LATE → must be discarded, not applied.
    at(h.readQueue, 1).resolve("off")
    await bg
    expect(coord.getView().state).toBe("on")
    expect(coord.getView().toggleBusy).toBe(false)
  })

  test("(C) a failed toggle leaves state unflipped, then confirm pulls truth", async () => {
    const h = makeIo()
    h.setToggleResult({
      code: 1,
      stdout: "",
      stderr: "branch protection prevents auto-merge",
    })
    const coord = createAutoMergeCoordinator(h.io, { now: () => 0 })
    coord.sync({ prKnown: true, toggleAvailable: true })

    const seed = coord.refresh(1, "/cwd")
    at(h.readQueue, 0).resolve("off")
    await seed

    coord.keystroke("a") // off → enable
    const toggle = coord.handleToggle(1, "/cwd")
    await tick() // failed toggle resolves, confirm read registers
    at(h.readQueue, 1).resolve("off") // GitHub truth: still off (never enabled)
    await toggle

    const v = coord.getView()
    expect(v.state).toBe("off") // never flipped to on by the failed command
    expect(v.toggleBusy).toBe(false)
    // Surfaces an action-specific, honest notice (stderr mentions protection) —
    // never a false flip to "on".
    expect(v.notice).toBe("couldn't enable (branch protection?)")
  })

  test("(D) read-first resolving unknown does not toggle", async () => {
    const h = makeIo()
    const coord = createAutoMergeCoordinator(h.io, { now: () => 0 })
    coord.sync({ prKnown: true, toggleAvailable: true })

    coord.keystroke("a") // state null → checking
    const toggle = coord.handleToggle(1, "/cwd")
    await tick() // read-first registers
    at(h.readQueue, 0).resolve("unknown")
    await toggle

    expect(h.toggleCalls).toBe(0)
    const v = coord.getView()
    expect(v.toggleBusy).toBe(false)
    expect(v.notice).toContain("unknown")
  })

  test("(D) read-first resolving off proceeds to enable then confirm", async () => {
    const h = makeIo()
    const coord = createAutoMergeCoordinator(h.io, { now: () => 0 })
    coord.sync({ prKnown: true, toggleAvailable: true })

    coord.keystroke("a") // state null → checking
    const toggle = coord.handleToggle(1, "/cwd")
    await tick() // read-first registers (index 0)
    at(h.readQueue, 0).resolve("off")
    await tick() // enable toggle resolves, confirm read registers (index 1)
    at(h.readQueue, 1).resolve("on")
    await toggle

    expect(h.lastToggleAction).toBe("enable")
    expect(coord.getView().state).toBe("on")
    expect(coord.getView().toggleBusy).toBe(false)
  })

  test("(E) keystroke during a toggle returns none and starts no second toggle", () => {
    const h = makeIo()
    const coord = createAutoMergeCoordinator(h.io, { now: () => 0 })
    coord.sync({ prKnown: true, toggleAvailable: true })
    coord.keystroke("a") // sets toggleBusy synchronously
    const effect = coord.keystroke("a")
    expect(effect).toBe("none")
  })

  test("pre-PR 'a' arms + the confirmation survives the next sync so a frame renders it", () => {
    let t = 0
    const h = makeIo()
    const coord = createAutoMergeCoordinator(h.io, { now: () => t })
    // No PR: the render loop syncs with prKnown:false every tick.
    coord.sync({ prKnown: false, toggleAvailable: false })
    // Watcher presses `a` before a PR exists → arms with brief feedback.
    expect(coord.keystroke("a")).toBe("arm")
    expect(coord.getView().pending).toBe(true)
    expect(coord.getView().notice).toBe("auto-merge armed")
    // The very next render tick syncs first; the confirmation must NOT be
    // clobbered before the frame is drawn (this was the e2e defect).
    t = 1000
    coord.sync({ prKnown: false, toggleAvailable: false })
    expect(coord.getView().notice).toBe("auto-merge armed")
    // The Pending indicator persists independent of the transient notice.
    expect(coord.getView().pending).toBe(true)
  })

  test("the arm confirmation notice self-clears after its brief TTL (indicator persists)", () => {
    let t = 0
    const h = makeIo()
    const coord = createAutoMergeCoordinator(h.io, { now: () => t })
    coord.sync({ prKnown: false, toggleAvailable: false })
    coord.keystroke("a")
    expect(coord.getView().notice).toBe("auto-merge armed")
    // Well past the TTL → the confirmation self-clears, but pending stays.
    t = 60_000
    coord.sync({ prKnown: false, toggleAvailable: false, pending: true })
    expect(coord.getView().notice).toBeNull()
    expect(coord.getView().pending).toBe(true)
  })

  test("a non-toggle keystroke with no PR arms nothing", () => {
    let t = 0
    const h = makeIo()
    const coord = createAutoMergeCoordinator(h.io, { now: () => t })
    coord.sync({ prKnown: false, toggleAvailable: false })
    // An unrelated key must not arm or set a notice.
    expect(coord.keystroke("x")).toBe("none")
    expect(coord.getView().pending).toBe(false)
    expect(coord.getView().notice).toBeNull()
    t = 1000
    coord.sync({ prKnown: false, toggleAvailable: false })
    expect(coord.getView().pending).toBe(false)
    expect(coord.getView().notice).toBeNull()
  })

  test("initialPending seeds view.pending", () => {
    const h = makeIo()
    const coord = createAutoMergeCoordinator(h.io, { initialPending: true })
    expect(coord.getView().pending).toBe(true)
  })

  test("persistPending success calls savePending once with view.pending", () => {
    const h = makeIo()
    const coord = createAutoMergeCoordinator(h.io, { now: () => 0 })
    coord.sync({ prKnown: false, toggleAvailable: false })
    coord.keystroke("a") // arm → view.pending = true
    coord.persistPending()
    expect(h.savePendingCalls).toEqual([true])
    expect(coord.getView().pending).toBe(true)
  })

  test("persistPending failure reverts the optimistic flip + shows an honest notice", () => {
    const h = makeIo({ savePendingThrows: true })
    const coord = createAutoMergeCoordinator(h.io, { now: () => 0 })
    coord.sync({ prKnown: false, toggleAvailable: false })
    coord.keystroke("a") // arm → optimistic pending = true
    expect(coord.getView().pending).toBe(true)
    coord.persistPending()
    expect(coord.getView().pending).toBe(false) // reverted to on-disk truth
    expect(coord.getView().notice).toBe("couldn't save auto-merge intent")
  })

  test("sync reconciles pending + applyError from the runner's per-tick inputs", () => {
    const h = makeIo()
    const coord = createAutoMergeCoordinator(h.io, { now: () => 0 })
    coord.sync({ prKnown: false, toggleAvailable: false })
    coord.keystroke("a") // arm → pending true (optimistic)
    // The marker was disarmed elsewhere → next sync flips pending false.
    coord.sync({ prKnown: false, toggleAvailable: false, pending: false })
    expect(coord.getView().pending).toBe(false)
    // applyError key present → set; then present-and-null → cleared.
    coord.sync({
      prKnown: false,
      toggleAvailable: false,
      pending: false,
      applyError: "boom",
    })
    expect(coord.getView().applyError).toBe("boom")
    coord.sync({
      prKnown: false,
      toggleAvailable: false,
      pending: false,
      applyError: null,
    })
    expect(coord.getView().applyError).toBeNull()
  })

  test("sync without an applyError key leaves view.applyError unchanged", () => {
    const h = makeIo()
    const coord = createAutoMergeCoordinator(h.io, { now: () => 0 })
    coord.sync({
      prKnown: false,
      toggleAvailable: false,
      applyError: "boom",
    })
    expect(coord.getView().applyError).toBe("boom")
    // Old-style call site with no applyError key → unchanged.
    coord.sync({ prKnown: false, toggleAvailable: false })
    expect(coord.getView().applyError).toBe("boom")
  })

  test("armAvailable is reconciled from sync", () => {
    const h = makeIo()
    const coord = createAutoMergeCoordinator(h.io, { now: () => 0 })
    coord.sync({ prKnown: false, toggleAvailable: false, armAvailable: true })
    expect(coord.getView().armAvailable).toBe(true)
  })

  test("dueForRefresh respects PR presence and the interval", () => {
    let t = 0
    const h = makeIo()
    const coord = createAutoMergeCoordinator(h.io, { now: () => t })
    expect(coord.dueForRefresh(5000)).toBe(false) // no PR yet
    coord.sync({ prKnown: true, toggleAvailable: true })
    expect(coord.dueForRefresh(5000)).toBe(false) // now == lastRead (0)
    t = 5000
    expect(coord.dueForRefresh(5000)).toBe(true)
  })
})
