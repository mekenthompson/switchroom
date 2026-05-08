/**
 * Watchdog policy unit tests — Phase 3b-1.
 *
 * Drives every decision branch in policy.ts against a `:memory:`
 * SQLite-backed WatchdogState. No docker.
 */

import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import { WatchdogState } from "./state.js";
import {
  DEFAULT_POLICY,
  backoffWithoutJitter,
  computeBackoffMs,
  isEscalationDue,
  shouldRestart,
  tallyHealthFails,
} from "./policy.js";

function freshState(): WatchdogState {
  return new WatchdogState(new Database(":memory:"));
}

describe("computeBackoffMs / backoffWithoutJitter", () => {
  it("produces 1s,2s,4s,8s,... capped at 60s", () => {
    expect(backoffWithoutJitter({ attempt: 1 })).toBe(1000);
    expect(backoffWithoutJitter({ attempt: 2 })).toBe(2000);
    expect(backoffWithoutJitter({ attempt: 3 })).toBe(4000);
    expect(backoffWithoutJitter({ attempt: 4 })).toBe(8000);
    expect(backoffWithoutJitter({ attempt: 5 })).toBe(16000);
    expect(backoffWithoutJitter({ attempt: 6 })).toBe(32000);
    // 64000 → capped at 60000
    expect(backoffWithoutJitter({ attempt: 7 })).toBe(60000);
    expect(backoffWithoutJitter({ attempt: 50 })).toBe(60000);
  });

  it("applies jitter within ±20% by default", () => {
    // rng=0 -> factor = 1 - jitter; rng=1 -> factor = 1 + jitter
    const low = computeBackoffMs({ attempt: 3, rng: () => 0 });
    const high = computeBackoffMs({ attempt: 3, rng: () => 1 });
    expect(low).toBe(Math.round(4000 * 0.8));
    expect(high).toBe(Math.round(4000 * 1.2));
  });

  it("respects the cap with jitter applied", () => {
    const high = computeBackoffMs({ attempt: 20, rng: () => 1 });
    // cap is 60000, 1.2x = 72000; we cap BEFORE jitter, so this is 72000.
    // The contract is "exponential capped, jittered" — assert it's around
    // 60s ±20%.
    expect(high).toBeGreaterThanOrEqual(48000);
    expect(high).toBeLessThanOrEqual(72000);
  });
});

describe("shouldRestart", () => {
  it("clean exit (code 0) → skip", () => {
    expect(
      shouldRestart({
        observation: { kind: "exit", exitCode: 0, oomKilled: false },
        consecutiveHealthFails: 0,
      }),
    ).toEqual({ action: "skip", reason: "clean-exit" });
  });

  it("non-zero exit → restart", () => {
    const d = shouldRestart({
      observation: { kind: "exit", exitCode: 137, oomKilled: false },
      consecutiveHealthFails: 0,
    });
    expect(d.action).toBe("restart");
  });

  it("OOM-killed → restart even if exit code is 0", () => {
    const d = shouldRestart({
      observation: { kind: "exit", exitCode: 0, oomKilled: true },
      consecutiveHealthFails: 0,
    });
    expect(d).toEqual({ action: "restart", reason: "oom-killed" });
  });

  it("healthy observation → skip", () => {
    expect(
      shouldRestart({
        observation: { kind: "health", healthy: true },
        consecutiveHealthFails: 5,
      }).action,
    ).toBe("skip");
  });

  it("health-fail below threshold → skip", () => {
    expect(
      shouldRestart({
        observation: { kind: "health", healthy: false },
        consecutiveHealthFails: 1,
      }).action,
    ).toBe("skip");
    expect(
      shouldRestart({
        observation: { kind: "health", healthy: false },
        consecutiveHealthFails: 2,
      }).action,
    ).toBe("skip");
  });

  it("health-fail at threshold (3) → restart", () => {
    const d = shouldRestart({
      observation: { kind: "health", healthy: false },
      consecutiveHealthFails: 3,
    });
    expect(d.action).toBe("restart");
  });
});

describe("tallyHealthFails", () => {
  it("increments on fail", () => {
    expect(tallyHealthFails({ prev: 0, healthy: false })).toEqual({
      newCount: 1,
      restartTriggered: false,
    });
    expect(tallyHealthFails({ prev: 2, healthy: false })).toEqual({
      newCount: 3,
      restartTriggered: true,
    });
  });

  it("resets on healthy", () => {
    expect(tallyHealthFails({ prev: 5, healthy: true })).toEqual({
      newCount: 0,
      restartTriggered: false,
    });
  });

  it("intermittent fails do not trigger when interleaved with healthy", () => {
    const policy = DEFAULT_POLICY;
    let count = 0;
    // fail, fail, healthy, fail, fail → never reaches 3 consecutive.
    for (const healthy of [false, false, true, false, false]) {
      const r = tallyHealthFails({ prev: count, healthy, policy });
      count = r.newCount;
      expect(r.restartTriggered).toBe(false);
    }
    expect(count).toBe(2);
  });
});

describe("isEscalationDue (bounded retries: 5 within 600s)", () => {
  it("5 restarts within 600s → escalation due", () => {
    const state = freshState();
    const nowMs = 1_000_000;
    for (let i = 0; i < 5; i++) {
      state.recordRestart({
        container: "c1",
        ts: nowMs - i * 60_000, // each 60s apart, all within 600s
        reason: "exit",
        attempt: i + 1,
      });
    }
    expect(isEscalationDue({ state, container: "c1", nowMs })).toBe(true);
  });

  it("5 restarts spread over >600s → escalation NOT due", () => {
    const state = freshState();
    const nowMs = 10_000_000;
    // 5 restarts spaced 200s apart spans 800s > 600s window.
    for (let i = 0; i < 5; i++) {
      state.recordRestart({
        container: "c1",
        ts: nowMs - i * 200_000,
        reason: "exit",
        attempt: i + 1,
      });
    }
    // Only restarts within (nowMs - 600s) count. That's the first 4
    // (at offsets 0, 200s, 400s, 600s — boundary inclusive). Actually
    // offset 600s == windowStart so it's included; offset 800s is not.
    // count = 4 < 5 → not escalated.
    expect(isEscalationDue({ state, container: "c1", nowMs })).toBe(false);
  });

  it("4 restarts in window → not yet due", () => {
    const state = freshState();
    const nowMs = 1_000_000;
    for (let i = 0; i < 4; i++) {
      state.recordRestart({
        container: "c1",
        ts: nowMs - i * 1000,
        reason: "exit",
        attempt: i + 1,
      });
    }
    expect(isEscalationDue({ state, container: "c1", nowMs })).toBe(false);
  });

  it("does not bleed across containers", () => {
    const state = freshState();
    const nowMs = 1_000_000;
    for (let i = 0; i < 5; i++) {
      state.recordRestart({
        container: "c1",
        ts: nowMs - i * 1000,
        reason: "exit",
        attempt: i + 1,
      });
    }
    expect(isEscalationDue({ state, container: "c2", nowMs })).toBe(false);
  });
});
