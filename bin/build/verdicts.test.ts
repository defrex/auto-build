import { describe, expect, test } from "bun:test"
import {
  parseBuilderVerdict,
  parseCodeReviewVerdict,
  parseE2eExecuteVerdict,
  parseE2eReportVerdict,
  parseEvalExecuteVerdict,
  parseEvalReportVerdict,
  parsePlanReviewVerdict,
} from "./verdicts"

describe("parseBuilderVerdict", () => {
  test("recognises the done sentinel on its own line", () => {
    expect(parseBuilderVerdict("did stuff\nPLAN_DONE", "PLAN_DONE")).toEqual({
      kind: "done",
    })
    expect(parseBuilderVerdict("built it\nBUILD_DONE", "BUILD_DONE")).toEqual({
      kind: "done",
    })
  })

  test("requires the matching done token", () => {
    expect(parseBuilderVerdict("BUILD_DONE", "PLAN_DONE")).toBeNull()
  })

  test("parses ESCALATE with a reason", () => {
    expect(
      parseBuilderVerdict(
        "tried\nESCALATE: plan contradicts design",
        "PLAN_DONE",
      ),
    ).toEqual({ kind: "escalate", reason: "plan contradicts design" })
  })

  test("ESCALATE without a reason falls back to a placeholder", () => {
    expect(parseBuilderVerdict("ESCALATE", "BUILD_DONE")).toEqual({
      kind: "escalate",
      reason: "no reason given",
    })
  })

  test("returns null when no sentinel is present", () => {
    expect(parseBuilderVerdict("just some prose", "PLAN_DONE")).toBeNull()
  })

  test("last sentinel wins", () => {
    const out = "ESCALATE: early doubt\nresolved it\nPLAN_DONE"
    expect(parseBuilderVerdict(out, "PLAN_DONE")).toEqual({ kind: "done" })
  })

  test("ignores sentinel tokens embedded in prose", () => {
    expect(
      parseBuilderVerdict("I will emit PLAN_DONE when finished.", "PLAN_DONE"),
    ).toBeNull()
  })

  test("tolerates trailing whitespace and blank lines", () => {
    expect(parseBuilderVerdict("PLAN_DONE  \n\n", "PLAN_DONE")).toEqual({
      kind: "done",
    })
  })
})

describe("parsePlanReviewVerdict", () => {
  test("APPROVED / NEEDS_REVISION", () => {
    expect(parsePlanReviewVerdict("looks good\nAPPROVED")).toEqual({
      kind: "approved",
    })
    expect(parsePlanReviewVerdict("missing X\nNEEDS_REVISION")).toEqual({
      kind: "needs_revision",
    })
  })

  test("ESCALATE carries the reason", () => {
    expect(parsePlanReviewVerdict("ESCALATE: needs product call")).toEqual({
      kind: "escalate",
      reason: "needs product call",
    })
  })

  test("recognises a bold Verdict label with a backtick-wrapped token", () => {
    expect(
      parsePlanReviewVerdict("looks good\n**Verdict:** `APPROVED`"),
    ).toEqual({ kind: "approved" })
  })

  test("null when absent", () => {
    expect(parsePlanReviewVerdict("no verdict here")).toBeNull()
  })
})

describe("parseCodeReviewVerdict", () => {
  test("CLEAN / BLOCKING", () => {
    expect(parseCodeReviewVerdict("nothing left\nCLEAN")).toEqual({
      kind: "clean",
    })
    expect(parseCodeReviewVerdict("[blocking] foo\nBLOCKING")).toEqual({
      kind: "blocking",
    })
  })

  test("ESCALATE carries the reason", () => {
    expect(parseCodeReviewVerdict("ESCALATE: repeated thrash")).toEqual({
      kind: "escalate",
      reason: "repeated thrash",
    })
  })

  test("null when absent", () => {
    expect(parseCodeReviewVerdict("findings but no verdict")).toBeNull()
  })

  test("recognises a backtick-wrapped sentinel after a Verdict: label", () => {
    // Reviewers (codex) phrase their summary as "Verdict: `BLOCKING`" — a
    // backtick-wrapped token with a label prefix, not a bare sentinel line.
    expect(
      parseCodeReviewVerdict("findings...\n\nVerdict: `BLOCKING`"),
    ).toEqual({ kind: "blocking" })
    expect(parseCodeReviewVerdict("all good\nVerdict: `CLEAN`")).toEqual({
      kind: "clean",
    })
  })

  test("recognises a bare backtick-wrapped sentinel line", () => {
    expect(parseCodeReviewVerdict("done\n`BLOCKING`")).toEqual({
      kind: "blocking",
    })
  })

  test("does not match a backticked token mid-sentence", () => {
    expect(
      parseCodeReviewVerdict("this is not `BLOCKING` in my view"),
    ).toBeNull()
  })
})

