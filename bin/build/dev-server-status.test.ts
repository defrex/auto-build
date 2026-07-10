import { describe, expect, test } from "bun:test"
import type { DevServerStatus } from "./dev-server-control"
import {
  applyDevServerKeystroke,
  createDevServerCoordinator,
  decideDevServerKeystroke,
  devServerActionCommand,
  endDevServerAction,
  onDevServerActionFailed,
  onDevServerStatusComplete,
  parseDevServerStatusOutput,
} from "./dev-server-status"
import type { ShResult } from "./repo"

const ok: ShResult = { code: 0, stdout: "", stderr: "" }

describe("decideDevServerKeystroke", () => {
  test("maps s/x/r (case-insensitive) to actions, else none", () => {
    expect(decideDevServerKeystroke("s")).toBe("start")
    expect(decideDevServerKeystroke("S")).toBe("start")
    expect(decideDevServerKeystroke("x")).toBe("stop")
    expect(decideDevServerKeystroke("r")).toBe("restart")
    expect(decideDevServerKeystroke("a")).toBe("none")
    expect(decideDevServerKeystroke("q")).toBe("none")
  })
})

describe("devServerActionCommand", () => {
  test("builds the bun run control-CLI argv", () => {
    expect(devServerActionCommand("/c.ts", "start", "/b")).toEqual([
      "bun",
      "run",
      "/c.ts",
      "start",
      "/b",
    ])
  })
})

describe("parseDevServerStatusOutput", () => {
  test("parses the first token of the status line", () => {
    expect(parseDevServerStatusOutput("running (https://x)")).toBe("running")
    expect(parseDevServerStatusOutput("stopped (https://x)\n")).toBe("stopped")
  })

  test("unrecognized → unreachable", () => {
    expect(parseDevServerStatusOutput("")).toBe("unreachable")
    expect(parseDevServerStatusOutput("garbage")).toBe("unreachable")
  })
})

describe("applyDevServerKeystroke (pure reducer)", () => {
  const base = {
    controlsAvailable: true,
    status: "stopped" as DevServerStatus,
    busy: false,
    notice: null,
  }

  test("sets busy + a progress notice and returns the action effect", () => {
    const { next, effect } = applyDevServerKeystroke(base, "s")
    expect(effect).toBe("start")
    expect(next.busy).toBe(true)
    expect(next.notice).toBe("starting…")
  })

  test("no-op when controls unavailable", () => {
    const { next, effect } = applyDevServerKeystroke(
      { ...base, controlsAvailable: false },
      "s",
    )
    expect(effect).toBe("none")
    expect(next.busy).toBe(false)
  })

  test("overlap guard: no-op while an action is in flight", () => {
    const { effect } = applyDevServerKeystroke({ ...base, busy: true }, "r")
    expect(effect).toBe("none")
  })
})

describe("view reducers", () => {
  const base = {
    controlsAvailable: true,
    status: null as DevServerStatus | null,
    busy: true,
    notice: "starting…" as string | null,
  }

  test("onDevServerStatusComplete sets status, clears only a checking notice", () => {
    expect(onDevServerStatusComplete(base, "running").status).toBe("running")
    // a non-checking progress notice is preserved
    expect(onDevServerStatusComplete(base, "running").notice).toBe("starting…")
    expect(
      onDevServerStatusComplete(
        { ...base, notice: "checking dev server…" },
        "running",
      ).notice,
    ).toBeNull()
  })

  test("endDevServerAction clears busy + a progress notice, keeps an error", () => {
    expect(endDevServerAction(base).busy).toBe(false)
    expect(endDevServerAction(base).notice).toBeNull()
    const errored = onDevServerActionFailed(base, "couldn't start dev server")
    expect(endDevServerAction(errored).notice).toBe("couldn't start dev server")
  })
})

describe("createDevServerCoordinator", () => {
  function io(
    over: Partial<{
      status: () => Promise<DevServerStatus>
      action: () => Promise<ShResult>
    }> = {},
  ) {
    return {
      status: over.status ?? (async () => "running" as DevServerStatus),
      action: over.action ?? (async () => ok),
    }
  }

  test("refresh reads status into the view", async () => {
    const coord = createDevServerCoordinator(
      io({ status: async () => "running" }),
    )
    await coord.refresh()
    expect(coord.getView().status).toBe("running")
  })

  test("keystroke s maps to a start action and acks busy immediately", () => {
    const coord = createDevServerCoordinator(io())
    coord.sync({ controlsAvailable: true })
    expect(coord.keystroke("s")).toBe("start")
    expect(coord.getView().busy).toBe(true)
    expect(coord.getView().notice).toBe("starting…")
  })

  test("handleAction runs the action then a confirm read, clearing busy", async () => {
    const actions: string[] = []
    const coord = createDevServerCoordinator(
      io({
        action: async () => {
          actions.push("ran")
          return ok
        },
        status: async () => "running",
      }),
    )
    coord.sync({ controlsAvailable: true })
    coord.keystroke("s")
    await coord.handleAction("start")
    expect(actions).toEqual(["ran"])
    expect(coord.getView().busy).toBe(false)
    expect(coord.getView().status).toBe("running")
  })

  test("a failed action surfaces a brief error notice (status unchanged-by-error)", async () => {
    const coord = createDevServerCoordinator(
      io({
        action: async () => ({ code: 1, stdout: "", stderr: "no pane" }),
        status: async () => "stopped",
      }),
    )
    coord.sync({ controlsAvailable: true })
    coord.keystroke("x")
    await coord.handleAction("stop")
    expect(coord.getView().notice).toBe("couldn't stop dev server")
    expect(coord.getView().busy).toBe(false)
  })

  test("handleAction never rejects even when the exec throws", async () => {
    const coord = createDevServerCoordinator(
      io({
        action: async () => {
          throw new Error("spawn failed")
        },
        status: async () => "stopped",
      }),
    )
    coord.sync({ controlsAvailable: true })
    await expect(coord.handleAction("restart")).resolves.toBeUndefined()
    expect(coord.getView().notice).toBe("couldn't restart dev server")
  })

  test("dueForRefresh respects the interval", () => {
    let t = 0
    const coord = createDevServerCoordinator(io(), { now: () => t })
    expect(coord.dueForRefresh(5_000)).toBe(false) // t - lastRead(0) = 0 < 5000
    t = 6_000
    expect(coord.dueForRefresh(5_000)).toBe(true) // 6000 - 0 >= 5000
  })

  test("dueForRefresh is false while an action is busy", () => {
    let t = 10_000
    const coord = createDevServerCoordinator(io(), { now: () => t })
    coord.sync({ controlsAvailable: true })
    coord.keystroke("s") // sets busy
    t = 99_000
    expect(coord.dueForRefresh(5_000)).toBe(false)
  })
})
