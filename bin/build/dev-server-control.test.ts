import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type DevServerHandle,
  decideExternalServer,
  devServerStatus,
  ensureDevServerStarted,
  handleFilePath,
  killGroup,
  paneFilePath,
  paneRunCommand,
  parseHandle,
  parsePaneRef,
  readDevServerHandle,
  readDevServerPane,
  resolveDevUrl,
  restartDevServer,
  SCREENSHOT_CAPTURE_ENV_VAR,
  screenshotCaptureEnv,
  serializeHandle,
  stopDevServer,
  summarizeStatus,
  writeDevServerHandle,
} from "./dev-server-control"
import type { ShResult } from "./repo"

const ok: ShResult = { code: 0, stdout: "", stderr: "" }

describe("path helpers", () => {
  test("paneFilePath / handleFilePath nest under the build dir's .build/", () => {
    expect(paneFilePath("/r/build/feat")).toBe(
      "/r/build/feat/.build/dev-server-pane.json",
    )
    expect(handleFilePath("/r/build/feat")).toBe(
      "/r/build/feat/.build/dev-server-handle.json",
    )
  })
})

describe("serializeHandle / parseHandle", () => {
  const handle: DevServerHandle = {
    pid: 4242,
    pgid: 4242,
    devUrl: "https://x.dispatch.localhost",
    startedAt: "2026-06-25T00:00:00.000Z",
  }

  test("round-trips a handle", () => {
    expect(parseHandle(serializeHandle(handle))).toEqual(handle)
  })

  test("ends in a trailing newline", () => {
    expect(serializeHandle(handle).endsWith("}\n")).toBe(true)
  })

  test("returns null on unparseable JSON", () => {
    expect(parseHandle("not json")).toBeNull()
  })

  test("returns null on a missing/non-numeric pid or pgid", () => {
    expect(parseHandle(JSON.stringify({ pgid: 1, devUrl: "x" }))).toBeNull()
    expect(
      parseHandle(JSON.stringify({ pid: "1", pgid: 1, devUrl: "x" })),
    ).toBeNull()
    expect(parseHandle(JSON.stringify({ pid: 1, devUrl: "x" }))).toBeNull()
  })

  test("returns null on a missing devUrl", () => {
    expect(parseHandle(JSON.stringify({ pid: 1, pgid: 1 }))).toBeNull()
  })

  test("tolerates a missing startedAt (defaults to empty)", () => {
    const h = parseHandle(JSON.stringify({ pid: 1, pgid: 1, devUrl: "x" }))
    expect(h?.startedAt).toBe("")
  })
})

describe("parsePaneRef", () => {
  test("round-trips a full pane ref", () => {
    const ref = {
      paneId: "pane-1",
      workspaceId: "ws-1",
      worktreePath: "/wt",
    }
    expect(parsePaneRef(JSON.stringify(ref))).toEqual(ref)
  })

  test("returns null on unparseable JSON", () => {
    expect(parsePaneRef("{nope")).toBeNull()
  })

  test("returns null on a missing/empty paneId", () => {
    expect(parsePaneRef(JSON.stringify({ workspaceId: "ws-1" }))).toBeNull()
    expect(parsePaneRef(JSON.stringify({ paneId: "" }))).toBeNull()
  })

  test("tolerates absent optional metadata", () => {
    const ref = parsePaneRef(JSON.stringify({ paneId: "pane-1" }))
    expect(ref).toEqual({
      paneId: "pane-1",
      workspaceId: undefined,
      worktreePath: undefined,
    })
  })
})

describe("paneRunCommand", () => {
  test("builds the herdr pane run argv with the launcher command", () => {
    expect(
      paneRunCommand(
        { paneId: "pane-dev" },
        "/wt/bin/build/dev-server-control.ts",
        "/wt/build/feat",
      ),
    ).toEqual([
      "herdr",
      "pane",
      "run",
      "pane-dev",
      "bun run /wt/bin/build/dev-server-control.ts run /wt/build/feat",
    ])
  })
})

