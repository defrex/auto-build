import { describe, expect, test } from "bun:test"
import {
  commitArtifacts,
  detectPrUrl,
  fetchPrState,
  forceRemoveWorktreeDir,
  isBranchBehindBase,
  isPrMerged,
  publishArtifacts,
  reconcileWithBase,
  removeWorktree,
  type ShResult,
  untrackLegacyHeartbeat,
  worktreeListPorcelain,
} from "./repo"

/** A fake `sh` that records calls and replays scripted results by command index. */
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
const dirty: ShResult = { code: 1, stdout: "", stderr: "" } // diff --quiet exits 1 when changes exist

describe("isBranchBehindBase", () => {
  test("fetch ok + rev-list 2 ⇒ { fetchOk: true, behind: true }", () => {
    const { exec, calls } = fakeSh([ok, { code: 0, stdout: "2\n", stderr: "" }])
    const result = isBranchBehindBase("/repo", "main", exec)
    expect(result).toEqual({ fetchOk: true, behind: true })
    expect(calls[0]).toEqual(["git", "fetch", "origin", "main"])
    expect(calls[1]).toEqual([
      "git",
      "rev-list",
      "--count",
      "HEAD..origin/main",
    ])
  })

  test("fetch ok + rev-list 0 ⇒ { fetchOk: true, behind: false }", () => {
    const { exec } = fakeSh([ok, { code: 0, stdout: "0\n", stderr: "" }])
    expect(isBranchBehindBase("/repo", "main", exec)).toEqual({
      fetchOk: true,
      behind: false,
    })
  })

  test("fetch fails ⇒ { fetchOk: false } and no rev-list call", () => {
    const { exec, calls } = fakeSh([{ code: 1, stdout: "", stderr: "no net" }])
    expect(isBranchBehindBase("/repo", "main", exec)).toEqual({
      fetchOk: false,
    })
    expect(calls.length).toBe(1)
    expect(calls.some((c) => c[1] === "rev-list")).toBe(false)
  })

  test("fetch ok but rev-list fails ⇒ { fetchOk: false } (comparison uncertified, never behind:false)", () => {
    // A non-zero rev-list must NOT collapse to behind:false / fetchOk:true —
    // that would let the caller announce `ready` on an uncertified branch.
    const { exec } = fakeSh([ok, { code: 128, stdout: "", stderr: "bad rev" }])
    expect(isBranchBehindBase("/repo", "main", exec)).toEqual({
      fetchOk: false,
    })
  })

  test("fetch ok but rev-list emits unparseable stdout ⇒ { fetchOk: false }", () => {
    const { exec } = fakeSh([ok, { code: 0, stdout: "garbage\n", stderr: "" }])
    expect(isBranchBehindBase("/repo", "main", exec)).toEqual({
      fetchOk: false,
    })
  })
})

describe("detectPrUrl", () => {
  test("returns the trimmed URL on exit 0", () => {
    const { exec, calls } = fakeSh([
      {
        code: 0,
        stdout: "https://github.com/dispatch/dispatch/pull/595\n",
        stderr: "",
      },
    ])
    expect(detectPrUrl("/repo", 595, exec)).toBe(
      "https://github.com/dispatch/dispatch/pull/595",
    )
    expect(calls[0]).toEqual([
      "gh",
      "pr",
      "view",
      "595",
      "--json",
      "url",
      "-q",
      ".url",
    ])
  })

  test("returns null on a non-zero exit", () => {
    const { exec } = fakeSh([{ code: 1, stdout: "", stderr: "no pr" }])
    expect(detectPrUrl("/repo", 595, exec)).toBeNull()
  })
})

