import { describe, expect, test } from "bun:test"
import type { ShResult } from "../build/repo"
import { commitLedger, LEDGER_PATH } from "./ledger-commit"

function fakeSh(results: ShResult[]) {
  const calls: string[][] = []
  let i = 0
  const exec = (cmd: string[]): ShResult => {
    calls.push(cmd)
    return results[i++] ?? { code: 0, stdout: "", stderr: "" }
  }
  return { exec, calls }
}

const ok: ShResult = { code: 0, stdout: "", stderr: "" }
const dirty: ShResult = { code: 1, stdout: "", stderr: "" } // diff --quiet exits 1 when staged

describe("commitLedger", () => {
  test("stages, commits, and pushes when the ledger changed and push=true", () => {
    const { exec, calls } = fakeSh([ok, dirty, ok, ok])
    const result = commitLedger({ repoRoot: "/repo", push: true, exec })

    expect(result).toEqual({ committed: true, pushed: true })
    expect(calls[0]).toEqual(["git", "add", "--", LEDGER_PATH])
    const commit = calls.find((c) => c[1] === "commit")
    expect(commit?.join(" ")).toContain(
      "chore(kickoff): record ledger outcome(s) [skip ci]",
    )
    expect(calls.some((c) => c[1] === "push")).toBe(true)
  })

  test("commits but does not push when push=false", () => {
    const { exec, calls } = fakeSh([ok, dirty, ok])
    const result = commitLedger({ repoRoot: "/repo", push: false, exec })
    expect(result).toEqual({ committed: true, pushed: false })
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })

  test("no-op when nothing staged", () => {
    const { exec, calls } = fakeSh([ok, ok])
    const result = commitLedger({ repoRoot: "/repo", push: true, exec })
    expect(result).toEqual({ committed: false, pushed: false })
    expect(calls.some((c) => c[1] === "commit")).toBe(false)
  })

  test("surfaces a push rejection as an error (single-writer conflict)", () => {
    const reject: ShResult = { code: 1, stdout: "", stderr: "rejected" }
    const { exec } = fakeSh([ok, dirty, ok, reject])
    const result = commitLedger({ repoRoot: "/repo", push: true, exec })
    expect(result.committed).toBe(true)
    expect(result.pushed).toBe(false)
    expect(result.error?.stderr).toBe("rejected")
  })

  test("does not push when the commit fails", () => {
    const { exec, calls } = fakeSh([
      ok,
      dirty,
      { code: 1, stdout: "", stderr: "boom" },
    ])
    const result = commitLedger({ repoRoot: "/repo", push: true, exec })
    expect(result.committed).toBe(false)
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })
})