describe("killGroup", () => {
  test("signals the NEGATIVE pgid (the whole group)", () => {
    const calls: Array<[number, NodeJS.Signals]> = []
    killGroup(4242, "SIGTERM", (pid, sig) => calls.push([pid, sig]))
    expect(calls).toEqual([[-4242, "SIGTERM"]])
  })

  test("swallows a throw from kill (group already gone)", () => {
    expect(() =>
      killGroup(42, "SIGTERM", () => {
        throw Object.assign(new Error("no such process"), { code: "ESRCH" })
      }),
    ).not.toThrow()
  })

  test("no-ops on pgid <= 1 (never signals the caller's own group / all procs)", () => {
    const calls: number[] = []
    const spy = (pid: number) => calls.push(pid)
    killGroup(0, "SIGTERM", spy)
    killGroup(1, "SIGTERM", spy)
    killGroup(-5, "SIGTERM", spy)
    expect(calls).toEqual([])
  })
})

describe("decideExternalServer", () => {
  test("reachable → use", () => {
    expect(decideExternalServer(true)).toEqual({ kind: "use" })
  })

  test("unreachable → block with a self-serve reason", () => {
    const d = decideExternalServer(false)
    expect(d.kind).toBe("block")
    if (d.kind === "block") expect(d.reason).toMatch(/no dev server reachable/)
  })
})

describe("summarizeStatus", () => {
  test("reachable → running (regardless of handle)", () => {
    expect(
      summarizeStatus({
        handlePresent: false,
        pidAlive: false,
        reachable: true,
      }),
    ).toBe("running")
  })

  test("no handle, not reachable → stopped", () => {
    expect(
      summarizeStatus({
        handlePresent: false,
        pidAlive: false,
        reachable: false,
      }),
    ).toBe("stopped")
  })

  test("handle + live pid, not yet reachable → starting", () => {
    expect(
      summarizeStatus({
        handlePresent: true,
        pidAlive: true,
        reachable: false,
      }),
    ).toBe("starting")
  })

  test("handle but pid gone, not reachable → unreachable (crashed)", () => {
    expect(
      summarizeStatus({
        handlePresent: true,
        pidAlive: false,
        reachable: false,
      }),
    ).toBe("unreachable")
  })
})

describe("reads (round-trip on disk)", () => {
  let buildDir: string
  beforeEach(() => {
    buildDir = mkdtempSync(join(tmpdir(), "dev-control-"))
    mkdirSync(join(buildDir, ".build"), { recursive: true })
  })
  afterEach(() => {
    rmSync(buildDir, { recursive: true, force: true })
  })

  test("readDevServerPane returns null when absent", () => {
    expect(readDevServerPane(buildDir)).toBeNull()
  })

  test("readDevServerPane parses a written pane file", () => {
    writeFileSync(
      paneFilePath(buildDir),
      JSON.stringify({ paneId: "pane-dev", workspaceId: "ws-1" }),
    )
    expect(readDevServerPane(buildDir)?.paneId).toBe("pane-dev")
  })

  test("writeDevServerHandle + readDevServerHandle round-trip", () => {
    writeDevServerHandle(buildDir, {
      pid: 99,
      pgid: 99,
      devUrl: "https://x",
      startedAt: "t",
    })
    expect(readDevServerHandle(buildDir)?.pid).toBe(99)
  })

  test("readDevServerHandle returns null on a corrupt file", () => {
    writeFileSync(handleFilePath(buildDir), "garbage")
    expect(readDevServerHandle(buildDir)).toBeNull()
  })
})

describe("resolveDevUrl", () => {
  let buildDir: string
  beforeEach(() => {
    buildDir = mkdtempSync(join(tmpdir(), "dev-resolveurl-"))
  })
  afterEach(() => {
    rmSync(buildDir, { recursive: true, force: true })
  })

  test("prefers the persisted state.json devUrl", () => {
    writeFileSync(
      join(buildDir, "state.json"),
      JSON.stringify({ devUrl: "https://persisted.dispatch.localhost" }),
    )
    expect(resolveDevUrl(buildDir, {})).toBe(
      "https://persisted.dispatch.localhost",
    )
  })

  test("falls back to deriving from env + repo root when devUrl is absent", () => {
    // buildDir = <repoRoot>/build/<feat>; derive uses the env workspace name.
    expect(
      resolveDevUrl(buildDir, { CONDUCTOR_WORKSPACE_NAME: "product-x" }),
    ).toBe("https://product-x.dispatch.localhost")
  })

  test("falls back when state.json is unreadable/malformed", () => {
    writeFileSync(join(buildDir, "state.json"), "not json")
    expect(
      resolveDevUrl(buildDir, { CONDUCTOR_WORKSPACE_NAME: "product-x" }),
    ).toBe("https://product-x.dispatch.localhost")
  })
})

