import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  collectObservationSignals,
  parseObservationsFile,
  signalIdFor,
} from "./observation-signals"

const SAMPLE = `# Observations — out-of-scope findings

## Unbounded collect in widget loader
- **kind:** perf
- **where:** apps/web/convex/widgets.ts:42
- **why out of scope:** pre-existing; not in this feature's plan.
- **suggestion:** paginate the read.

## Missing test for adapter
- **kind:** test-gap
- **where:** apps/web/src/lib/adapter.ts
- **suggestion:** add a round-trip test.
`

describe("parseObservationsFile", () => {
  test("parses entries with all and partial fields", () => {
    const signals = parseObservationsFile("build/payg/observations.md", SAMPLE)
    expect(signals).toHaveLength(2)
    expect(signals[0].title).toBe("Unbounded collect in widget loader")
    expect(signals[0].kind).toBe("perf")
    expect(signals[0].where).toBe("apps/web/convex/widgets.ts:42")
    expect(signals[0].featureDir).toBe("payg")
    // second entry omits `why` — tolerated as null
    expect(signals[1].why).toBeNull()
    expect(signals[1].suggestion).toBe("add a round-trip test.")
  })

  test("ignores the leading document title and unknown kinds", () => {
    const signals = parseObservationsFile(
      "build/x/observations.md",
      "# Title only\n",
    )
    expect(signals).toHaveLength(0)
    const weird = parseObservationsFile(
      "build/x/observations.md",
      "## E\n- **kind:** wat\n",
    )
    expect(weird[0].kind).toBeNull()
  })

  test("recognises the e2e-infra kind", () => {
    const signals = parseObservationsFile(
      "build/x/observations.md",
      "## No local stand-in for Stripe webhook\n- **kind:** e2e-infra\n",
    )
    expect(signals[0].kind).toBe("e2e-infra")
  })

  test("recognises the schema-narrow kind", () => {
    const signals = parseObservationsFile(
      "build/x/observations.md",
      "## Drop deprecated avatarUrl field\n- **kind:** schema-narrow\n",
    )
    expect(signals[0].kind).toBe("schema-narrow")
  })

  test("recognises the eval-infra kind", () => {
    const signals = parseObservationsFile(
      "build/x/observations.md",
      "## No eval driver for outlook sessions\n- **kind:** eval-infra\n",
    )
    expect(signals[0].kind).toBe("eval-infra")
  })
})

describe("signalIdFor", () => {
  test("is stable across whitespace reflow for the same path", () => {
    const a = signalIdFor({
      sourcePath: "build/x/observations.md",
      raw: "## E\n- **kind:** bug",
    })
    const b = signalIdFor({
      sourcePath: "build/x/observations.md",
      raw: "##   E\n\n-  **kind:**   bug\n",
    })
    expect(a).toBe(b)
    expect(a.startsWith("sha256:")).toBe(true)
  })

  test("identical entry in two different dirs → DISTINCT ids (Blocking #1)", () => {
    const raw = "## Same\n- **kind:** perf\n- **where:** a.ts:1"
    const inA = signalIdFor({ sourcePath: "build/a/observations.md", raw })
    const inB = signalIdFor({ sourcePath: "build/b/observations.md", raw })
    expect(inA).not.toBe(inB)
  })
})

describe("collectObservationSignals", () => {
  test("globs build/*/observations.md, skips build/kickoff, flat list", () => {
    const root = mkdtempSync(join(tmpdir(), "kickoff-obs-"))
    const mk = (dir: string, body: string) => {
      mkdirSync(join(root, "build", dir), { recursive: true })
      writeFileSync(join(root, "build", dir, "observations.md"), body)
    }
    mk("alpha", "## A1\n- **kind:** bug\n")
    mk("beta", "## B1\n- **kind:** perf\n## B2\n- **kind:** test-gap\n")
    mk("kickoff", "## Should be skipped\n- **kind:** bug\n")
    // a dir with no observations.md is ignored
    mkdirSync(join(root, "build", "empty"), { recursive: true })

    const signals = collectObservationSignals(root)
    const titles = signals.map((s) => s.title).sort()
    expect(titles).toEqual(["A1", "B1", "B2"])
  })

  test("missing build/ → []", () => {
    const root = mkdtempSync(join(tmpdir(), "kickoff-noobs-"))
    expect(collectObservationSignals(root)).toEqual([])
  })
})
