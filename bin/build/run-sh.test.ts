import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const WRAPPER = join(import.meta.dir, "run.sh")

/**
 * Run the wrapper in a temp cwd with a fake `bun` earlier on PATH that exits
 * however `bunScript` dictates. Returns the wrapper's exit code (or, when the
 * wrapper itself died by signal, 128+signum) + the build.log.
 *
 * Async spawn with `detached: true` (NOT spawnSync — Bun's spawnSync ignores
 * `detached`): the wrapper must lead its own process group so a fake bun that
 * signals its whole group (`kill -TERM 0`) can't take the test runner down.
 */
async function runWrapper(bunScript: string, feature = "feat") {
  const cwd = mkdtempSync(join(tmpdir(), "run-sh-"))
  try {
    // Fake bun executable on PATH.
    const binDir = join(cwd, "fakebin")
    mkdirSync(binDir, { recursive: true })
    const fakeBun = join(binDir, "bun")
    writeFileSync(fakeBun, `#!/usr/bin/env bash\n${bunScript}\n`)
    chmodSync(fakeBun, 0o755)

    // Copy the wrapper into the cwd so its relative build/<feature> resolves here.
    const wrapperDest = join(cwd, "run.sh")
    copyFileSync(WRAPPER, wrapperDest)

    const child = spawn("bash", [wrapperDest, feature], {
      cwd,
      env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      detached: true,
      stdio: "ignore",
    })
    const SIGNUM: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", (exitCode, signal) =>
        resolve(exitCode ?? (signal ? 128 + (SIGNUM[signal] ?? 0) : null)),
      )
    })
    const logPath = join(cwd, "build", feature, "build.log")
    let log = ""
    try {
      log = readFileSync(logPath, "utf-8")
    } catch {
      log = ""
    }
    return { code, log }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

describe("run.sh survivor wrapper", () => {
  test("fake bun exit 0 → wrapper exit 0, code=0 line", async () => {
    const { code, log } = await runWrapper("exit 0")
    expect(code).toBe(0)
    expect(log).toContain("wrapper: bun process exited (code=0)")
  })

  test("fake bun exit 2 → wrapper exit 2, code=2 with no signal suffix", async () => {
    const { code, log } = await runWrapper("exit 2")
    expect(code).toBe(2)
    expect(log).toContain("wrapper: bun process exited (code=2)")
    expect(log).not.toContain("signal=")
  })

  test("fake bun exit 137 → code=137, signal=SIGKILL label", async () => {
    const { code, log } = await runWrapper("exit 137")
    expect(code).toBe(137)
    expect(log).toContain(
      "wrapper: bun process exited (code=137, signal=SIGKILL)",
    )
  })

  test("real SIGTERM death → wrapper exit 143, signal=SIGTERM label", async () => {
    const { code, log } = await runWrapper("kill -TERM $$")
    expect(code).toBe(143)
    expect(log).toContain(
      "wrapper: bun process exited (code=143, signal=SIGTERM)",
    )
    // Targeted kill of bun only — the wrapper itself was NOT signalled.
    expect(log).not.toContain("wrapper itself received")
  })

  test("group-wide SIGTERM (the production sweep) → wrapper survives, records both lines", async () => {
    // Fake bun TERMs its entire process group — wrapper included — exactly the
    // shape of the observed kill sweeps. The trap must keep the wrapper alive
    // long enough to write the exit line AND the group-wide marker.
    const { code, log } = await runWrapper("kill -TERM 0")
    expect(code).toBe(143)
    expect(log).toContain(
      "wrapper: bun process exited (code=143, signal=SIGTERM)",
    )
    expect(log).toContain(
      "wrapper: wrapper itself received SIGTERM — signal was delivered group-wide",
    )
  })
})
