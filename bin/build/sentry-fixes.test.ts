import { describe, expect, test } from "bun:test"
import { extractSentryFixes } from "./sentry-fixes"

describe("extractSentryFixes", () => {
  test("no marker → []", () => {
    expect(extractSentryFixes("# Spec\n\nNothing here.")).toEqual([])
  })

  test("one marker → the short-id", () => {
    const spec = "Body\n<!-- sentry-fixes: PRODUCT-WEB-1A2 -->\nmore"
    expect(extractSentryFixes(spec)).toEqual(["PRODUCT-WEB-1A2"])
  })

  test("multiple markers incl. a duplicate → de-duped, in order", () => {
    const spec = [
      "<!-- sentry-fixes: PRODUCT-WEB-1A2 -->",
      "<!-- sentry-fixes: PRODUCT-WEB-9ZZ -->",
      "<!-- sentry-fixes: PRODUCT-WEB-1A2 -->",
    ].join("\n")
    expect(extractSentryFixes(spec)).toEqual([
      "PRODUCT-WEB-1A2",
      "PRODUCT-WEB-9ZZ",
    ])
  })

  test("a lowercase/garbage token is not matched (intentional [A-Z0-9-]+ breadth)", () => {
    // The `[A-Z]` class excludes lowercase, so `not-an-id` never matches even
    // though the regex deliberately accepts any uppercase token shape.
    expect(extractSentryFixes("<!-- sentry-fixes: not-an-id -->")).toEqual([])
  })
})
