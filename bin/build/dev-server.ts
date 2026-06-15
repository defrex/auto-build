/**
 * Dev-server lifecycle guard for the e2e step of the validate gate.
 *
 * The standing "don't launch the dev server" rule exists to avoid *duplicate*
 * dev-server processes in one worktree. build relaxes it with a
 * launch-only-if-not-running guard owned by the script: it probes the dev URL,
 * spawns the top-level `bun run dev` only when nothing is already serving, and
 * tears down only the process it started — never a server you launched.
 *
 * See `build/build-flow/design.html` → "e2e & the dev server".
 */

import { type ChildProcess, spawn } from "node:child_process"
import { basename } from "node:path"

/**
 * Derive the dev URL exactly as `CLAUDE.md` / `bin/dev.sh` document: the
 * subdomain is `CONDUCTOR_WORKSPACE_NAME` when set, else the repo dir basename.
 * In sandbox/CI mode (`CI=1` or `PORTLESS_PORT` set) it falls back to plain
 * HTTP on a non-privileged port.
 */
export function deriveDevUrl(env: NodeJS.ProcessEnv, repoRoot: string): string {
  const name = env.CONDUCTOR_WORKSPACE_NAME ?? basename(repoRoot)
  const isSandbox = env.CI === "1" || Boolean(env.PORTLESS_PORT)
  if (isSandbox) {
    const port = env.PORTLESS_PORT ?? "1355"
    return `http://${name}.dispatch.localhost:${port}`
  }
  return `https://${name}.dispatch.localhost`
}

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{ status: number; headers: { get(name: string): string | null } }>

/**
 * The default probe fetch. Crucially it disables TLS verification: portless
 * terminates https with a locally-signed CA that Node/Bun does NOT trust by
 * default, so a plain `fetch` throws `SELF_SIGNED_CERT_IN_CHAIN` *before* we can
 * read the response — and the old cert-error fallback below then mapped that to
 * "reachable: true". But portless presents that same untrusted cert for
 * UNREGISTERED hosts too, so the cert error was ambiguous and silently masked
 * the "nothing is serving" case: `withDevServer` skipped launching and e2e hit
 * portless's 404 page. Ignoring cert validation here (it's localhost; we only
 * care about the status + `x-portless` header, never the payload) lets us always
 * read the real response so the status-pair logic below actually runs. Bun
 * honours `tls.rejectUnauthorized`; the cast keeps `tsc` happy since `tls` isn't
 * in the DOM `RequestInit`.
 */
const defaultProbeFetch: FetchLike = (url, init) =>
  fetch(url, {
    ...init,
    tls: { rejectUnauthorized: false },
  } as RequestInit)

/**
 * Is a dev server already serving `url`? Any HTTP response counts as reachable
 * EXCEPT the portless daemon's own "no app registered" page. portless holds
 * :443 and answers *every* host — including worktrees with no dev server — with
 * a branded 404 that carries an `x-portless` header. Treating that 404 as
 * "already serving" was a real bug: `withDevServer` skipped launching, and the
 * e2e step then talked to portless's 404 page (auth 404s, no flow runs). So a
 * `404` + `x-portless` means "nothing is serving this worktree" → not reachable,
 * and `withDevServer` launches the dev server. A running dev server serves the
 * app (2xx/3xx) at the probed root URL, so this never misfires on a real server.
 * (portless stamps `x-portless` on proxied responses too, hence the status pair:
 * the header alone can't distinguish its own error page from a backend reply.)
 *
 * The default probe disables TLS verification (see `defaultProbeFetch`) so the
 * untrusted-portless-CA cert error never short-circuits this decision. A genuine
 * TLS/connection error that still escapes is treated as reachable only when it
 * looks like a live-but-untrusted handshake; connection-refused / DNS failures
 * mean nothing is there.
 */
export async function reachable(
  url: string,
  fetchImpl: FetchLike = defaultProbeFetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(url, { method: "HEAD" })
    if (
      response.status === 404 &&
      response.headers.get("x-portless") !== null
    ) {
      return false
    }
    return true
  } catch (error) {
    const message = String(
      (error as { message?: unknown })?.message ?? error,
    ).toLowerCase()
    const code = String((error as { code?: unknown })?.code ?? "").toLowerCase()
    if (
      message.includes("certificate") ||
      message.includes("self-signed") ||
      message.includes("self signed") ||
      code.includes("cert")
    ) {
      return true
    }
    return false
  }
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

export type WaitOpts = {
  timeoutMs?: number
  intervalMs?: number
  reachableImpl?: (url: string) => Promise<boolean>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** Poll `url` until it's reachable or the timeout elapses. Returns success. */
export async function waitUntilReachable(
  url: string,
  opts: WaitOpts = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const intervalMs = opts.intervalMs ?? 2_000
  const isReachable = opts.reachableImpl ?? ((u: string) => reachable(u))
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? (() => Date.now())

  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (await isReachable(url)) return true
    await sleep(intervalMs)
  }
  return await isReachable(url)
}

export type WithDevServerArgs<T> = {
  devUrl: string
  repoRoot: string
  run: (devUrl: string) => Promise<T>
  /** Override the dev-server spawn (tests). Defaults to top-level `bun run dev`. */
  spawnDev?: (repoRoot: string) => ChildProcess
  /** Override teardown (tests). Defaults to killing the spawned process group. */
  killDev?: (child: ChildProcess) => void
  reachableImpl?: (url: string) => Promise<boolean>
  waitImpl?: (url: string) => Promise<boolean>
}

/**
 * `bun run dev` spawns a tree (next, dev:convex, portless registration).
 * `detached: true` puts them in their own process group so teardown can signal
 * the whole group — killing only the parent `bun` orphans the children and
 * leaves a stale server that the next run's `reachable()` probe would treat as
 * "already serving".
 */
function spawnDevServer(repoRoot: string): ChildProcess {
  return spawn("bun", ["run", "dev"], {
    cwd: repoRoot,
    stdio: "ignore",
    detached: true,
  })
}

/** SIGTERM the spawned process's entire group (negative pid), best-effort. */
function killDevServer(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    // Group gone or unsupported — fall back to the direct child.
    child.kill("SIGTERM")
  }
}

/**
 * Run `run(devUrl)` with a dev server guaranteed reachable. Spawns the
 * top-level `bun run dev` only if nothing is already serving, and tears down
 * only a server it started.
 */
export async function withDevServer<T>({
  devUrl,
  repoRoot,
  run,
  spawnDev = spawnDevServer,
  killDev = killDevServer,
  reachableImpl = (u: string) => reachable(u),
  waitImpl = (u: string) => waitUntilReachable(u),
}: WithDevServerArgs<T>): Promise<T> {
  let started: ChildProcess | null = null
  if (!(await reachableImpl(devUrl))) {
    started = spawnDev(repoRoot)
    const up = await waitImpl(devUrl)
    if (!up) {
      killDev(started)
      throw new Error(`dev server never became reachable at ${devUrl}`)
    }
  }
  try {
    return await run(devUrl)
  } finally {
    // Tear down ONLY a server we started; never one the user launched.
    if (started) killDev(started)
  }
}