describe("fetchPrState", () => {
  test("returns the trimmed state string on a zero exit", () => {
    const { exec, calls } = fakeSh([{ code: 0, stdout: "OPEN\n", stderr: "" }])
    expect(fetchPrState("/repo", 595, exec)).toBe("OPEN")
    expect(calls[0]).toEqual([
      "gh",
      "pr",
      "view",
      "595",
      "--json",
      "state",
      "-q",
      ".state",
    ])
  })

  test("returns MERGED / CLOSED verbatim (trimmed)", () => {
    expect(
      fetchPrState(
        "/repo",
        1,
        fakeSh([{ code: 0, stdout: "MERGED\n", stderr: "" }]).exec,
      ),
    ).toBe("MERGED")
    expect(
      fetchPrState(
        "/repo",
        1,
        fakeSh([{ code: 0, stdout: "  CLOSED  ", stderr: "" }]).exec,
      ),
    ).toBe("CLOSED")
  })

  test('returns "UNKNOWN" on a non-zero exit', () => {
    const { exec } = fakeSh([{ code: 1, stdout: "OPEN", stderr: "boom" }])
    expect(fetchPrState("/repo", 1, exec)).toBe("UNKNOWN")
  })
})

describe("isPrMerged", () => {
  test("true only when state is MERGED", () => {
    const { exec, calls } = fakeSh([
      { code: 0, stdout: "MERGED\n", stderr: "" },
    ])
    expect(isPrMerged("/repo", 595, exec)).toBe(true)
    expect(calls[0]).toEqual([
      "gh",
      "pr",
      "view",
      "595",
      "--json",
      "state",
      "-q",
      ".state",
    ])
  })

  test("false for OPEN / CLOSED", () => {
    expect(
      isPrMerged(
        "/repo",
        1,
        fakeSh([{ code: 0, stdout: "OPEN", stderr: "" }]).exec,
      ),
    ).toBe(false)
    expect(
      isPrMerged(
        "/repo",
        1,
        fakeSh([{ code: 0, stdout: "CLOSED", stderr: "" }]).exec,
      ),
    ).toBe(false)
  })

  test("false on a non-zero exit", () => {
    const { exec } = fakeSh([{ code: 1, stdout: "MERGED", stderr: "boom" }])
    expect(isPrMerged("/repo", 1, exec)).toBe(false)
  })
})

describe("worktreeListPorcelain", () => {
  test("returns stdout on success", () => {
    const { exec, calls } = fakeSh([
      { code: 0, stdout: "worktree /repo\n", stderr: "" },
    ])
    expect(worktreeListPorcelain("/repo", exec)).toBe("worktree /repo\n")
    expect(calls[0]).toEqual(["git", "worktree", "list", "--porcelain"])
  })

  test("returns empty string on failure", () => {
    const { exec } = fakeSh([{ code: 128, stdout: "x", stderr: "boom" }])
    expect(worktreeListPorcelain("/repo", exec)).toBe("")
  })
})

describe("removeWorktree", () => {
  test("forwards the ShResult and uses the main worktree + --force", () => {
    const result: ShResult = { code: 0, stdout: "removed", stderr: "" }
    const { exec, calls } = fakeSh([result])
    expect(
      removeWorktree("/main", "/main/../.kickoff-worktrees/slug", exec),
    ).toEqual(result)
    expect(calls[0]).toEqual([
      "git",
      "-C",
      "/main",
      "worktree",
      "remove",
      "--force",
      "/main/../.kickoff-worktrees/slug",
    ])
  })

  test("forwards a failure ShResult verbatim", () => {
    const fail: ShResult = { code: 1, stdout: "", stderr: "is dirty" }
    const { exec } = fakeSh([fail])
    expect(removeWorktree("/main", "/wt", exec)).toEqual(fail)
  })
})

