/**
 * PR monitoring (phase 8): an explicit polling loop inside the script.
 *
 * GitHub has no general long-poll for PR events, so the loop polls on an
 * interval, reacts to whatever is blocking the PR (behind base, failing CI,
 * unresolved review threads), and keeps the branch reconciled + green. The loop is
 * **resident until the PR is merged or closed by a human** — it never merges
 * anything itself. Reaching "mergeable + clean + current + no threads" is the
 * non-terminal `ready` steady state: the monitor announces it once (so the human
 * knows they can merge), publishes the complete build record onto the still-open
 * branch, then keeps polling so it can pull in `origin/<base>` when a sibling PR
 * merges and main advances. Thread *resolution* stays owned by the cloud review
 * agent (per `CLAUDE.md`); the builder only fixes or pushes back.
 *
 * See `build/build-flow/design.html` → "PR creation & monitoring".
 */

/** A single status check from `gh pr view --json statusCheckRollup`. */
export type StatusCheck = {
  __typename?: string
  name?: string
  context?: string
  status?: string
  conclusion?: string
  state?: string
}

const FAILING_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
])
const FAILING_STATES = new Set(["FAILURE", "ERROR"])

/** Names of checks that have concluded in a failing state. (pure) */
export function failingCheckNames(rollup: StatusCheck[]): string[] {
  const names: string[] = []
  for (const check of rollup) {
    const failing =
      (check.conclusion && FAILING_CONCLUSIONS.has(check.conclusion)) ||
      (check.state && FAILING_STATES.has(check.state))
    if (failing) names.push(check.name ?? check.context ?? "unknown check")
  }
  return names
}

export type PrSnapshot = {
  state: string
  mergeable: string
  mergeStateStatus: string
  /** True iff origin/<base> has commits we lack. Only meaningful when baseFetchOk. */
  behindBase: boolean
  /** False iff `git fetch origin <base>` failed → cannot certify "current". */
  baseFetchOk: boolean
  failingChecks: string[]
  unresolvedThreads: number
}

/** Shape of `gh pr view --json state,mergeable,mergeStateStatus,statusCheckRollup`. */
export type PrViewJson = {
  state?: string
  mergeable?: string
  mergeStateStatus?: string
  statusCheckRollup?: StatusCheck[]
}

/**
 * Build a snapshot from `gh pr view` JSON + the unresolved-thread count + the
 * direct behind-base comparison. `behindBase`/`baseFetchOk` come from the caller
 * (a freshly-fetched `git rev-list` against `origin/<base>`), independent of
 * GitHub's branch-protection-dependent `mergeStateStatus`. (pure)
 */
export function parsePrSnapshot(
  view: PrViewJson,
  unresolvedThreads: number,
  behindBase: boolean,
  baseFetchOk: boolean,
): PrSnapshot {
  return {
    state: view.state ?? "UNKNOWN",
    mergeable: view.mergeable ?? "UNKNOWN",
    mergeStateStatus: view.mergeStateStatus ?? "UNKNOWN",
    behindBase,
    baseFetchOk,
    failingChecks: failingCheckNames(view.statusCheckRollup ?? []),
    unresolvedThreads,
  }
}

export type MonitorAction =
  | { kind: "done"; reason: string; merged: boolean }
  | { kind: "ready" }
  | { kind: "rebase" }
  | { kind: "fix-ci"; failingChecks: string[] }
  | { kind: "address-review" }
  | { kind: "wait" }

/**
 * Decide the single next action for one monitor pass, in priority order:
 * terminal (merged/closed) → reconcile (behind) → fix CI → address review threads →
 * ready (mergeable+clean+current, certified by a successful base fetch) → wait.
 * `ready` is non-terminal; only merged/closed is a true terminal. (pure)
 */
