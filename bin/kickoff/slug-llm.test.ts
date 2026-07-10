import { describe, expect, test } from "bun:test"
import { generateSlug } from "./slug-llm"

describe("generateSlug", () => {
  test("normalizes the model's suggestion through slugify", async () => {
    const slug = await generateSlug(
      { title: "anything", brief: "" },
      async () => "Add Snooze Button",
    )
    expect(slug).toBe("add-snooze-button")
  })

  test("caps a chatty model to three words", async () => {
    const slug = await generateSlug(
      { title: "anything", brief: "" },
      async () => "add a snooze button to todos",
    )
    expect(slug).toBe("add-a-snooze")
  })

  test("falls back to slugify(title) when the model returns junk", async () => {
    const slug = await generateSlug(
      { title: "Make Reads Bounded", brief: "" },
      async () => "!!!",
    )
    expect(slug).toBe("make-reads-bounded")
  })

  test("falls back to slugify(title) when the model returns 'kickoff'", async () => {
    const slug = await generateSlug(
      { title: "Tidy The Kickoff Runner", brief: "" },
      async () => "kickoff",
    )
    expect(slug).toBe("tidy-the-kickoff")
  })

  test("falls back to slugify(title) when the model call throws", async () => {
    const slug = await generateSlug(
      { title: "Fix Flaky Webhook", brief: "" },
      async () => {
        throw new Error("gateway down")
      },
    )
    expect(slug).toBe("fix-flaky-webhook")
  })
})