describe("forceRemoveWorktreeDir", () => {
  const WT = "/main/../.kickoff-worktrees/slug"

  test("both succeed → rm -rf then prune (in order); returns the prune result", () => {
    const prune: ShResult = { code: 0, stdout: "pruned", stderr: "" }
    const { exec, calls } = fakeSh([ok, prune])
    expect(forceRemoveWorktreeDir("/main", WT, exec)).toEqual(prune)
    expect(calls).toEqual([
      ["rm", "-rf", WT],
      ["git", "-C", "/main", "worktree", "prune"],
    ])
  })

  test("rm -rf fails → prune skipped; returns the rm failure verbatim", () => {
    const rmFail: ShResult = {
      code: 1,
      stdout: "",
      stderr: "permission denied",
    }
    const { exec, calls } = fakeSh([rmFail])
    expect(forceRemoveWorktreeDir("/main", WT, exec)).toEqual(rmFail)
    // Regression guard: a masked failure would show a 2nd (prune) call here.
    expect(calls).toEqual([["rm", "-rf", WT]])
  })

  test("rm -rf ok but prune fails → returns the prune failure verbatim", () => {
    const pruneFail: ShResult = { code: 1, stdout: "", stderr: "prune failed" }
    const { exec, calls } = fakeSh([ok, pruneFail])
    expect(forceRemoveWorktreeDir("/main", WT, exec)).toEqual(pruneFail)
    expect(calls).toEqual([
      ["rm", "-rf", WT],
      ["git", "-C", "/main", "worktree", "prune"],
    ])
  })
})

describe("commitArtifacts", () => {
  test("commits the scoped build dir (no push) when artifacts changed", () => {
    // add → diff(dirty) → commit
    const { exec, calls } = fakeSh([ok, dirty, ok])
    const result = commitArtifacts("/repo", "my-feature", exec)

    expect(result.code).toBe(0)
    expect(calls[0]).toEqual(["git", "add", "--", "build/my-feature"])
    const commit = calls.find((c) => c[1] === "commit")
    expect(commit).toBeDefined()
    expect(commit).toContain("build/my-feature")
    expect(commit?.join(" ")).toContain(
      "build(my-feature): capture pipeline artifacts",
    )
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })

  test("is a no-op sentinel when nothing changed", () => {
    // add → diff(clean, code 0) → stop
    const { exec, calls } = fakeSh([ok, ok])
    const result = commitArtifacts("/repo", "my-feature", exec)

    expect(result).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(calls.some((c) => c[1] === "commit")).toBe(false)
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })

  test("returns the failing commit result (no push) when the commit fails", () => {
    // add → diff(dirty) → commit(fail)
    const { exec, calls } = fakeSh([
      ok,
      dirty,
      { code: 1, stdout: "", stderr: "boom" },
    ])
    const result = commitArtifacts("/repo", "my-feature", exec)

    expect(result.code).toBe(1)
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })

  test("git add fails ⇒ returns the add result, no diff/commit/push", () => {
    const addFail: ShResult = {
      code: 1,
      stdout: "",
      stderr: "fatal: Unable to create index.lock",
    }
    const { exec, calls } = fakeSh([addFail])
    const result = commitArtifacts("/repo", "my-feature", exec)

    expect(result).toEqual(addFail)
    expect(calls.length).toBe(1)
    expect(calls[0]?.[1]).toBe("add")
    expect(calls.some((c) => c[1] === "diff")).toBe(false)
    expect(calls.some((c) => c[1] === "commit")).toBe(false)
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })
})

