import { describe, expect, test } from "bun:test"
import {
  type RunCommand,
  runValidate,
  summarizeValidation,
  validateFailuresPath,
} from "./validate"

describe("summarizeValidation", () => {
  test("passes when every check is ok", () => {
    const r = summarizeValidation([
      { name: "typecheck", ok: true, output: "" },
      { name: "lint", ok: true, output: "" },
    ])
    expect(r.pass).toBe(true)
    expect(r.failureText).toBe("")
  })

  test("fails and digests only the failed checks", () => {
    const r = summarizeValidation([
      { name: "typecheck", ok: true, output: "ok" },
      { name: "lint", ok: false, output: "biome: 2 errors" },
    ])
    expect(r.pass).toBe(false)
    expect(r.failureText).toContain("## lint failed")
    expect(r.failureText).toContain("biome: 2 errors")
    expect(r.failureText).not.toContain("typecheck")
  })
})

describe("validateFailuresPath", () => {
  test("lives in the build dir", () => {
    expect(validateFailuresPath("/repo/build/feat")).toBe(
      "/repo/build/feat/validate-failures.md",
    )
  })
})

describe("runValidate", () => {
  test("runs all checks in order when passing", async () => {
    const seen: string[] = []
    const run: RunCommand = async (cmd) => {
      seen.push(cmd.join(" "))
      return { code: 0, output: "ok" }
    }
    const r = await runValidate({
      repoRoot: "/repo",
      logPath: "/dev/null",
      runCommand: run,
    })
    expect(r.pass).toBe(true)
    expect(seen).toEqual(["bun run typecheck", "bun run lint", "bun run test"])
  })

  test("fails fast on the first failing check", async () => {
    const seen: string[] = []
    const run: RunCommand = async (cmd) => {
      seen.push(cmd.join(" "))
      return cmd.includes("lint")
        ? { code: 1, output: "lint boom" }
        : { code: 0, output: "ok" }
    }
    const r = await runValidate({
      repoRoot: "/repo",
      logPath: "/dev/null",
      runCommand: run,
    })
    expect(r.pass).toBe(false)
    expect(r.failureText).toContain("lint boom")
    // typecheck + lint ran; test was short-circuited.
    expect(seen).toEqual(["bun run typecheck", "bun run lint"])
  })

  test("runs the optional e2e step after the deterministic checks pass", async () => {
    let e2eRan = false
    const run: RunCommand = async () => ({ code: 0, output: "ok" })
    const r = await runValidate({
      repoRoot: "/repo",
      logPath: "/dev/null",
      runCommand: run,
      e2e: async () => {
        e2eRan = true
        return { name: "e2e", ok: true, output: "" }
      },
    })
    expect(e2eRan).toBe(true)
    expect(r.pass).toBe(true)
    expect(r.results.map((c) => c.name)).toContain("e2e")
  })

  test("a failing e2e step fails the gate", async () => {
    const run: RunCommand = async () => ({ code: 0, output: "ok" })
    const r = await runValidate({
      repoRoot: "/repo",
      logPath: "/dev/null",
      runCommand: run,
      e2e: async () => ({ name: "e2e", ok: false, output: "flow broke" }),
    })
    expect(r.pass).toBe(false)
    expect(r.failureText).toContain("flow broke")
  })

  test("runs both e2e and evals after the deterministic checks; evals runs after e2e", async () => {
    const order: string[] = []
    const run: RunCommand = async () => ({ code: 0, output: "ok" })
    const r = await runValidate({
      repoRoot: "/repo",
      logPath: "/dev/null",
      runCommand: run,
      e2e: async () => {
        order.push("e2e")
        return { name: "e2e", ok: true, output: "" }
      },
      evals: async () => {
        order.push("evals")
        return { name: "evals", ok: true, output: "" }
      },
    })
    expect(r.pass).toBe(true)
    expect(order).toEqual(["e2e", "evals"])
    expect(r.results.map((c) => c.name)).toEqual([
      "typecheck",
      "lint",
      "test",
      "e2e",
      "evals",
    ])
  })

  test("a failing evals step fails the gate", async () => {
    const run: RunCommand = async () => ({ code: 0, output: "ok" })
    const r = await runValidate({
      repoRoot: "/repo",
      logPath: "/dev/null",
      runCommand: run,
      evals: async () => ({
        name: "evals",
        ok: false,
        output: "gmail/reply regressed",
      }),
    })
    expect(r.pass).toBe(false)
    expect(r.failureText).toContain("gmail/reply regressed")
  })
})
