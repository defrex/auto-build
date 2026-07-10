import { describe, expect, test } from "bun:test"
import {
  invokeWithSentinelRetry,
  SENTINEL_RETRY_CAP,
  sentinelCorrectiveNote,
} from "./sentinel-retry"

/** A fake runner that returns canned outputs in order, capturing the prompts. */
function fakeRunner(outputs: string[]) {
  const prompts: string[] = []
  let i = 0
  return {
    prompts,
    calls: () => i,
    runner: async (prompt: string) => {
      prompts.push(prompt)
      const out = outputs[Math.min(i, outputs.length - 1)]
      i++
      return out
    },
  }
}

/** Recognizes any of the builder sentinels (BUILD_DONE / PLAN_DONE / ESCALATE). */
const hasSentinel = (o: string) => /\b(BUILD_DONE|PLAN_DONE|ESCALATE)\b/.test(o)

describe("sentinelCorrectiveNote", () => {
  test("contains the key corrective phrases", () => {
    const note = sentinelCorrectiveNote(1, SENTINEL_RETRY_CAP)
    expect(note).toContain("SINGLE-TURN")
    expect(note).toContain("FOREGROUND")
    expect(note).toContain("sentinel")
    expect(note).toContain("AUTO-RETRY 1 of 2")
  })
})

describe("invokeWithSentinelRetry", () => {
  test("first output has a sentinel → one call, zero retries, onRetry never fires", async () => {
    const f = fakeRunner(["done here\nBUILD_DONE"])
    const onRetry: number[] = []
    const { output, retries } = await invokeWithSentinelRetry({
      runner: f.runner,
      basePrompt: "BASE",
      hasSentinel,
      onRetry: (a) => onRetry.push(a),
    })
    expect(f.calls()).toBe(1)
    expect(retries).toBe(0)
    expect(onRetry).toEqual([])
    expect(output).toContain("BUILD_DONE")
    // No corrective note was appended to the single call.
    expect(f.prompts[0]).toBe("BASE")
  })

  test("no sentinel ever → 1 + cap calls, retries == cap, onRetry 1..cap, note injected", async () => {
    const f = fakeRunner(["still working, backgrounded a run"])
    const onRetry: number[] = []
    const { retries } = await invokeWithSentinelRetry({
      runner: f.runner,
      basePrompt: "BASE",
      hasSentinel,
      onRetry: (a) => onRetry.push(a),
    })
    expect(f.calls()).toBe(1 + SENTINEL_RETRY_CAP)
    expect(retries).toBe(SENTINEL_RETRY_CAP)
    expect(onRetry).toEqual([1, 2])
    // First call is the bare base prompt; each retry appends the corrective note.
    expect(f.prompts[0]).toBe("BASE")
    for (let i = 1; i <= SENTINEL_RETRY_CAP; i++) {
      expect(f.prompts[i]).toContain("BASE")
      expect(f.prompts[i]).toContain(`AUTO-RETRY ${i} of ${SENTINEL_RETRY_CAP}`)
      expect(f.prompts[i]).toContain("FOREGROUND")
    }
  })

  test("sentinel appears on the 2nd call → retries == 1, two calls", async () => {
    const f = fakeRunner(["no sentinel", "recovered\nBUILD_DONE"])
    const onRetry: number[] = []
    const { output, retries } = await invokeWithSentinelRetry({
      runner: f.runner,
      basePrompt: "BASE",
      hasSentinel,
      onRetry: (a) => onRetry.push(a),
    })
    expect(f.calls()).toBe(2)
    expect(retries).toBe(1)
    expect(onRetry).toEqual([1])
    expect(output).toContain("BUILD_DONE")
  })

  test("a genuine ESCALATE line counts as a sentinel → no retry", async () => {
    const f = fakeRunner(["ESCALATE: the plan is contradictory"])
    const onRetry: number[] = []
    const { retries } = await invokeWithSentinelRetry({
      runner: f.runner,
      basePrompt: "BASE",
      hasSentinel,
      onRetry: (a) => onRetry.push(a),
    })
    expect(f.calls()).toBe(1)
    expect(retries).toBe(0)
    expect(onRetry).toEqual([])
  })

  test("honors a custom maxRetries", async () => {
    const f = fakeRunner(["nope"])
    const { retries } = await invokeWithSentinelRetry({
      runner: f.runner,
      basePrompt: "BASE",
      hasSentinel,
      maxRetries: 1,
    })
    expect(f.calls()).toBe(2)
    expect(retries).toBe(1)
  })
})