describe("publishArtifacts", () => {
  test("dirty → push ok ⇒ { status: 'pushed' }", () => {
    // add → diff(dirty) → commit → rev-list(@{u}..HEAD)=1 → push
    const { exec, calls } = fakeSh([
      ok,
      dirty,
      ok,
      { code: 0, stdout: "1\n", stderr: "" },
      ok,
    ])
    expect(publishArtifacts("/repo", "my-feature", exec)).toEqual({
      status: "pushed",
    })
    const push = calls.find((c) => c[1] === "push")
    expect(push).toEqual(["git", "push"])
  })

  test("fresh commit made ⇒ pushes even if rev-list reads 0 (madeCommit guard)", () => {
    // add → diff(dirty) → commit(real git summary on stdout) → rev-list=0 → push.
    // A genuine commit means the branch is ahead, so we must push and never read
    // "clean" — even if rev-list anomalously reports 0. This locks the madeCommit
    // path that production relies on git's commit stdout to take.
    const { exec, calls } = fakeSh([
      ok,
      dirty,
      {
        code: 0,
        stdout: "[branch abc1234] capture pipeline artifacts",
        stderr: "",
      },
      { code: 0, stdout: "0\n", stderr: "" },
      ok,
    ])
    expect(publishArtifacts("/repo", "my-feature", exec)).toEqual({
      status: "pushed",
    })
    expect(calls.some((c) => c[1] === "push")).toBe(true)
  })

  test("clean + in sync ⇒ { status: 'clean' } and no push", () => {
    // add → diff(clean) → rev-list=0
    const { exec, calls } = fakeSh([
      ok,
      ok,
      { code: 0, stdout: "0\n", stderr: "" },
    ])
    expect(publishArtifacts("/repo", "my-feature", exec)).toEqual({
      status: "clean",
    })
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })

  test("clean tree but ahead (prior failed push) ⇒ pushes the orphaned commit", () => {
    // add → diff(clean) → rev-list=1 → push
    const { exec, calls } = fakeSh([
      ok,
      ok,
      { code: 0, stdout: "1\n", stderr: "" },
      ok,
    ])
    expect(publishArtifacts("/repo", "my-feature", exec)).toEqual({
      status: "pushed",
    })
    expect(calls.some((c) => c[1] === "push")).toBe(true)
  })

  test("commit fails ⇒ { status: 'failed' }, no rev-list, no push", () => {
    const { exec, calls } = fakeSh([
      ok,
      dirty,
      { code: 1, stdout: "", stderr: "commit boom" },
    ])
    const result = publishArtifacts("/repo", "my-feature", exec)
    expect(result.status).toBe("failed")
    expect(calls.some((c) => c[1] === "rev-list")).toBe(false)
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })

  test("git add fails ⇒ { status: 'failed', detail } carrying add stderr, no rev-list/push", () => {
    const { exec, calls } = fakeSh([
      { code: 1, stdout: "", stderr: "index.lock exists" },
    ])
    expect(publishArtifacts("/repo", "my-feature", exec)).toEqual({
      status: "failed",
      detail: "index.lock exists",
    })
    expect(calls.length).toBe(1)
    expect(calls.some((c) => c[1] === "diff")).toBe(false)
    expect(calls.some((c) => c[1] === "rev-list")).toBe(false)
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })

  test("push fails ⇒ { status: 'failed', detail }, never clean", () => {
    const { exec } = fakeSh([
      ok,
      dirty,
      ok,
      { code: 0, stdout: "1\n", stderr: "" },
      { code: 1, stdout: "", stderr: "push rejected" },
    ])
    const result = publishArtifacts("/repo", "my-feature", exec)
    expect(result).toEqual({ status: "failed", detail: "push rejected" })
  })
})