describe("ensureDevServerStarted", () => {
  const paneRef = { paneId: "pane-dev", worktreePath: "/wt" }
  const base = {
    buildDir: "/wt/build/feat",
    paneRef,
    devUrl: "https://x",
    controlScriptPath: "/wt/bin/build/dev-server-control.ts",
  }

  test("already reachable → true, never issues a pane run (warm reuse)", async () => {
    let ran = false
    const up = await ensureDevServerStarted({
      ...base,
      reachableImpl: async () => true,
      run: () => {
        ran = true
        return ok
      },
      waitImpl: async () => true,
    })
    expect(up).toBe(true)
    expect(ran).toBe(false)
  })

  test("unreachable → issues the pane run, then waits", async () => {
    const calls: string[][] = []
    const up = await ensureDevServerStarted({
      ...base,
      reachableImpl: async () => false,
      run: (cmd) => {
        calls.push(cmd)
        return ok
      },
      waitImpl: async () => true,
    })
    expect(up).toBe(true)
    expect(calls[0]).toEqual(
      paneRunCommand(paneRef, base.controlScriptPath, base.buildDir),
    )
  })

  test("never becomes reachable → false", async () => {
    const up = await ensureDevServerStarted({
      ...base,
      reachableImpl: async () => false,
      run: () => ok,
      waitImpl: async () => false,
    })
    expect(up).toBe(false)
  })
})

describe("stopDevServer", () => {
  test("kills the group via the handle and removes the handle file", () => {
    const kills: Array<[number, NodeJS.Signals]> = []
    const unlinked: string[] = []
    const stopped = stopDevServer("/wt/build/feat", {
      readHandle: () => ({
        pid: 7,
        pgid: 7,
        devUrl: "https://x",
        startedAt: "t",
      }),
      killImpl: (pid, sig) => kills.push([pid, sig]),
      unlink: (p) => unlinked.push(p),
    })
    expect(stopped).toBe(true)
    expect(kills).toEqual([[-7, "SIGTERM"]])
    expect(unlinked).toEqual([handleFilePath("/wt/build/feat")])
  })

  test("no handle present → false, no kill", () => {
    let killed = false
    const stopped = stopDevServer("/wt/build/feat", {
      readHandle: () => null,
      killImpl: () => {
        killed = true
      },
      unlink: () => {},
    })
    expect(stopped).toBe(false)
    expect(killed).toBe(false)
  })
})

