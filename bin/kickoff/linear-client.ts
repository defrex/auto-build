/**
 * Deterministic Linear GraphQL transport for the kickoff loop.
 *
 * This is the single network seam that replaces the OAuth Linear MCP (which is
 * only reachable from inside an agent process). It authenticates with a personal
 * API key from `LINEAR_API_KEY` (hand-managed in `.env`) and POSTs raw GraphQL
 * to Linear's public endpoint, so the select/restore steps can run headless or
 * on a cron without an interactive agent session.
 *
 * Pure transport only — query/mutation strings live in the callers
 * (`select.ts`, `restore-select.ts`). Errors SURFACE (per CLAUDE.md): a missing
 * key, a non-2xx response, or a GraphQL `errors[]` payload all throw, so a
 * failure rides the existing `runSelect` → kickoff "treat as failure, not empty
 * queue" path instead of being swallowed.
 */

/** Run one GraphQL operation and return its `data` payload (typed by caller). */
export type LinearGraphql = <T>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>

export type LinearGraphqlOptions = {
  /** API key override; defaults to `process.env.LINEAR_API_KEY` at call time. */
  apiKey?: string | undefined
  /** `fetch` override for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Endpoint override; defaults to Linear's public GraphQL API. */
  endpoint?: string
}

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql"

/**
 * Build a {@link LinearGraphql} bound to a key/fetch/endpoint. The default
 * binding ({@link linearGraphql}) reads `LINEAR_API_KEY` lazily on each call, so
 * the env can be set after import. Linear personal API keys go in the
 * `Authorization` header VERBATIM (no `Bearer` prefix).
 */
export function makeLinearGraphql(
  options: LinearGraphqlOptions = {},
): LinearGraphql {
  return async <T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> => {
    const apiKey = options.apiKey ?? process.env.LINEAR_API_KEY
    if (!apiKey) {
      throw new Error(
        "LINEAR_API_KEY is not set — add it to .env (Linear → Settings → Security & access → Personal API keys). The kickoff select steps need it to query Linear.",
      )
    }
    const fetchImpl = options.fetchImpl ?? fetch
    const endpoint = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT

    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: apiKey,
      },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)")
      throw new Error(
        `Linear GraphQL error: ${res.status} ${res.statusText} — ${body.slice(0, 500)}`,
      )
    }
    const json = (await res.json()) as { data?: T; errors?: unknown }
    if (json.errors) {
      throw new Error(
        `Linear GraphQL returned errors: ${JSON.stringify(json.errors).slice(0, 500)}`,
      )
    }
    return json.data as T
  }
}

/** Default client — reads `LINEAR_API_KEY` from the environment at call time. */
export const linearGraphql: LinearGraphql = makeLinearGraphql()
