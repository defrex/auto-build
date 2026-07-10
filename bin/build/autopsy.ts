/**
 * Relaunch forensics — the "autopsy" a fresh orchestrator writes into `build.log`
 * when it detects that a prior run of the same feature ended abnormally
 * (`state.json` stuck on `running` + a stale/missing heartbeat).
 *
 * Everything here is pure line-builders plus one bounded log-tail reader and one
 * guarded macOS memorystatus/jetsam probe. The probe is best-effort and never
 * throws; on any non-darwin platform it degrades to a documented manual command.
 */

import { spawnSync } from "node:child_process"
import { closeSync, openSync, readSync, statSync } from "node:fs"
import type { Heartbeat } from "./heartbeat"

/**
 * Read only the trailing `maxBytes` of a file (default 64 KiB), decoded utf-8.
 * Keeps the autopsy consistent with the repo's bounded-reads posture — the
 * wrapper exit line is always in the last few hundred bytes. Returns `""` on any
 * failure (missing file, read error). `parseWrapperExit` is always fed this, not
 * a full read.
 */
export function readLogTail(logPath: string, maxBytes = 65_536): string {
  let fd: number | null = null
  try {
    const size = statSync(logPath).size
    const readLen = Math.min(size, maxBytes)
    if (readLen <= 0) return ""
    const buf = Buffer.alloc(readLen)
    fd = openSync(logPath, "r")
    readSync(fd, buf, 0, readLen, size - readLen)
    return buf.toString("utf-8")
  } catch {
    return ""
  } finally {
    if (fd != null) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Return the code from the LAST `wrapper: bun process exited (code=NNN…)` line in
 * `logText`, or `null` when absent. Tolerates a trailing `, signal=…` suffix (the
 * regex stops at the digits).
 */
export function parseWrapperExit(logText: string): string | null {
  const re = /wrapper: bun process exited \(code=(\d+)/g
  let match: RegExpExecArray | null
  let last: string | null = null
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex exec loop
  while ((match = re.exec(logText)) !== null) last = match[1]
  return last
}

/**
 * Build the human-readable autopsy lines for an abnormally-ended prior run. Pure.
 * Distinct wrapper-present vs wrapper-absent sentences make the death cause
 * legible without knowing Unix exit-code conventions.
 */
export function buildAutopsyLines(args: {
  priorPhase: string
  heartbeat: Heartbeat | null
  priorUpdatedAt: string
  wrapperExit: string | null
}): string[] {
  const { priorPhase, heartbeat, priorUpdatedAt, wrapperExit } = args
  const lastAlive = heartbeat?.ts ?? priorUpdatedAt
  const source = heartbeat ? "heartbeat" : "state.updatedAt fallback"
  const pid = heartbeat?.pid ?? "?"
  const lines = [
    "autopsy: prior run ended abnormally (state.json stuck on 'running', heartbeat stale/missing)",
    `autopsy: last phase=${priorPhase}, last-alive≈${lastAlive} (${source}), pid=${pid}`,
  ]
  if (wrapperExit != null) {
    lines.push(
      `autopsy: wrapper recorded bun exit code=${wrapperExit} (137=SIGKILL/mem-pressure · 139/132=segfault/panic · 143/130/129=SIGTERM/INT/HUP · 1=in-process crash)`,
    )
  } else {
    lines.push(
      "autopsy: no wrapper exit line found — the whole process tree was killed together (a group-wide SIGKILL/forced teardown, or memory pressure — see the mem probe + crashes.jsonl)",
    )
  }
  return lines
}

/**
 * The macOS `log show` command that surfaces memorystatus/jetsam events over the
 * last 30 minutes (a robust default window; `--last` avoids the TZ-format pitfalls
 * of `--start`). Darwin only — non-darwin returns `null`. Injectable `platform`
 * so the non-darwin branch is testable.
 */
export function memorystatusProbeCommand(
  platform: NodeJS.Platform,
): { cmd: string; args: string[] } | null {
  if (platform !== "darwin") return null
  return {
    cmd: "log",
    args: [
      "show",
      "--style",
      "compact",
      "--last",
      "30m",
      "--predicate",
      'eventMessage CONTAINS "memorystatus" OR eventMessage CONTAINS "jetsam"',
    ],
  }
}

const MANUAL_PROBE_LINE =
  "autopsy: memorystatus/jetsam check — run manually: log show --last 30m --predicate 'eventMessage CONTAINS \"jetsam\"'"

const NO_KILL_EVENTS_LINE =
  "autopsy: mem: no memorystatus/jetsam kill events in the last 30m — memory pressure (H1) unlikely; suspect an external group-wide kill"

/**
 * The predicate string-matches the probe's own `log show` invocation (its args
 * contain "memorystatus"/"jetsam") and runningboardd's per-process "is not
 * RunningBoard jetsam managed" chatter — pure noise that previously drowned the
 * probe output (every autopsy "found" only its own invocations). Drop both.
 */
export function isProbeNoise(line: string): boolean {
  return (
    line.includes("log run noninteractively") ||
    line.includes("is not RunningBoard jetsam managed")
  )
}

/**
 * Best-effort macOS memorystatus/jetsam probe. Never throws. On darwin with
 * meaningful matches (self-invocation + runningboardd noise filtered out),
 * returns up to ~20 lines (preferring lines mentioning `pid` or `bun`), each
 * prefixed `autopsy: mem: `. A successful probe with NO meaningful matches
 * returns an explicit "no kill events" line — itself evidence (rules out H1).
 * On any other platform, a missing command, or a probe failure, returns the
 * single documented manual-command line.
 */
export function runMemorystatusProbe(args: {
  platform?: NodeJS.Platform
  pid?: number
  run?: (cmd: string, cmdArgs: string[]) => { ok: boolean; stdout: string }
}): string[] {
  const platform = args.platform ?? process.platform
  const cmd = memorystatusProbeCommand(platform)
  if (!cmd) return [MANUAL_PROBE_LINE]
  const run =
    args.run ??
    ((c: string, a: string[]) => {
      const r = spawnSync(c, a, { encoding: "utf-8", timeout: 10_000 })
      return { ok: r.status === 0, stdout: r.stdout ?? "" }
    })
  try {
    const result = run(cmd.cmd, cmd.args)
    if (!result.ok) return [MANUAL_PROBE_LINE]
    const all = result.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !isProbeNoise(l))
    if (all.length === 0) return [NO_KILL_EVENTS_LINE]
    const pidStr = args.pid != null ? String(args.pid) : null
    const preferred = all.filter(
      (l) => (pidStr && l.includes(pidStr)) || l.includes("bun"),
    )
    const chosen = (preferred.length > 0 ? preferred : all).slice(0, 20)
    return chosen.map((l) => `autopsy: mem: ${l}`)
  } catch {
    return [MANUAL_PROBE_LINE]
  }
}