export function decideMonitorAction(pr: PrSnapshot): MonitorAction {
  if (pr.state === "MERGED" || pr.state === "CLOSED") {
    return {
      kind: "done",
      reason: `PR ${pr.state.toLowerCase()}`,
      merged: pr.state === "MERGED",
    }
  }
  // Direct comparison is the source of truth; BEHIND is sufficient-not-necessary.
  // behindBase is false when the fetch failed, and the GitHub-BEHIND fallback is
  // gated on baseFetchOk — so a failed base fetch never triggers a rebase here.
  // (Attempting one would just re-fail the same fetch inside reconcileWithBase and
  // escalate to a human for what is really a transient/unknown state; instead we
  // fall through to `wait` and re-fetch on the next active-cadence poll.)
  if (pr.behindBase || (pr.baseFetchOk && pr.mergeStateStatus === "BEHIND"))
    return { kind: "rebase" }
  if (pr.failingChecks.length > 0) {
    return { kind: "fix-ci", failingChecks: pr.failingChecks }
  }
  if (pr.unresolvedThreads > 0) return { kind: "address-review" }
  // Only certify ready when we actually fetched the base and confirmed not-behind
  // (the rebase branch above already returned if behind). A failed fetch lands in
  // wait below → keep polling actively, re-fetch next poll, never announce stale.
  if (
    pr.baseFetchOk &&
    pr.mergeable === "MERGEABLE" &&
    pr.mergeStateStatus === "CLEAN" &&
    pr.unresolvedThreads === 0
  ) {
    return { kind: "ready" }
  }
  return { kind: "wait" }
}

/**
 * Outcome of one artifact-publication attempt against the still-open PR branch.
 * Discriminated (not a bare string) so the loop can carry a "failed" detail into
 * the gave-up reason for the human. Mirrors repo.ts's PublishResult exactly, so
 * the orchestrator callback can return the repo result verbatim.
 */
export type PublishOutcome =
  | { status: "pushed" }
  | { status: "clean" }
  | { status: "failed"; detail: string }

export type MonitorPrArgs = {
  poll: () => Promise<PrSnapshot>
  act: (
    action: Exclude<
      MonitorAction,
      { kind: "done" } | { kind: "ready" } | { kind: "wait" }
    >,
  ) => Promise<void>
  sleep: (ms: number) => Promise<void>
  /** Tight poll while there's active work (behind/failing/threads/CI-pending/just-published). */
  activeIntervalMs?: number
  /** Relaxed poll while idle-ready, waiting for a human or for main to move. */
  idleIntervalMs?: number
  /**
   * Publish accumulated artifacts to the still-open PR. Called on each `ready`
   * observation BEFORE announcing. Returns:
   *  - { status: "pushed" }: PR head changed (new commit / un-pushed commit
   *    pushed) → stay active, do NOT announce (CI now pending). Resets the
   *    publish-failure streak.
   *  - { status: "clean" }:  nothing to publish AND branch in sync with upstream
   *    → the verified-green head carries the record → safe to announce. Resets
   *    the publish-failure streak.
   *  - { status: "failed"; detail }: commit or push failed → record NOT on the
   *    remote → do NOT announce. Counts toward maxPublishFailures; a transient
   *    failure self-heals on the next "clean", a persistent one gives up.
   */
  publishArtifacts?: () => Promise<PublishOutcome> | PublishOutcome
  /**
   * Fired once per *entry* into the announced-ready state. Notification only:
   * ring a bell / emit a status line to stdout. MUST NOT write to the tracked
   * build dir and MUST NOT push — doing either would re-dirty the verified-green
   * head and cause the next idle poll to re-publish + rerun CI. Pure-loop-agnostic:
   * the loop never inspects what it does.
   */
  onReady?: () => Promise<void> | void
  /** Soft warn past this many consecutive fix-ci/address-review attempts. */
  onSoftBudget?: (passes: number) => void
  softBudgetPasses?: number
  /** Hard backstop on consecutive convergence attempts (NOT idle/rebase/wait/publish). */
  maxConvergencePasses?: number
  /**
   * Hard backstop on CONSECUTIVE failed artifact-publish attempts. A persistent
   * commit/push failure means the required record can't land on the PR and needs
   * a human → gave-up (escalate). Small, because a real failure here is usually
   * non-transient (broken creds/tracking/index), not slow CI. Resets on any
   * non-failed publish or any non-ready action.
   */
  maxPublishFailures?: number
}

