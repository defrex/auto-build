/**
 * Transport tests for the deterministic Linear GraphQL client. The `fetch`
 * impl and the api key are injected (no network, no env mutation), so we can
 * pin: missing-key throws BEFORE any fetch, non-2xx surfaces status+body,
 * GraphQL `errors[]` surfaces, and the happy path returns `data` with the
 * right endpoint/headers/body.
 */

import { describe, expect, test } from "bun:test"
import { makeLinearGraphql } from "./linear-client"

/** A `fetch` fake that records calls and returns a fresh Response per call (a
 * Response body can only be read once, so we build a new one each time). */
function makeFakeFetch(makeResponse: () => Response): {
  fn: typeof fetch
  calls: { url: string; init: RequestInit | undefined }[]
} {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return makeResponse()
  }) as unknown as typeof fetch
  return { fn, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("makeLinearGraphql", () => {
  test("missing api key throws before any fetch", async () => {
    const { fn, calls } = makeFakeFetch(() => jsonResponse({ data: {} }))
    const graphql = makeLinearGraphql({ apiKey: "", fetchImpl: fn })
    await expect(graphql("query { viewer { id } }")).rejects.toThrow(
      /LINEAR_API_KEY/,
    )
    expect(calls).toHaveLength(0)
  })

  test("non-2xx throws with status and body", async () => {
    const { fn } = makeFakeFetch(() => new Response("nope", { status: 401 }))
    const graphql = makeLinearGraphql({ apiKey: "k", fetchImpl: fn })
    await expect(graphql("query {}")).rejects.toThrow(/401/)
    await expect(graphql("query {}")).rejects.toThrow(/nope/)
  })

  test("GraphQL errors[] throws", async () => {
    const { fn } = makeFakeFetch(() =>
      jsonResponse({ errors: [{ message: "Bad field x" }] }),
    )
    const graphql = makeLinearGraphql({ apiKey: "k", fetchImpl: fn })
    await expect(graphql("query {}")).rejects.toThrow(/Bad field x/)
  })

  test("happy path returns data and sends endpoint/auth/body", async () => {
    const { fn, calls } = makeFakeFetch(() =>
      jsonResponse({ data: { viewer: { id: "u1" } } }),
    )
    const graphql = makeLinearGraphql({ apiKey: "secret-key", fetchImpl: fn })
    const data = await graphql<{ viewer: { id: string } }>(
      "query Q($n:Int){ viewer { id } }",
      { n: 1 },
    )
    expect(data).toEqual({ viewer: { id: "u1" } })
    expect(calls).toHaveLength(1)
    const { url, init } = calls[0]
    expect(url).toBe("https://api.linear.app/graphql")
    expect(init?.method).toBe("POST")
    const headers = init?.headers as Record<string, string>
    expect(headers.Authorization).toBe("secret-key")
    expect(headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init?.body as string)).toEqual({
      query: "query Q($n:Int){ viewer { id } }",
      variables: { n: 1 },
    })
  })
})