describe("restartDevServer", () => {
  test("stops before it starts (kill precedes pane run)", async () => {
    const order: string[] = []
    const up = await restartDevServer({
      buildDir: "/wt/build/feat",
      paneRef: { paneId: "pane-dev", worktreePath: "/wt" },
      devUrl: "https://x",
      controlScriptPath: "/wt/bin/build/dev-server-control.ts",
      readHandle: () => ({
        pid: 7,
        pgid: 7,
        devUrl: "https://x",
        startedAt: "t",
      }),
      killImpl: () => order.push("kill"),
      unlink: () => order.push("unlink"),
      pidAliveImpl: () => false,
      reachableImpl: async () => false,
      run: () => {
        order.push("pane-run")
        return ok
      },
      waitImpl: async () => true,
    })
    expect(up).toBe(true)
    expect(order.indexOf("kill")).toBeLessThan(order.indexOf("pane-run"))
  })

  test("force-relaunches even while the just-killed server is still answering", async () => {
    // The dying `bun run dev` answers the URL for a beat during graceful
    // SIGTERM shutdown; restart must NOT treat that as warm reuse.
    let ran = false
    const up = await restartDevServer({
      buildDir: "/wt/build/feat",
      paneRef: { paneId: "pane-dev", worktreePath: "/wt" },
      devUrl: "https://x",
      controlScriptPath: "/wt/bin/build/dev-server-control.ts",
      readHandle: () => ({
        pid: 7,
        pgid: 7,
        devUrl: "https://x",
        startedAt: "t",
      }),
      killImpl: () => {},
      unlink: () => {},
      pidAliveImpl: () => false,
      reachableImpl: async () => true, // old server transiently reachable
      run: () => {
        ran = true
        return ok
      },
      waitImpl: async () => true,
    })
    expect(up).toBe(true)
    expect(ran).toBe(true) // launched despite the transient reachability
  })

  test("waits for the killed group leader to exit before relaunching", async () => {
    const order: string[] = []
    let aliveProbes = 0
    const up = await restartDevServer({
      buildDir: "/wt/build/feat",
      paneRef: { paneId: "pane-dev", worktreePath: "/wt" },
      devUrl: "https://x",
      controlScriptPath: "/wt/bin/build/dev-server-control.ts",
      readHandle: () => ({
        pid: 7,
        pgid: 7,
        devUrl: "https://x",
        startedAt: "t",
      }),
      killImpl: () => order.push("kill"),
      unlink: () => {},
      // Alive for the first two polls, then gone.
      pidAliveImpl: () => {
        aliveProbes += 1
        return aliveProbes <= 2
      },
      sleep: async () => {
        order.push("sleep")
      },
      reachableImpl: async () => false,
      run: () => {
        order.push("pane-run")
        return ok
      },
      waitImpl: async () => true,
    })
    expect(up).toBe(true)
    // Drained (two sleeps while alive) before the relaunch.
    expect(order).toEqual(["kill", "sleep", "sleep", "pane-run"])
  })

  test("gives up draining after the timeout and relaunches anyway", async () => {
    let slept = 0
    let clock = 0
    const up = await restartDevServer({
      buildDir: "/wt/build/feat",
      paneRef: { paneId: "pane-dev", worktreePath: "/wt" },
      devUrl: "https://x",
      controlScriptPath: "/wt/bin/build/dev-server-control.ts",
      readHandle: () => ({
        pid: 7,
        pgid: 7,
        devUrl: "https://x",
        startedAt: "t",
      }),
      killImpl: () => {},
      unlink: () => {},
      pidAliveImpl: () => true, // never dies
      now: () => clock,
      sleep: async (ms) => {
        slept += 1
        clock += ms
      },
      drainTimeoutMs: 1_000,
      drainIntervalMs: 250,
      reachableImpl: async () => false,
      run: () => ok,
      waitImpl: async () => true,
    })
    expect(up).toBe(true)
    expect(slept).toBe(4) // 4 × 250ms == 1000ms, then deadline reached
  })
})

describe("devServerStatus", () => {
  test("reachable → running", async () => {
    const status = await devServerStatus({
      buildDir: "/wt/build/feat",
      devUrl: "https://x",
      readHandle: () => null,
      reachableImpl: async () => true,
    })
    expect(status).toBe("running")
  })

  test("handle + live pid, not reachable → starting", async () => {
    const status = await devServerStatus({
      buildDir: "/wt/build/feat",
      devUrl: "https://x",
      readHandle: () => ({
        pid: 7,
        pgid: 7,
        devUrl: "https://x",
        startedAt: "t",
      }),
      reachableImpl: async () => false,
      pidAliveImpl: () => true,
    })
    expect(status).toBe("starting")
  })

  test("no handle, not reachable → stopped", async () => {
    const status = await devServerStatus({
      buildDir: "/wt/build/feat",
      devUrl: "https://x",
      readHandle: () => null,
      reachableImpl: async () => false,
    })
    expect(status).toBe("stopped")
  })
})

describe("screenshotCaptureEnv", () => {
  test("adds the capture-mode flag set to '1'", () => {
    expect(screenshotCaptureEnv({})[SCREENSHOT_CAPTURE_ENV_VAR]).toBe("1")
    expect(SCREENSHOT_CAPTURE_ENV_VAR).toBe("BUILD_SCREENSHOT_CAPTURE")
  })

  test("preserves all keys from the base env", () => {
    const base = { PATH: "/usr/bin", ARBITRARY: "x" }
    const result = screenshotCaptureEnv(base)
    expect(result.PATH).toBe("/usr/bin")
    expect(result.ARBITRARY).toBe("x")
    expect(result[SCREENSHOT_CAPTURE_ENV_VAR]).toBe("1")
  })

  test("does not mutate the input object", () => {
    const base: NodeJS.ProcessEnv = { PATH: "/usr/bin" }
    const result = screenshotCaptureEnv(base)
    expect(result).not.toBe(base)
    expect(base[SCREENSHOT_CAPTURE_ENV_VAR]).toBeUndefined()
  })
})
