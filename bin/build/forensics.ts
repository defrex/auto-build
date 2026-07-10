/**
 * Crash forensics for the build orchestrator — durable, per-incident evidence
 * written into the build dir so a kill can be attributed *after the fact*.
 *
 * Two artifacts:
 *
 * - `build/<feature>/crashes.jsonl` (git-tracked, appended only on a signal or
 *   a relaunch autopsy — rare, so no commit spam): the circle-back file. Each
 *   record embeds everything needed to identify the killer without the process
 *   that died: the launch ancestry (who spawned us), the signal received,
 *   whether the parent was still alive at signal time, and whether we had been
 *   reparented (original parent already dead). NOTE: a TRAPPED signal death
 *   yields two records — the `signal` record at kill time plus an `autopsy`
 *   record on the next relaunch (state.json is still `running`). Correlate by
 *   `ts`/`lastAlive` rather than counting records as incidents.
 * - `build/<feature>/.build/launch.json` (gitignored scratch, rewritten each
 *   launch): the launch-time context a later signal handler or relaunch autopsy
 *   embeds into its crash record.
 *
 * Everything is best-effort and synchronous: these run inside signal handlers
 * where the process may be SIGKILLed milliseconds later, so cheap sync writes
 * land first and no failure may ever take the run down.
 */

import { spawnSync } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** One process in a parent chain: its pid and full command line. */
export type AncestryEntry = { pid: number; command: string }

/** Launch-time context — who spawned this orchestrator, and from where. */
export type LaunchContext = {
  ts: string
  pid: number
  ppid: number
  /** Parent chain, self first, walked toward launchd. */
  ancestry: AncestryEntry[]
  /** The `FORENSIC_ENV_KEYS` subset of the launch environment. */
  env: Record<string, string>
}

/** A crash incident — `signal` (in-process handler) or `autopsy` (relaunch). */
export type CrashRecord = {
  kind: "signal" | "autopsy"
  ts: string
  [key: string]: unknown
}

/** A `kind: "signal"` record with the fields `buildSignalCrashRecord` sets. */
export type SignalCrashRecord = CrashRecord & {
  kind: "signal"
  signal: string
  pid: number
  ppidAtSignal: number
  parentAlive: boolean
  phase: string
  launch: LaunchContext | null
}

/**
 * Env vars that identify the launching session (Claude Code session, Superset /
 * Conductor workspace, terminal) — the allowlist embedded in `LaunchContext`.
 * Never capture the whole env: it holds secrets and `crashes.jsonl` is tracked.
 */
export const FORENSIC_ENV_KEYS = [
  "CONDUCTOR_WORKSPACE_NAME",
  "TERM_SESSION_ID",
  "TERM_PROGRAM",
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "SSH_TTY",
] as const

/** Tracked per-incident record file: `build/<feature>/crashes.jsonl`. */
export function crashLogPath(buildDir: string): string {
  return join(buildDir, "crashes.jsonl")
}

/** Gitignored launch context: `build/<feature>/.build/launch.json`. */
export function launchContextPath(buildDir: string): string {
  return join(buildDir, ".build", "launch.json")
}

/** Resolve one pid to its `{ ppid, command }`, or `null`. Injectable via args. */
export type PsRunner = (pid: number) => { ppid: number; command: string } | null

/** Real `ps` probe. ~5 ms per call; 2 s timeout so a wedged ps can't hang us. */
function defaultPsRunner(
  pid: number,
): { ppid: number; command: string } | null {
  try {
    const r = spawnSync("ps", ["-o", "ppid=,command=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2_000,
    })
    if (r.status !== 0) return null
    const line = (r.stdout ?? "").trim()
    if (!line) return null
    const match = /^(\d+)\s+(.*)$/.exec(line)
    if (!match) return null
    return { ppid: Number(match[1]), command: match[2] }
  } catch {
    return null
  }
}

/**
 * Cap for one ancestry command line. Ancestors can carry an entire prompt in
 * argv (kickoff spawns builds under `claude -p '<prompt>'`); ancestry lands in
 * git-tracked files (build.log, crashes.jsonl), so bound it at the one point
 * every consumer flows through instead of auditing each sink.
 */
export const MAX_ANCESTRY_COMMAND_CHARS = 300

/**
 * Walk the parent chain from `startPid` toward launchd, self first. Bounded by
 * `maxDepth` and a seen-set (a lying/cyclic ps can't loop it); each command
 * line is capped at `MAX_ANCESTRY_COMMAND_CHARS`. Never throws; a ps failure
 * mid-walk returns whatever was collected.
 */
