import { describe, expect, test } from "bun:test"
import { deriveDevUrl, reachable, waitUntilReachable } from "./dev-server"

describe("deriveDevUrl", () => {
  test("uses CONDUCTOR_WORKSPACE_NAME over repo basename", () => {
    expect(
      deriveDevUrl({ CONDUCTOR_WORKSPACE_NAME: "product-meetings" }, "/x/repo"),
    ).toBe("https://product-meetings.dispatch.localhost")
  })

  test("falls back to the repo dir basename", () => {
    expect(deriveDevUrl({}, "/Users/me/code/amplified-geography")).toBe(
      "https://amplified-geography.dispatch.localhost",
    )
  })

  test("CI mode uses plain HTTP on the default portless port", () => {
    expect(deriveDevUrl({ CI: "1" }, "/x/repo")).toBe(
      "http://repo.dispatch.localhost:1355",
    )
  })

  test("PORTLESS_PORT overrides the fallback port", () => {
    expect(deriveDevUrl({ PORTLESS_PORT: "8080" }, "/x/repo")).toBe(
      "http://repo.dispatch.localhost:8080",
    )
  })
})

const headersFrom = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
})

describe("reachable", () => {
  test("true on a normal app response (real dev server)", async () => {
    const ok = await reachable("https://x", async () => ({
      status: 200,
      headers: headersFrom({ "x-portless": "1" }),
    }))
    expect(ok).toBe(true)
  })

  test("false on the portless unregistered-host 404 (no dev server)", async () => {
    const ok = await reachable("https://x", async () => ({
      status: 404,
      headers: headersFrom({ "x-portless": "1", "content-type": "text/html" }),
    }))
    expect(ok).toBe(false)
  })

  test("true on a non-portless 404 (some other server is listening)", async () => {
    const ok = await reachable("https://x", async () => ({
      status: 404,
      headers: headersFrom({}),
    }))
    expect(ok).toBe(true)
  })

  test("true on a TLS/certificate error (something is listening)", async () => {
    const ok = await reachable("https://x", async () => {
      throw Object.assign(new Error("self-signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      })
    })
    expect(ok).toBe(true)
  })

  test("false on connection refused", async () => {
    const ok = await reachable("https://x", async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      })
    })
    expect(ok).toBe(false)
  })
})

describe("waitUntilReachable", () => {
  test("resolves true once the server comes up", async () => {
    let calls = 0
    const ok = await waitUntilReachable("https://x", {
      intervalMs: 0,
      reachableImpl: async () => ++calls >= 3,
      sleep: async () => {},
    })
    expect(ok).toBe(true)
    expect(calls).toBe(3)
  })

  test("returns false after the timeout", async () => {
    let t = 0
    const ok = await waitUntilReachable("https://x", {
      timeoutMs: 10,
      intervalMs: 5,
      reachableImpl: async () => false,
      sleep: async () => {},
      now: () => (t += 5),
    })
    expect(ok).toBe(false)
  })
})
