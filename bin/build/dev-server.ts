/**
 * Probe + URL-derivation helpers for the e2e step's externalized dev server.
 *
 * The dev server is no longer spawned in-process. It lives in a dedicated,
 * visible herdr pane managed through `dev-server-control.ts` (see PRO-577), so
 * this module owns only the pure pieces every consumer reuses: deriving the
 * portless dev URL and probing/waiting for reachability. The
 * spawn-and-SIGTERM-a-child path that used to live here has been removed.
 *
 * See `build/build-flow/design.html` → "e2e & the dev server".
 */

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
 * the "nothing is serving" case: the start path treated it as already-serving and
 * e2e hit portless's 404 page. Ignoring cert validation here (it's localhost; we only
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
 * "already serving" was a real bug: the start path skipped launching, and the
 * e2e step then talked to portless's 404 page (auth 404s, no flow runs). So a
 * `404` + `x-portless` means "nothing is serving this worktree" → not reachable,
 * and the control surface launches the dev server. A running dev server serves the
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
  // A cold `bun run dev` in a fresh worktree (Next.js 16 compile + dev:convex
  // cold start + portless registration) routinely takes several minutes before
  // the root URL first answers, so the default deadline must be generous — a
  // tight 2-minute window spuriously blocked the e2e step on cold starts.
  const timeoutMs = opts.timeoutMs ?? 360_000
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