export function collectAncestry(
  startPid: number,
  runPs: PsRunner = defaultPsRunner,
  maxDepth = 10,
): AncestryEntry[] {
  const chain: AncestryEntry[] = []
  const seen = new Set<number>()
  let pid = startPid
  while (chain.length < maxDepth && pid > 0 && !seen.has(pid)) {
    seen.add(pid)
    const info = runPs(pid)
    if (!info) break
    const command =
      info.command.length > MAX_ANCESTRY_COMMAND_CHARS
        ? `${info.command.slice(0, MAX_ANCESTRY_COMMAND_CHARS)}…`
        : info.command
    chain.push({ pid, command })
    pid = info.ppid
  }
  return chain
}

/**
 * Capture the launch-time context (ancestry + session-identifying env) and
 * persist it to `.build/launch.json` for the signal handler / relaunch autopsy
 * to embed later. Best-effort write — a persist failure still returns the
 * in-memory context.
 */
export function captureLaunchContext(args: {
  buildDir: string
  env: NodeJS.ProcessEnv
  now: () => string
  pid?: number
  ppid?: number
  runPs?: PsRunner
}): LaunchContext {
  const pid = args.pid ?? process.pid
  const ancestry = collectAncestry(pid, args.runPs)
  const env: Record<string, string> = {}
  for (const key of FORENSIC_ENV_KEYS) {
    const value = args.env[key]
    if (value) env[key] = value
  }
  const ctx: LaunchContext = {
    ts: args.now(),
    pid,
    ppid: args.ppid ?? process.ppid,
    ancestry,
    env,
  }
  try {
    const path = launchContextPath(args.buildDir)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(ctx, null, 2)}\n`)
  } catch {
    // Best-effort persistence; the in-memory context is still usable.
  }
  return ctx
}

/** Read + parse `launch.json`, or `null` when missing / corrupt. */
export function readLaunchContext(path: string): LaunchContext | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    if (
      parsed &&
      typeof parsed.ts === "string" &&
      typeof parsed.pid === "number" &&
      Array.isArray(parsed.ancestry)
    ) {
      return parsed as LaunchContext
    }
    return null
  } catch {
    return null
  }
}

/**
 * Append one incident record as a JSON line. Sync + best-effort: called from
 * signal handlers where the next instruction may never run, so this must be
 * the FIRST thing that touches disk and can never throw.
 */
export function appendCrashRecord(path: string, record: object): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(record)}\n`)
  } catch {
    // Never take the run (or its death throes) down over forensics.
  }
}

/** Parse `crashes.jsonl`, skipping corrupt lines. `[]` on a missing file. */
export function readCrashRecords(path: string): CrashRecord[] {
  let text: string
  try {
    text = readFileSync(path, "utf-8")
  } catch {
    return []
  }
  const records: CrashRecord[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // Skip a corrupt line; keep the rest of the history readable.
    }
  }
  return records
}

/**
 * Is `pid` alive? `kill(pid, 0)` probes without signalling; EPERM means the
 * process exists but belongs to someone else — still alive.
 */
export function isPidAlive(
  pid: number,
  kill: (pid: number, signal: number) => void = (p, s) => process.kill(p, s),
): boolean {
  try {
    kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM"
  }
}

/**
 * Build the `kind: "signal"` crash record: what signal arrived, who our parent
 * was at that instant vs at launch (reparenting to pid 1 means the original
 * parent died first — a cascade, not a targeted kill), and whether that parent
 * was still alive (alive parent + SIGTERM ⇒ a deliberate kill from above).
 */
export function buildSignalCrashRecord(args: {
  signal: string
  now: () => string
  pid: number
  ppid: number
  phase: string
  launch: LaunchContext | null
  parentAlive: boolean
}): SignalCrashRecord {
  return {
    kind: "signal",
    ts: args.now(),
    signal: args.signal,
    pid: args.pid,
    ppidAtSignal: args.ppid,
    parentAlive: args.parentAlive,
    phase: args.phase,
    launch: args.launch,
  }
}

/**
 * Human-readable build.log lines for a signal crash record: one context line
 * (signal, phase, parent liveness, reparenting drift) and one launch-ancestry
 * line so the killer's likely identity is legible without opening the jsonl.
 */
export function describeSignalCrash(record: SignalCrashRecord): string[] {
  const launchPpid = record.launch?.ppid
  const drift =
    launchPpid != null && launchPpid !== record.ppidAtSignal
      ? ` (reparented ${launchPpid}→${record.ppidAtSignal} — original parent died first)`
      : ""
  // `parentAlive` is probed against the LAUNCH parent (launch.ppid), not the
  // possibly-reparented ppid-at-signal — label it as such so `ppid=1 …
  // alive=no` can't read as "pid 1 is dead".
  const lines = [
    `signal: context — ${record.signal} pid=${record.pid} ppid=${record.ppidAtSignal}${drift} launch parent alive=${record.parentAlive ? "yes" : "no"} phase=${record.phase}`,
  ]
  if (record.launch) {
    const chain = record.launch.ancestry
      .map((e) => `${e.pid} ${e.command}`)
      .join(" ← ")
    lines.push(`signal: launch ancestry — ${chain}`)
  }
  return lines
}
