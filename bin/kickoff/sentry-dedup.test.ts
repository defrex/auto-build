import { describe, expect, test } from "bun:test"
import {
  classifyTicketState,
  decideSentryTriage,
  extractSentryBreadcrumbs,
  type SentryNote,
  selectLatestSentryBreadcrumb,
} from "./sentry-dedup"

const LINEAR = {
  doneStateId: "state_done",
  rejectedStateIds: ["state_canceled", "state_wontdo"],
}

function marker(obj: Record<string, unknown>): string {
  return `<!-- dispatch-sentry-triage: ${JSON.stringify(obj)} -->`
}

const VALID = {
  linearTicketId: "PRO-372",
  linearTicketUuid: "11111111-1111-1111-1111-111111111111",
  url: "https://linear.app/dispatch/issue/PRO-372",
}

describe("extractSentryBreadcrumbs", () => {
  test("extracts a single canonical marker", () => {
    const body = [
      "Dispatch triaged this Sentry issue into Linear: PRO-372 — https://linear.app/dispatch/issue/PRO-372",
      marker(VALID),
    ].join("\n")
    const out = extractSentryBreadcrumbs(body)
    expect(out).toEqual([
      {
        linearTicketId: "PRO-372",
        linearTicketUuid: "11111111-1111-1111-1111-111111111111",
        url: "https://linear.app/dispatch/issue/PRO-372",
      },
    ])
  })

  test("extracts two markers in document order", () => {
    const body = [
      marker({ ...VALID, linearTicketId: "PRO-1", url: "u1" }),
      marker({ ...VALID, linearTicketId: "PRO-2", url: "u2" }),
    ].join("\n")
    const out = extractSentryBreadcrumbs(body)
    expect(out.map((b) => b.linearTicketId)).toEqual(["PRO-1", "PRO-2"])
  })

  test("malformed JSON inside the marker is skipped, not thrown", () => {
    const body = "<!-- dispatch-sentry-triage: {not json} -->"
    expect(extractSentryBreadcrumbs(body)).toEqual([])
  })

  test("a marker whose linearTicketId is malformed is skipped", () => {
    const body = marker({ ...VALID, linearTicketId: "not-a-ref" })
    expect(extractSentryBreadcrumbs(body)).toEqual([])
  })

  test("a marker whose url is empty is skipped", () => {
    const body = marker({ ...VALID, url: "" })
    expect(extractSentryBreadcrumbs(body)).toEqual([])
  })

  test("linearTicketUuid is optional", () => {
    const body = marker({ linearTicketId: "PRO-9", url: "https://x/PRO-9" })
    expect(extractSentryBreadcrumbs(body)).toEqual([
      { linearTicketId: "PRO-9", url: "https://x/PRO-9" },
    ])
  })

  test("a prose-only note mentioning Linear has no marker → []", () => {
    const body = "I filed this manually as Linear PRO-123, see the board."
    expect(extractSentryBreadcrumbs(body)).toEqual([])
  })
})

describe("selectLatestSentryBreadcrumb", () => {
  function note(body: string, createdAt: string): SentryNote {
    return { body, createdAt }
  }

  test("returns the breadcrumb from the max-createdAt note (out of order)", () => {
    const notes = [
      note(
        marker({ ...VALID, linearTicketId: "PRO-1", url: "u1" }),
        "2026-01-01T00:00:00Z",
      ),
      note(
        marker({ ...VALID, linearTicketId: "PRO-3", url: "u3" }),
        "2026-03-01T00:00:00Z",
      ),
      note(
        marker({ ...VALID, linearTicketId: "PRO-2", url: "u2" }),
        "2026-02-01T00:00:00Z",
      ),
    ]
    expect(selectLatestSentryBreadcrumb(notes)?.linearTicketId).toBe("PRO-3")
  })

  test("no valid breadcrumb anywhere → null", () => {
    const notes = [note("just prose about PRO-1", "2026-01-01T00:00:00Z")]
    expect(selectLatestSentryBreadcrumb(notes)).toBeNull()
  })

  test("a lone breadcrumb with an unparsable createdAt is still returned", () => {
    const notes = [note(marker(VALID), "not-a-date")]
    expect(selectLatestSentryBreadcrumb(notes)?.linearTicketId).toBe("PRO-372")
  })

  test("a valid-timestamp breadcrumb beats a bad-timestamp one", () => {
    const notes = [
      note(
        marker({ ...VALID, linearTicketId: "PRO-101", url: "u" }),
        "not-a-date",
      ),
      note(
        marker({ ...VALID, linearTicketId: "PRO-202", url: "u" }),
        "2026-02-01T00:00:00Z",
      ),
    ]
    expect(selectLatestSentryBreadcrumb(notes)?.linearTicketId).toBe("PRO-202")
  })
})

describe("classifyTicketState", () => {
  test("doneStateId → done", () => {
    expect(classifyTicketState("state_done", LINEAR)).toBe("done")
  })
  test("a rejectedStateIds member → rejected", () => {
    expect(classifyTicketState("state_canceled", LINEAR)).toBe("rejected")
    expect(classifyTicketState("state_wontdo", LINEAR)).toBe("rejected")
  })
  test("any other id → non-terminal", () => {
    expect(classifyTicketState("state_in_progress", LINEAR)).toBe(
      "non-terminal",
    )
  })
})

describe("decideSentryTriage", () => {
  test("no breadcrumb + actionable → file-new", () => {
    expect(
      decideSentryTriage({
        breadcrumb: null,
        ticketTerminality: null,
        inActionableQuery: true,
      }),
    ).toBe("file-new")
  })

  test("breadcrumb + non-terminal → skip (in flight)", () => {
    expect(
      decideSentryTriage({
        breadcrumb: VALID,
        ticketTerminality: "non-terminal",
        inActionableQuery: true,
      }),
    ).toBe("skip")
  })

  test("breadcrumb + done + actionable → file-regression", () => {
    expect(
      decideSentryTriage({
        breadcrumb: VALID,
        ticketTerminality: "done",
        inActionableQuery: true,
      }),
    ).toBe("file-regression")
  })

  test("breadcrumb + rejected + actionable → file-regression", () => {
    expect(
      decideSentryTriage({
        breadcrumb: VALID,
        ticketTerminality: "rejected",
        inActionableQuery: true,
      }),
    ).toBe("file-regression")
  })

  test("breadcrumb + done + not actionable → skip (defensive)", () => {
    expect(
      decideSentryTriage({
        breadcrumb: VALID,
        ticketTerminality: "done",
        inActionableQuery: false,
      }),
    ).toBe("skip")
  })

  test("breadcrumb + unknown terminality (null) → skip (can't confirm)", () => {
    // A breadcrumb exists but the linked ticket's state couldn't be resolved.
    // Never re-file on an unconfirmed ticket — that risks a duplicate.
    expect(
      decideSentryTriage({
        breadcrumb: VALID,
        ticketTerminality: null,
        inActionableQuery: true,
      }),
    ).toBe("skip")
  })
})