describe("parseE2eExecuteVerdict", () => {
  test("E2E_PASS → pass", () => {
    expect(parseE2eExecuteVerdict("all flows green\nE2E_PASS")).toEqual({
      kind: "pass",
    })
  })

  test("E2E_FAIL carries the reason", () => {
    expect(parseE2eExecuteVerdict("tried\nE2E_FAIL: login 500s")).toEqual({
      kind: "fail",
      reason: "login 500s",
    })
  })

  test("bare E2E_FAIL falls back to a placeholder reason", () => {
    expect(parseE2eExecuteVerdict("E2E_FAIL")).toEqual({
      kind: "fail",
      reason: "no reason given",
    })
  })

  test("null when no sentinel is present", () => {
    expect(parseE2eExecuteVerdict("just some prose")).toBeNull()
  })

  test("last sentinel wins", () => {
    expect(
      parseE2eExecuteVerdict("E2E_FAIL: early doubt\nfixed it\nE2E_PASS"),
    ).toEqual({ kind: "pass" })
  })

  test("recognises a Verdict:-prefixed backtick-wrapped token", () => {
    expect(parseE2eExecuteVerdict("done\nVerdict: `E2E_PASS`")).toEqual({
      kind: "pass",
    })
  })
})

describe("parseE2eReportVerdict", () => {
  test("last non-empty line is E2E_PASS → pass", () => {
    expect(
      parseE2eReportVerdict(
        "# e2e report\n\nexercised login: ![login](screenshots/login.png)\n\nE2E_PASS",
      ),
    ).toEqual({ kind: "pass" })
  })

  test("last non-empty line is E2E_FAIL: <reason> → fail with reason", () => {
    expect(parseE2eReportVerdict("# report\n\nE2E_FAIL: login 500s")).toEqual({
      kind: "fail",
      reason: "login 500s",
    })
  })

  test("E2E_PASS followed by trailing prose → null (malformed report)", () => {
    expect(
      parseE2eReportVerdict(
        "# report\n\nE2E_PASS\n\nI did not actually finish writing the final verdict.",
      ),
    ).toBeNull()
  })

  test("no sentinel anywhere → null", () => {
    expect(parseE2eReportVerdict("# report with no verdict line")).toBeNull()
  })

  test("trailing blank lines are ignored when finding the terminal line", () => {
    expect(parseE2eReportVerdict("all green\nE2E_PASS\n\n\n")).toEqual({
      kind: "pass",
    })
  })

  test("Verdict:-prefixed backtick-wrapped terminal line still recognised", () => {
    expect(parseE2eReportVerdict("done\n\nVerdict: `E2E_PASS`")).toEqual({
      kind: "pass",
    })
  })
})

describe("parseEvalExecuteVerdict", () => {
  test("EVAL_PASS → pass (last sentinel wins over trailing prose)", () => {
    expect(
      parseEvalExecuteVerdict("EVAL_FAIL: early doubt\nre-ran\nEVAL_PASS"),
    ).toEqual({ kind: "pass" })
  })

  test("EVAL_FAIL carries the reason", () => {
    expect(
      parseEvalExecuteVerdict("ran\nEVAL_FAIL: gmail/reply regressed"),
    ).toEqual({ kind: "fail", reason: "gmail/reply regressed" })
  })

  test("bare EVAL_FAIL falls back to a placeholder reason", () => {
    expect(parseEvalExecuteVerdict("EVAL_FAIL")).toEqual({
      kind: "fail",
      reason: "no reason given",
    })
  })

  test("null when no sentinel is present", () => {
    expect(parseEvalExecuteVerdict("just some prose")).toBeNull()
  })

  test("recognises a Verdict:-prefixed backtick-wrapped token", () => {
    expect(parseEvalExecuteVerdict("done\nVerdict: `EVAL_PASS`")).toEqual({
      kind: "pass",
    })
  })
})

describe("parseEvalReportVerdict", () => {
  test("last non-empty line is EVAL_PASS → pass", () => {
    expect(
      parseEvalReportVerdict("# eval report\n\nran gmail/reply\n\nEVAL_PASS"),
    ).toEqual({ kind: "pass" })
  })

  test("EVAL_PASS followed by trailing prose → null (terminal-line strict)", () => {
    expect(
      parseEvalReportVerdict("# report\n\nEVAL_PASS\n\nnot actually done."),
    ).toBeNull()
  })

  test("EVAL_FAIL: <reason> terminal line → fail with reason", () => {
    expect(
      parseEvalReportVerdict("# report\n\nEVAL_FAIL: case x failed"),
    ).toEqual({ kind: "fail", reason: "case x failed" })
  })

  test("no sentinel anywhere → null", () => {
    expect(parseEvalReportVerdict("# report with no verdict line")).toBeNull()
  })
})
