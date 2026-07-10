import { describe, expect, test } from "bun:test"
import {
  type ClassifiedHole,
  classifyHoles,
  collectOpenHoles,
  decideReviewAction,
  type Hole,
  normalizeClaim,
  parseAdversarialVerdict,
  parseReviewInput,
  type ReviewRound,
  sameHole,
  splitHolesBySeverity,
  validateResolutionVerdicts,
} from "./adversarial-review-verdict"

function hole(over: Partial<Hole> = {}): Hole {
  return {
    id: over.id ?? "h1",
    claim: over.claim ?? "The mechanism is X",
    weakness: over.weakness ?? "no evidence X happens",
    resolution: over.resolution ?? "fetch event Y",
    severity: over.severity ?? "medium",
  }
}

const validVerdict = {
  verdict: "holes",
  holes: [
    {
      id: "h1",
      claim: "The mechanism is X",
      weakness: "no evidence",
      resolution: "fetch event Y",
      severity: "high",
    },
  ],
  confidence: "medium",
  summary: "Found one hole.",
}

describe("parseAdversarialVerdict", () => {
  test("extracts a valid verdict from a fenced json block surrounded by prose", () => {
    const output = `Here is my review.\n\n\`\`\`json\n${JSON.stringify(validVerdict)}\n\`\`\`\n\nThanks.`
    const parsed = parseAdversarialVerdict(output)
    expect(parsed?.verdict).toBe("holes")
    expect(parsed?.holes).toHaveLength(1)
    expect(parsed?.holes[0]?.id).toBe("h1")
  })

  test("prefers the LAST valid json block when several appear", () => {
    const first = { ...validVerdict, summary: "first" }
    const last = { ...validVerdict, summary: "last" }
    const output = `\`\`\`json\n${JSON.stringify(first)}\n\`\`\`\nmore\n\`\`\`json\n${JSON.stringify(last)}\n\`\`\``
    expect(parseAdversarialVerdict(output)?.summary).toBe("last")
  })

  test("parses a bare top-level JSON object with no fence", () => {
    const output = `Some prose.\n${JSON.stringify(validVerdict)}`
    expect(parseAdversarialVerdict(output)?.verdict).toBe("holes")
  })

  test("returns null on no JSON", () => {
    expect(parseAdversarialVerdict("just words, no json here")).toBeNull()
  })

  test("returns null on invalid JSON inside a fence", () => {
    expect(parseAdversarialVerdict("```json\n{not valid}\n```")).toBeNull()
  })

  test("returns null on schema mismatch (missing verdict)", () => {
    const { verdict, ...rest } = validVerdict
    expect(
      parseAdversarialVerdict(`\`\`\`json\n${JSON.stringify(rest)}\n\`\`\``),
    ).toBeNull()
  })

  test("returns null when a hole is missing its id", () => {
    const bad = {
      ...validVerdict,
      holes: [{ claim: "c", weakness: "w", resolution: "r", severity: "low" }],
    }
    expect(
      parseAdversarialVerdict(`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``),
    ).toBeNull()
  })

  test("returns null on a bad severity value", () => {
    const bad = { ...validVerdict, confidence: "extreme" }
    expect(
      parseAdversarialVerdict(`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``),
    ).toBeNull()
  })

  test("sufficient verdict with omitted holes defaults to []", () => {
    const suff = { verdict: "sufficient", confidence: "high", summary: "ok" }
    const parsed = parseAdversarialVerdict(
      `\`\`\`json\n${JSON.stringify(suff)}\n\`\`\``,
    )
    expect(parsed?.verdict).toBe("sufficient")
    expect(parsed?.holes).toEqual([])
  })

  test("returns null on a 'holes' verdict with no holes (self-contradictory)", () => {
    const bad = {
      verdict: "holes",
      confidence: "medium",
      summary: "needs evidence",
    }
    expect(
      parseAdversarialVerdict(`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``),
    ).toBeNull()
  })

  test("returns null on a 'sufficient' verdict that still carries holes", () => {
    const bad = { ...validVerdict, verdict: "sufficient" }
    expect(
      parseAdversarialVerdict(`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``),
    ).toBeNull()
  })

  test("'holes' with empty holes but a REJECTED resolution parses (round-2 reject)", () => {
    const v = {
      verdict: "holes",
      holes: [],
      resolutions: [{ id: "h1", accepted: false, reason: "still open" }],
      confidence: "medium",
      summary: "prior hole still open",
    }
    const parsed = parseAdversarialVerdict(
      `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``,
    )
    expect(parsed?.verdict).toBe("holes")
    expect(parsed?.resolutions[0]?.accepted).toBe(false)
  })

  test("returns null on 'holes' with empty holes and only ACCEPTED resolutions", () => {
    const bad = {
      verdict: "holes",
      holes: [],
      resolutions: [{ id: "h1", accepted: true, reason: "closed" }],
      confidence: "high",
      summary: "nothing open",
    }
    expect(
      parseAdversarialVerdict(`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``),
    ).toBeNull()
  })

  test("returns null on 'sufficient' carrying a REJECTED resolution", () => {
    const bad = {
      verdict: "sufficient",
      resolutions: [{ id: "h1", accepted: false, reason: "still open" }],
      confidence: "high",
      summary: "contradiction",
    }
    expect(
      parseAdversarialVerdict(`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``),
    ).toBeNull()
  })

  test("'sufficient' with only ACCEPTED resolutions parses", () => {
    const v = {
      verdict: "sufficient",
      resolutions: [{ id: "h1", accepted: true, reason: "closed" }],
      confidence: "high",
      summary: "all prior holes closed",
    }
    const parsed = parseAdversarialVerdict(
      `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``,
    )
    expect(parsed?.verdict).toBe("sufficient")
    expect(parsed?.resolutions[0]?.accepted).toBe(true)
  })

  test("resolutions omitted defaults to []", () => {
    const parsed = parseAdversarialVerdict(
      `\`\`\`json\n${JSON.stringify(validVerdict)}\n\`\`\``,
    )
    expect(parsed?.resolutions).toEqual([])
  })

  test("returns null when a resolution entry is missing `accepted`", () => {
    const bad = {
      verdict: "holes",
      holes: [],
      resolutions: [{ id: "h1", reason: "no accepted field" }],
      confidence: "medium",
      summary: "malformed resolution",
    }
    expect(
      parseAdversarialVerdict(`\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``),
    ).toBeNull()
  })
})

describe("normalizeClaim", () => {
  test("folds case, whitespace, and punctuation", () => {
    expect(normalizeClaim("The   Mechanism, is X!")).toBe(
      normalizeClaim("the mechanism is x"),
    )
  })

  test("distinct claims stay distinct", () => {
    expect(normalizeClaim("mechanism is X")).not.toBe(
      normalizeClaim("mechanism is Y"),
    )
  })
})

describe("sameHole", () => {
  test("same id, different wording → true", () => {
    expect(
      sameHole(
        hole({ id: "h1", claim: "the foo breaks" }),
        hole({ id: "h1", claim: "totally different words" }),
      ),
    ).toBe(true)
  })

  test("different id, same normalized claim → true", () => {
    expect(
      sameHole(
        hole({ id: "a", claim: "The mechanism is X." }),
        hole({ id: "b", claim: "the mechanism is x" }),
      ),
    ).toBe(true)
  })

  test("different id and different claim → false", () => {
    expect(
      sameHole(
        hole({ id: "a", claim: "mechanism is X" }),
        hole({ id: "b", claim: "scope is wrong" }),
      ),
    ).toBe(false)
  })
})

describe("classifyHoles", () => {
  test("round 1 (empty priorRounds) → all new", () => {
    const result = classifyHoles([hole({ id: "h1" }), hole({ id: "h2" })], [])
    expect(result.every((h) => h.isNew)).toBe(true)
  })

  test("a hole whose id matches a prior round → isNew false", () => {
    const prior: ReviewRound[] = [
      { round: 1, holes: [hole({ id: "h1" })], resolutions: [] },
    ]
    const result = classifyHoles([hole({ id: "h1", claim: "reworded" })], prior)
    expect(result[0]?.isNew).toBe(false)
  })

  test("an id-less restatement (same normalized claim) → isNew false", () => {
    const prior: ReviewRound[] = [
      {
        round: 1,
        holes: [hole({ id: "x", claim: "The thing breaks" })],
        resolutions: [],
      },
    ]
    const result = classifyHoles(
      [hole({ id: "y", claim: "the thing breaks!" })],
      prior,
    )
    expect(result[0]?.isNew).toBe(false)
  })

  test("a genuinely new claim+id → isNew true", () => {
    const prior: ReviewRound[] = [
      { round: 1, holes: [hole({ id: "h1", claim: "old" })], resolutions: [] },
    ]
    const result = classifyHoles(
      [hole({ id: "h9", claim: "brand new" })],
      prior,
    )
    expect(result[0]?.isNew).toBe(true)
  })

  test("matches against holes spread across multiple prior rounds", () => {
    const prior: ReviewRound[] = [
      { round: 1, holes: [hole({ id: "h1" })], resolutions: [] },
      { round: 2, holes: [hole({ id: "h2" })], resolutions: [] },
    ]
    const result = classifyHoles(
      [hole({ id: "h2" }), hole({ id: "h3", claim: "a brand new concern" })],
      prior,
    )
    expect(result[0]?.isNew).toBe(false) // h2 from round 2
    expect(result[1]?.isNew).toBe(true) // h3 is new
  })
})

describe("validateResolutionVerdicts", () => {
  const priorHigh = (id: string): ReviewRound => ({
    round: 1,
    holes: [hole({ id, severity: "high" })],
    resolutions: [],
  })
  const holesVerdict = parseAdversarialVerdict(
    `\`\`\`json\n${JSON.stringify(validVerdict)}\n\`\`\``,
  )
  function withResolutions(
    resolutions: { id: string; accepted: boolean; reason: string }[],
  ) {
    const v = {
      ...validVerdict,
      resolutions,
    }
    const parsed = parseAdversarialVerdict(
      `\`\`\`json\n${JSON.stringify(v)}\n\`\`\``,
    )
    if (!parsed) throw new Error("test fixture failed to parse")
    return parsed
  }

  test("round 1 → ok (nothing prior to judge)", () => {
    if (!holesVerdict) throw new Error("fixture")
    expect(validateResolutionVerdicts(holesVerdict, [], 1)).toEqual({
      ok: true,
    })
  })

  test("empty priorRounds → ok", () => {
    if (!holesVerdict) throw new Error("fixture")
    expect(validateResolutionVerdicts(holesVerdict, [], 2)).toEqual({
      ok: true,
    })
  })

  test("round 2, both prior holes judged → ok", () => {
    const prior: ReviewRound[] = [
      {
        round: 1,
        holes: [
          hole({ id: "h1", severity: "high" }),
          hole({ id: "h2", severity: "high" }),
        ],
        resolutions: [],
      },
    ]
    const v = withResolutions([
      { id: "h1", accepted: true, reason: "closed" },
      { id: "h2", accepted: false, reason: "still open" },
    ])
    expect(validateResolutionVerdicts(v, prior, 2)).toEqual({ ok: true })
  })

  test("round 2, missing a prior hole → not ok, names it", () => {
    const prior: ReviewRound[] = [
      {
        round: 1,
        holes: [
          hole({ id: "h1", severity: "high" }),
          hole({ id: "h2", severity: "high" }),
        ],
        resolutions: [],
      },
    ]
    const v = withResolutions([{ id: "h1", accepted: true, reason: "closed" }])
    const result = validateResolutionVerdicts(v, prior, 2)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("h2")
  })

  test("round 2, duplicate resolution id → not ok, names the dup", () => {
    const prior = [priorHigh("h1")]
    const v = withResolutions([
      { id: "h1", accepted: true, reason: "a" },
      { id: "h1", accepted: false, reason: "b" },
    ])
    const result = validateResolutionVerdicts(v, prior, 2)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("h1")
  })

  test("round 2, unknown id tolerated when every real prior hole is judged", () => {
    const prior = [priorHigh("h1")]
    const v = withResolutions([
      { id: "h1", accepted: true, reason: "closed" },
      { id: "ghost", accepted: false, reason: "no such prior hole" },
    ])
    expect(validateResolutionVerdicts(v, prior, 2)).toEqual({ ok: true })
  })
})

describe("collectOpenHoles", () => {
  const parse = (over: Record<string, unknown>) => {
    const parsed = parseAdversarialVerdict(
      `\`\`\`json\n${JSON.stringify({ ...validVerdict, ...over })}\n\`\`\``,
    )
    if (!parsed) throw new Error("test fixture failed to parse")
    return parsed
  }

  test("round 1: raised holes all included and isNew", () => {
    const v = parse({
      holes: [hole({ id: "h1", severity: "high" })],
    })
    const open = collectOpenHoles(v, [])
    expect(open).toHaveLength(1)
    expect(open[0]?.isNew).toBe(true)
  })

  test("rejected prior hole carried with prior severity, isNew false", () => {
    const prior: ReviewRound[] = [
      {
        round: 1,
        holes: [hole({ id: "h1", severity: "high" })],
        resolutions: [],
      },
    ]
    const v = parse({
      holes: [],
      resolutions: [{ id: "h1", accepted: false, reason: "still open" }],
      verdict: "holes",
    })
    const open = collectOpenHoles(v, prior)
    expect(open).toHaveLength(1)
    expect(open[0]?.id).toBe("h1")
    expect(open[0]?.isNew).toBe(false)
    expect(open[0]?.severity).toBe("high")
  })

  test("accepted prior hole is dropped", () => {
    const prior: ReviewRound[] = [
      {
        round: 1,
        holes: [hole({ id: "h1", severity: "high" })],
        resolutions: [],
      },
    ]
    const v = parse({
      holes: [hole({ id: "h9", claim: "new concern", severity: "high" })],
      resolutions: [{ id: "h1", accepted: true, reason: "closed" }],
    })
    const open = collectOpenHoles(v, prior)
    expect(open.map((h) => h.id)).toEqual(["h9"])
  })

  test("rejected prior that is also re-raised appears once", () => {
    const prior: ReviewRound[] = [
      {
        round: 1,
        holes: [hole({ id: "h1", severity: "high" })],
        resolutions: [],
      },
    ]
    const v = parse({
      holes: [hole({ id: "h1", severity: "high" })],
      resolutions: [{ id: "h1", accepted: false, reason: "still open" }],
    })
    const open = collectOpenHoles(v, prior)
    expect(open).toHaveLength(1)
    expect(open[0]?.id).toBe("h1")
  })

  test("rejected resolution with unknown id is ignored", () => {
    const prior: ReviewRound[] = [
      {
        round: 1,
        holes: [hole({ id: "h1", severity: "high" })],
        resolutions: [],
      },
    ]
    const v = parse({
      holes: [hole({ id: "h1", severity: "high" })],
      resolutions: [
        { id: "h1", accepted: false, reason: "still open" },
        { id: "ghost", accepted: false, reason: "no such prior hole" },
      ],
    })
    const open = collectOpenHoles(v, prior)
    expect(open.map((h) => h.id)).toEqual(["h1"])
  })
})

describe("splitHolesBySeverity", () => {
  test("high → blocking; low/medium → caveats", () => {
    const open: ClassifiedHole[] = [
      { ...hole({ id: "hi", severity: "high" }), isNew: true },
      { ...hole({ id: "med", severity: "medium" }), isNew: true },
      { ...hole({ id: "lo", severity: "low" }), isNew: true },
    ]
    const { blocking, caveats } = splitHolesBySeverity(open)
    expect(blocking.map((h) => h.id)).toEqual(["hi"])
    expect(caveats.map((h) => h.id)).toEqual(["med", "lo"])
  })
})

describe("decideReviewAction", () => {
  const base = {
    available: true,
    verdict: parseAdversarialVerdict(
      `\`\`\`json\n${JSON.stringify(validVerdict)}\n\`\`\``,
    ),
    openHoles: [{ ...hole({ id: "h1", severity: "high" }), isNew: true }],
    round: 1,
    cap: 3,
    hadPriorHoles: false,
  }

  test("available false → stop-unavailable regardless of round", () => {
    expect(decideReviewAction({ ...base, available: false, round: 1 })).toBe(
      "stop-unavailable",
    )
    expect(decideReviewAction({ ...base, available: false, round: 99 })).toBe(
      "stop-unavailable",
    )
  })

  test("sufficient verdict → stop-sufficient", () => {
    const suff = parseAdversarialVerdict(
      `\`\`\`json\n${JSON.stringify({ verdict: "sufficient", confidence: "high", summary: "ok" })}\n\`\`\``,
    )
    expect(decideReviewAction({ ...base, verdict: suff, openHoles: [] })).toBe(
      "stop-sufficient",
    )
  })

  test("only low/medium open holes → stop-clean (round 1)", () => {
    expect(
      decideReviewAction({
        ...base,
        openHoles: [{ ...hole({ id: "h1", severity: "medium" }), isNew: true }],
      }),
    ).toBe("stop-clean")
  })

  test("only low/medium open holes → stop-clean at round === cap", () => {
    expect(
      decideReviewAction({
        ...base,
        openHoles: [{ ...hole({ id: "h1", severity: "low" }), isNew: true }],
        round: 3,
        cap: 3,
        hadPriorHoles: true,
      }),
    ).toBe("stop-clean")
  })

  test("blocking hole all repeats + hadPriorHoles → stop-no-new-holes", () => {
    expect(
      decideReviewAction({
        ...base,
        openHoles: [{ ...hole({ id: "h1", severity: "high" }), isNew: false }],
        hadPriorHoles: true,
        round: 2,
      }),
    ).toBe("stop-no-new-holes")
  })

  test("has a new blocking hole but round === cap → stop-cap", () => {
    expect(
      decideReviewAction({
        ...base,
        openHoles: [{ ...hole({ id: "h1", severity: "high" }), isNew: true }],
        round: 3,
        cap: 3,
      }),
    ).toBe("stop-cap")
  })

  test("has a new blocking hole and round < cap → continue", () => {
    expect(
      decideReviewAction({
        ...base,
        openHoles: [{ ...hole({ id: "h1", severity: "high" }), isNew: true }],
        round: 1,
        cap: 3,
      }),
    ).toBe("continue")
  })

  test("precedence: sufficient beats cap", () => {
    const suff = parseAdversarialVerdict(
      `\`\`\`json\n${JSON.stringify({ verdict: "sufficient", confidence: "high", summary: "ok" })}\n\`\`\``,
    )
    expect(
      decideReviewAction({
        ...base,
        verdict: suff,
        openHoles: [],
        round: 3,
        cap: 3,
      }),
    ).toBe("stop-sufficient")
  })

  test("precedence: no-new-holes beats cap", () => {
    expect(
      decideReviewAction({
        ...base,
        openHoles: [{ ...hole({ id: "h1", severity: "high" }), isNew: false }],
        hadPriorHoles: true,
        round: 3,
        cap: 3,
      }),
    ).toBe("stop-no-new-holes")
  })

  test("precedence: clean beats cap and continue (no high open)", () => {
    expect(
      decideReviewAction({
        ...base,
        openHoles: [{ ...hole({ id: "h1", severity: "medium" }), isNew: true }],
        round: 3,
        cap: 3,
      }),
    ).toBe("stop-clean")
  })

  test("null verdict → stop-unavailable", () => {
    expect(decideReviewAction({ ...base, verdict: null })).toBe(
      "stop-unavailable",
    )
  })
})

describe("parseReviewInput", () => {
  const fullHole: Hole = {
    id: "h1",
    claim: "the mechanism is unproven",
    weakness: "no event cited",
    resolution: "cite an event",
    severity: "high",
  }

  const validInput = {
    shortId: "DISPATCH-1",
    brief: "root cause + fix",
    evidence: "evidence block",
    round: 2,
    cap: 3,
    priorRounds: [
      {
        round: 1,
        holes: [fullHole],
        resolutions: [
          { hole: fullHole, response: "fetched EVT-9", status: "resolved" },
        ],
      },
    ],
  }

  test("valid input (resolutions[].hole is a full hole) parses", () => {
    const parsed = parseReviewInput(validInput)
    expect(parsed.round).toBe(2)
    expect(parsed.priorRounds[0]?.resolutions[0]?.hole.id).toBe("h1")
  })

  test("regression: resolutions[].hole as a bare id string throws (July-6 bug)", () => {
    const bad = {
      ...validInput,
      priorRounds: [
        {
          round: 1,
          holes: [fullHole],
          resolutions: [{ hole: "h1", response: "", status: "open" }],
        },
      ],
    }
    expect(() => parseReviewInput(bad)).toThrow()
  })

  test("missing round throws", () => {
    const { round, ...bad } = validInput
    expect(() => parseReviewInput(bad)).toThrow()
  })

  test("cap omitted defaults to 3; priorRounds omitted defaults to []", () => {
    const parsed = parseReviewInput({
      shortId: "DISPATCH-1",
      brief: "b",
      evidence: "e",
      round: 1,
    })
    expect(parsed.cap).toBe(3)
    expect(parsed.priorRounds).toEqual([])
  })
})
