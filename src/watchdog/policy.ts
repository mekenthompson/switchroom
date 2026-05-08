/**
 * Watchdog restart policy — Phase 3b-1.
 *
 * Pure-function policy decisions, separated from the docker-events
 * subscription loop so unit tests can drive every decision branch
 * without spinning up containers.
 *
 * Decisions:
 *   - shouldRestart(observation) — given a container observation
 *     (exit, OOM, health, clean stop), return either {action:"restart"}
 *     or {action:"skip"}.
 *   - computeBackoffMs(attempt) — exponential backoff with jitter,
 *     capped at MAX_BACKOFF_MS.
 *   - isEscalationDue(state, container, nowMs, opts) — check whether
 *     bounded retries (R within W seconds) have been exceeded.
 *   - tallyHealthFails(prev, currentFail, opts) — N consecutive
 *     healthcheck-fail decision: returns {newCount, restartTriggered}.
 */

import type { WatchdogState } from "./state.js";

/** Defaults for the restart-policy configuration. */
export const DEFAULT_POLICY = Object.freeze({
  /** Initial backoff in ms — first attempt waits this long. */
  baseBackoffMs: 1000,
  /** Backoff cap; never wait longer than this between restarts. */
  maxBackoffMs: 60_000,
  /** Jitter fraction — actual delay is base * (1 ± jitter). */
  jitter: 0.2,
  /** Bounded retries: R restarts within W seconds → escalate. */
  maxRestarts: 5,
  /** Window in ms for the bounded-retries policy. */
  windowMs: 600_000,
  /** N consecutive healthcheck fails → restart. */
  healthFailThreshold: 3,
});

export type WatchdogPolicy = typeof DEFAULT_POLICY;

/**
 * Liveness observation derived from a docker event + inspect snapshot.
 * Concrete docker-events parsing lives in index.ts; this type is the
 * boundary between the parser and the policy layer.
 */
export type Observation =
  | { kind: "exit"; exitCode: number; oomKilled: boolean }
  | { kind: "health"; healthy: boolean }
  | { kind: "start" };

export type RestartDecision =
  | { action: "restart"; reason: string }
  | { action: "skip"; reason: string };

/**
 * Decide whether an observation should trigger a restart, NOT counting
 * bounded-retries / escalation (callers gate on `isEscalationDue` /
 * `WatchdogState.isEscalated()` separately).
 *
 * Health observations are stateful — we need the current
 * consecutive-fail tally. Caller passes that in; index.ts pulls it
 * from `WatchdogState`.
 */
export function shouldRestart(args: {
  observation: Observation;
  consecutiveHealthFails: number;
  policy?: WatchdogPolicy;
}): RestartDecision {
  const policy = args.policy ?? DEFAULT_POLICY;
  const obs = args.observation;
  if (obs.kind === "exit") {
    if (obs.oomKilled) {
      return { action: "restart", reason: "oom-killed" };
    }
    if (obs.exitCode === 0) {
      return { action: "skip", reason: "clean-exit" };
    }
    return { action: "restart", reason: `nonzero-exit:${obs.exitCode}` };
  }
  if (obs.kind === "health") {
    if (obs.healthy) {
      return { action: "skip", reason: "healthy" };
    }
    // Caller must increment the tally BEFORE calling shouldRestart.
    if (args.consecutiveHealthFails >= policy.healthFailThreshold) {
      return {
        action: "restart",
        reason: `health-fail-x${args.consecutiveHealthFails}`,
      };
    }
    return { action: "skip", reason: "health-fail-below-threshold" };
  }
  return { action: "skip", reason: "start-event" };
}

/**
 * Tally healthcheck fails. If the current observation is a fail,
 * increment; on recovery (`healthy=true`), reset to 0. Returns the new
 * count plus a flag indicating whether the threshold was just crossed.
 */
export function tallyHealthFails(args: {
  prev: number;
  healthy: boolean;
  policy?: WatchdogPolicy;
}): { newCount: number; restartTriggered: boolean } {
  const policy = args.policy ?? DEFAULT_POLICY;
  if (args.healthy) {
    return { newCount: 0, restartTriggered: false };
  }
  const newCount = args.prev + 1;
  return {
    newCount,
    restartTriggered: newCount >= policy.healthFailThreshold,
  };
}

/**
 * Exponential backoff with jitter:
 *   base * 2^(attempt-1), capped at maxBackoffMs, multiplied by a
 *   random factor in [1 - jitter, 1 + jitter].
 *
 * `attempt` is 1-based (first restart is attempt 1).
 */
export function computeBackoffMs(args: {
  attempt: number;
  policy?: WatchdogPolicy;
  rng?: () => number; // injectable for tests
}): number {
  const policy = args.policy ?? DEFAULT_POLICY;
  const rng = args.rng ?? Math.random;
  const exp = Math.min(
    policy.maxBackoffMs,
    policy.baseBackoffMs * Math.pow(2, Math.max(0, args.attempt - 1)),
  );
  const factor = 1 + (rng() * 2 - 1) * policy.jitter;
  return Math.max(0, Math.round(exp * factor));
}

/**
 * The "raw" backoff sequence without jitter — useful for tests that
 * assert the exponential schedule directly.
 */
export function backoffWithoutJitter(args: {
  attempt: number;
  policy?: WatchdogPolicy;
}): number {
  const policy = args.policy ?? DEFAULT_POLICY;
  return Math.min(
    policy.maxBackoffMs,
    policy.baseBackoffMs * Math.pow(2, Math.max(0, args.attempt - 1)),
  );
}

/**
 * Bounded-retries check: count restarts in the trailing window. If
 * count >= maxRestarts, escalation is due.
 *
 * The state lookup is delegated to WatchdogState so this function
 * stays cheap to test against `:memory:`.
 */
export function isEscalationDue(args: {
  state: WatchdogState;
  container: string;
  nowMs: number;
  policy?: WatchdogPolicy;
}): boolean {
  const policy = args.policy ?? DEFAULT_POLICY;
  const since = args.nowMs - policy.windowMs;
  const count = args.state.countRecentRestarts(
    args.container,
    since,
    args.nowMs,
  );
  return count >= policy.maxRestarts;
}