describe("reconcileWithBase", () => {
  test("dirty tree, clean reconcile: commits before merge, plain push", () => {
    // add → diff(dirty) → commit → fetch → merge → push
    const { exec, calls } = fakeSh([ok, dirty, ok, ok, ok, ok])
    const result = reconcileWithBase("/repo", "main", "my-feature", exec)
    expect(result.code).toBe(0)
    const commitIdx = calls.findIndex((c) => c[1] === "commit")
    const mergeIdx = calls.findIndex((c) => c[1] === "merge")
    expect(commitIdx).toBeGreaterThanOrEqual(0)
    expect(commitIdx).toBeLessThan(mergeIdx)
    const push = calls.find((c) => c[1] === "push")
    expect(push).toEqual(["git", "push"])
  })

  test("clean tree: no commit, but merge still runs and pushes", () => {
    // add → diff(clean) → fetch → merge → push
    const { exec, calls } = fakeSh([ok, ok, ok, ok, ok])
    const result = reconcileWithBase("/repo", "main", "my-feature", exec)
    expect(result.code).toBe(0)
    expect(calls.some((c) => c[1] === "commit")).toBe(false)
    expect(calls.some((c) => c[1] === "merge")).toBe(true)
    expect(calls.some((c) => c[1] === "push")).toBe(true)
  })

  test("merge conflict: aborts and returns the failure, no push", () => {
    // add → diff(dirty) → commit → fetch → merge(fail) → abort
    const { exec, calls } = fakeSh([
      ok,
      dirty,
      ok,
      ok,
      { code: 1, stdout: "", stderr: "conflict" },
      ok,
    ])
    const result = reconcileWithBase("/repo", "main", "my-feature", exec)
    expect(result.code).toBe(1)
    // Returns the MERGE failure, not the (ok) abort result that follows it.
    expect(result.stderr).toBe("conflict")
    expect(calls.some((c) => c.join(" ") === "git merge --abort")).toBe(true)
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })

  test("artifact commit fails ⇒ no fetch/merge/push (secondary fix)", () => {
    // add → diff(dirty) → commit(fail)
    const { exec, calls } = fakeSh([
      ok,
      dirty,
      { code: 1, stdout: "", stderr: "commit boom" },
    ])
    const result = reconcileWithBase("/repo", "main", "my-feature", exec)
    expect(result.code).toBe(1)
    expect(calls.some((c) => c[1] === "fetch")).toBe(false)
    expect(calls.some((c) => c[1] === "merge")).toBe(false)
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })

  test("base fetch fails ⇒ returns the fetch failure, no merge/push (no merge onto stale ref)", () => {
    // add → diff(clean) → fetch(fail). Must NOT merge a stale origin/<base>.
    const { exec, calls } = fakeSh([
      ok,
      ok,
      { code: 1, stdout: "", stderr: "fatal: could not fetch origin main" },
    ])
    const result = reconcileWithBase("/repo", "main", "my-feature", exec)
    expect(result.code).toBe(1)
    expect(result.stderr).toBe("fatal: could not fetch origin main")
    expect(calls.some((c) => c[1] === "merge")).toBe(false)
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })

  test("git add fails ⇒ short-circuits, only the add call (5th-pass fix)", () => {
    const { exec, calls } = fakeSh([
      { code: 1, stdout: "", stderr: "index.lock exists" },
    ])
    const result = reconcileWithBase("/repo", "main", "my-feature", exec)
    expect(result.code).toBe(1)
    expect(calls.length).toBe(1)
    expect(calls[0]?.[1]).toBe("add")
    expect(calls.some((c) => c[1] === "diff")).toBe(false)
    expect(calls.some((c) => c[1] === "commit")).toBe(false)
    expect(calls.some((c) => c[1] === "fetch")).toBe(false)
    expect(calls.some((c) => c[1] === "merge")).toBe(false)
    expect(calls.some((c) => c[1] === "push")).toBe(false)
  })
})

describe("untrackLegacyHeartbeat", () => {
  test("tracked ⇒ git rm -f the legacy heartbeat.json", () => {
    const { exec, calls } = fakeSh([
      { code: 0, stdout: "build/my-feature/heartbeat.json\n", stderr: "" },
      ok,
    ])
    const result = untrackLegacyHeartbeat("/repo", "my-feature", exec)
    expect(result.code).toBe(0)
    expect(calls[0]).toEqual([
      "git",
      "ls-files",
      "--",
      "build/my-feature/heartbeat.json",
    ])
    expect(calls[1]).toEqual([
      "git",
      "rm",
      "-f",
      "--",
      "build/my-feature/heartbeat.json",
    ])
  })

  test("not tracked (ls-files empty) ⇒ no-op sentinel, no git rm", () => {
    const { exec, calls } = fakeSh([{ code: 0, stdout: "\n", stderr: "" }])
    const result = untrackLegacyHeartbeat("/repo", "my-feature", exec)
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(calls.length).toBe(1)
    expect(calls.some((c) => c[1] === "rm")).toBe(false)
  })

  test("ls-files non-zero ⇒ no-op sentinel, no git rm", () => {
    const { exec, calls } = fakeSh([
      { code: 128, stdout: "", stderr: "not a git repo" },
    ])
    const result = untrackLegacyHeartbeat("/repo", "my-feature", exec)
    expect(result).toEqual({ code: 0, stdout: "", stderr: "" })
    expect(calls.length).toBe(1)
    expect(calls.some((c) => c[1] === "rm")).toBe(false)
  })
})
