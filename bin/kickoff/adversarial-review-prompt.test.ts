import { describe, expect, test } from "bun:test"
import { buildReviewPrompt } from "./adversarial-review-prompt"
import type { ReviewRound } from "./adversarial-review-verdict"

const base = {
  shortId: "DISPATCH-123",
  brief: "ROOT CAUSE: the widget double-fires. FIX: debounce the handler.",
  evidence: "EVIDENCE: 412 events, breadcrumb shows two clicks 3ms apart.",
  priorRounds: [] as ReviewRound[],
  round: 1,
}

describe("buildReviewPrompt", () => {
  test("states the skeptical / refute posture", () => {
    const p = buildReviewPrompt(base).toLowerCase()
    expect(p).toContain("refute")
    expect(p).toContain("adversarial")
  })

  test("states the read-only repo instruction", () => {
    const p = buildReviewPrompt(base).toLowerCase()
    expect(p).toContain("read")
    expect(p).toMatch(/do not (edit|write|modify|commit)/)
  })

  test("embeds the brief and evidence verbatim", () => {
    const p = buildReviewPrompt(base)
    expect(p).toContain(base.brief)
    expect(p).toContain(base.evidence)
  })

  test("round 1 omits the prior-rounds section", () => {
    const p = buildReviewPrompt(base)
    expect(p.toLowerCase()).not.toContain("prior round")
  })

  test("round >= 2 renders prior rounds: id, claim, response, status", () => {
    const priorRounds: ReviewRound[] = [
      {
        round: 1,
        holes: [
          {
            id: "h1",
            claim: "the mechanism is unproven",
            weakness: "no event cited",
            resolution: "cite an event",
            severity: "high",
          },
        ],
        resolutions: [
          {
            hole: {
              id: "h1",
              claim: "the mechanism is unproven",
              weakness: "no event cited",
              resolution: "cite an event",
              severity: "high",
            },
            response: "fetched event EVT-9 showing the double fire",
            status: "resolved",
          },
        ],
      },
    ]
    const p = buildReviewPrompt({ ...base, round: 2, priorRounds })
    expect(p.toLowerCase()).toContain("prior round")
    expect(p).toContain("h1")
    expect(p).toContain("the mechanism is unproven")
    expect(p).toContain("fetched event EVT-9 showing the double fire")
    expect(p).toContain("resolved")
    // the "reuse the same id" instruction
    expect(p.toLowerCase()).toMatch(/reuse[\s\S]*id/)
  })

  test("names the JSON output contract", () => {
    const p = buildReviewPrompt(base)
    expect(p).toContain("verdict")
    expect(p).toContain("holes")
    expect(p).toContain("id")
    expect(p).toContain("severity")
    expect(p).toContain("json")
  })

  test("OUTPUT_CONTRACT documents resolutions / accepted", () => {
    const p = buildReviewPrompt(base)
    expect(p).toContain("resolutions")
    expect(p).toContain("accepted")
  })

  const priorRounds: ReviewRound[] = [
    {
      round: 1,
      holes: [
        {
          id: "h1",
          claim: "the mechanism is unproven",
          weakness: "no event cited",
          resolution: "cite an event",
          severity: "high",
        },
      ],
      resolutions: [
        {
          hole: {
            id: "h1",
            claim: "the mechanism is unproven",
            weakness: "no event cited",
            resolution: "cite an event",
            severity: "high",
          },
          response: "fetched EVT-9",
          status: "resolved",
        },
      ],
    },
  ]

  test("round >= 2 narrows new-hole scope to a wrong diagnosis/fix direction", () => {
    const p = buildReviewPrompt({ ...base, round: 2, priorRounds })
    const lower = p.toLowerCase()
    expect(lower).toContain("diagnosis or fix direction is wrong")
    expect(lower).toMatch(/completeness/)
  })

  test("round >= 2 states the accept/reject resolutions contract", () => {
    const p = buildReviewPrompt({ ...base, round: 2, priorRounds })
    const lower = p.toLowerCase()
    expect(lower).toContain("every")
    expect(p).toContain("resolutions")
    expect(p).toContain("accepted")
    expect(lower).toContain("prior hole")
  })

  test("round >= 2 states all-accepted + no new hole must be 'sufficient'", () => {
    const p = buildReviewPrompt({ ...base, round: 2, priorRounds })
    expect(p.toLowerCase()).toContain("sufficient")
  })

  test("round 1 omits the scope-restriction text", () => {
    const p = buildReviewPrompt(base).toLowerCase()
    expect(p).not.toContain("scope for this round")
    expect(p).not.toContain("diagnosis or fix direction is wrong")
  })
})