/**
 * Outcome of the monitor loop. `done` means a true terminal state was reached
 * (merged / closed); `gave-up` means the loop hit a hard backstop (convergence
 * or persistent publish failure) — the caller must escalate, NOT treat the run
 * as complete.
 */
export type MonitorResult =
  | { outcome: "done"; reason: string; merged: boolean }
  | { outcome: "gave-up"; reason: string }

/**
 * Poll the PR until it is merged or closed, performing one action per pass. The
 * loop is unbounded: `ready` is the non-terminal steady state (publish the record,
 * announce once, idle), and rebase/wait are budget-neutral active work. Only a
 * true terminal (merged/closed) returns `done`; only the convergence backstop or
 * a persistent publish failure returns `gave-up`.
 */
export async function monitorPr({
  poll,
  act,
  sleep,
  activeIntervalMs = 45_000,
  idleIntervalMs = 180_000,
  publishArtifacts,
  onReady,
  onSoftBudget,
  softBudgetPasses = 40,
  maxConvergencePasses = 1_000,
  maxPublishFailures = 10,
}: MonitorPrArgs): Promise<MonitorResult> {
  let convergencePasses = 0 // consecutive fix-ci/address-review attempts
  let publishFailures = 0 // consecutive failed artifact-publish attempts
  let wasReady = false // already announced ready for the current green window?
  for (;;) {
    const pr = await poll()
    const action = decideMonitorAction(pr)

    if (action.kind === "done")
      return { outcome: "done", reason: action.reason, merged: action.merged }

    if (action.kind === "ready") {
      convergencePasses = 0
      // Step 1: publish first. Only a "clean" outcome means the verified-green
      // head already carries the record and it is safe to announce.
      if (publishArtifacts) {
        const outcome = await publishArtifacts()
        if (outcome.status === "failed") {
          // Record did NOT land on the remote → not safe to announce. A
          // persistent failure needs a human; a transient one self-heals on the
          // next "clean" (which resets publishFailures below).
          publishFailures++
          if (publishFailures > maxPublishFailures) {
            return {
              outcome: "gave-up",
              reason: `artifact publication failed ${publishFailures} consecutive times: ${outcome.detail}`,
            }
          }
          wasReady = false
          await sleep(activeIntervalMs)
          continue
        }
        // "pushed" or "clean" — successful publication → reset the failure streak.
        publishFailures = 0
        if (outcome.status === "pushed") {
          // PR head changed, CI now pending → active work. Budget-neutral.
          wasReady = false
          await sleep(activeIntervalMs)
          continue
        }
        // outcome.status === "clean" → fall through to announce.
      }
      // Step 2: "clean" (or no publisher) → announce once per entry, then idle.
      if (!wasReady) {
        wasReady = true
        if (onReady) await onReady()
      }
      await sleep(idleIntervalMs)
      continue
    }

    wasReady = false
    publishFailures = 0 // any non-ready action breaks the consecutive-failure streak

    // Only deliberate fix attempts count toward non-convergence. reconcile
    // (healthy churn) and wait (CI pending) are budget-neutral but still poll tightly.
    if (action.kind === "fix-ci" || action.kind === "address-review") {
      convergencePasses++
      if (onSoftBudget && convergencePasses === softBudgetPasses)
        onSoftBudget(convergencePasses)
      if (convergencePasses > maxConvergencePasses)
        return {
          outcome: "gave-up",
          reason: `PR not converging after ${maxConvergencePasses} fix attempts`,
        }
    }

    if (action.kind !== "wait") await act(action)
    await sleep(activeIntervalMs)
  }
}
