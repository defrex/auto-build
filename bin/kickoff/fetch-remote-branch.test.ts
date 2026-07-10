/**
 * Real-git regression for `fetchRemoteBranchArgs` — the production fetch that
 * primes `refs/remotes/origin/<branch>` for a remote-only attached branch
 * during restore.
 *
 * The unit-level restore tests model `fetchRemoteBranch` as a function that
 * makes `origin/<branch>` appear, but that invariant only holds if the git
 * command actually creates the remote-tracking ref. The original bug shipped a
 * bare `git fetch origin <branch>`, which in a `--single-branch`
 * (narrowed-refspec) clone writes only `FETCH_HEAD` and leaves
 * `origin/<branch>` absent — so the downstream `ls-tree`/`worktree add` fail
 * and restore wrongly falls the slug back / skips the ticket. This test drives
 * the exact production argv against real git to prove the ref is created in the
 * clone shape that previously failed.
 */

import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sh } from "../build/repo"
import { fetchRemoteBranchArgs } from "./kickoff"

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kickoff-fetch-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** git in a fixture, asserting success so a broken fixture fails loudly. */
function git(cwd: string, ...args: string[]): string {
  const r = sh(["git", ...args], cwd)
  if (r.code !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`)
  return r.stdout
}

/**
 * Build: a bare remote with `main`, a clone narrowed to `main` only, then a
 * `feature/x` branch (carrying a committed `build/` dir) pushed to the remote
 * AFTER the clone — so the clone has never seen `origin/feature/x`.
 */
function setupNarrowedClone(): { clone: string; branch: string } {
  const remote = join(root, "remote.git")
  git(root, "init", "-q", "--bare", remote)

  const seed = join(root, "seed")
  git(root, "clone", "-q", remote, seed)
  git(seed, "config", "user.email", "a@b.c")
  git(seed, "config", "user.name", "a")
  git(seed, "commit", "-q", "--allow-empty", "-m", "init")
  git(seed, "branch", "-M", "main")
  git(seed, "push", "-q", "origin", "main")

  // Narrowed clone: remote.origin.fetch maps only main.
  const clone = join(root, "clone")
  git(root, "clone", "-q", "--single-branch", "--branch", "main", remote, clone)

  // Push feature/x with a committed build dir AFTER the clone exists, so
  // ls-tree origin/feature/x:build has something to read.
  git(seed, "checkout", "-q", "-b", "feature/x")
  mkdirSync(join(seed, "build", "committed-slug"), { recursive: true })
  writeFileSync(join(seed, "build", "committed-slug", "spec.md"), "x")
  git(seed, "add", "-A")
  git(seed, "commit", "-q", "-m", "build")
  git(seed, "push", "-q", "origin", "feature/x")

  return { clone, branch: "feature/x" }
}

test("primes origin/<branch> in a narrowed clone (bare fetch would not)", () => {
  const { clone, branch } = setupNarrowedClone()

  // Precondition: the narrowed clone has never seen origin/feature/x.
  expect(
    sh(["git", "rev-parse", "--verify", `origin/${branch}`], clone).code,
  ).not.toBe(0)

  // The production fetch argv.
  const fetched = sh(fetchRemoteBranchArgs(branch), clone)
  expect(fetched.code).toBe(0)

  // origin/<branch> now exists, so the downstream inspections succeed.
  expect(
    sh(["git", "rev-parse", "--verify", `origin/${branch}`], clone).code,
  ).toBe(0)
  const lsTree = sh(
    ["git", "ls-tree", "-d", "--name-only", `origin/${branch}:build`],
    clone,
  )
  expect(lsTree.code).toBe(0)
  expect(lsTree.stdout).toContain("committed-slug")
})

test("a bare `git fetch origin <branch>` leaves origin/<branch> absent (proves the bug)", () => {
  const { clone, branch } = setupNarrowedClone()

  // The original (buggy) command: no destination refspec.
  expect(sh(["git", "fetch", "origin", branch], clone).code).toBe(0)

  // In the narrowed clone it only wrote FETCH_HEAD — origin/<branch> is absent
  // and the ls-tree the slug inspection depends on fails.
  expect(
    sh(["git", "rev-parse", "--verify", `origin/${branch}`], clone).code,
  ).not.toBe(0)
  expect(
    sh(["git", "ls-tree", "-d", "--name-only", `origin/${branch}:build`], clone)
      .code,
  ).not.toBe(0)
})
