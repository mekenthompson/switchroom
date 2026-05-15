import { describe, expect, test } from "bun:test";
import { createFleetFallbackGate } from "../fleet-fallback-gate.js";

function fakeClock(start = 0) {
  let now = start;
  return {
    nowFn: () => now,
    advance(ms: number) { now += ms; },
    set(ms: number) { now = ms; },
  };
}

describe("createFleetFallbackGate — wouldFire honesty contract", () => {
  test("fresh state: wouldFire is true", () => {
    const gate = createFleetFallbackGate({ dedupMs: 30_000, nowFn: fakeClock().nowFn });
    expect(gate.wouldFire()).toBe(true);
  });

  test("in-flight: wouldFire is false until action resolves", async () => {
    const clock = fakeClock();
    const gate = createFleetFallbackGate({ dedupMs: 30_000, nowFn: clock.nowFn });

    let resolveAction: (b: boolean) => void = () => {};
    const action = () => new Promise<boolean>((r) => { resolveAction = r; });

    const firePromise = gate.fire(action);

    expect(gate.wouldFire()).toBe(false);
    expect(gate.inspect().inFlight).toBe(true);

    resolveAction(true);
    await firePromise;

    // After fire stamps lastFiredAtMs, dedup window blocks until clock advances.
    expect(gate.wouldFire()).toBe(false);
    clock.advance(30_000);
    expect(gate.wouldFire()).toBe(true);
  });

  test("post-fire dedup window blocks wouldFire", async () => {
    const clock = fakeClock();
    const gate = createFleetFallbackGate({ dedupMs: 30_000, nowFn: clock.nowFn });

    await gate.fire(async () => true);
    expect(gate.wouldFire()).toBe(false);

    clock.advance(29_999);
    expect(gate.wouldFire()).toBe(false);

    clock.advance(1);
    expect(gate.wouldFire()).toBe(true);
  });

  test("no-op fires (action returns false) DO NOT arm dedup window", async () => {
    const clock = fakeClock();
    const gate = createFleetFallbackGate({ dedupMs: 30_000, nowFn: clock.nowFn });

    await gate.fire(async () => false);
    // Window NOT armed — wouldFire should still be true immediately.
    expect(gate.wouldFire()).toBe(true);
    expect(gate.inspect().lastFiredAtMs).toBe(Number.NEGATIVE_INFINITY);
  });

  test("thrown action: dedup window NOT armed, gate releases in-flight", async () => {
    const clock = fakeClock();
    const gate = createFleetFallbackGate({ dedupMs: 30_000, nowFn: clock.nowFn });
    const errors: unknown[] = [];

    await gate.fire(async () => { throw new Error("broker exploded"); }, (e) => errors.push(e));

    expect(gate.inspect().inFlight).toBe(false);
    expect(gate.inspect().lastFiredAtMs).toBe(Number.NEGATIVE_INFINITY);
    expect(gate.wouldFire()).toBe(true);
    expect((errors[0] as Error).message).toBe("broker exploded");
  });

  test("no onError: thrown action still releases in-flight without crashing", async () => {
    const gate = createFleetFallbackGate({ dedupMs: 30_000, nowFn: fakeClock().nowFn });

    await gate.fire(async () => { throw new Error("silent"); });

    expect(gate.inspect().inFlight).toBe(false);
    expect(gate.wouldFire()).toBe(true);
  });
});

describe("createFleetFallbackGate — fire semantics", () => {
  test("collapses concurrent callers to one in-flight Promise", async () => {
    const clock = fakeClock();
    const gate = createFleetFallbackGate({ dedupMs: 30_000, nowFn: clock.nowFn });
    let calls = 0;
    let resolveAction: (b: boolean) => void = () => {};

    const action = () => {
      calls += 1;
      return new Promise<boolean>((r) => { resolveAction = r; });
    };

    const p1 = gate.fire(action);
    const p2 = gate.fire(action);
    const p3 = gate.fire(action);

    // Same in-flight promise returned to all three callers.
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    expect(calls).toBe(1);

    resolveAction(true);
    await Promise.all([p1, p2, p3]);
    expect(calls).toBe(1);
  });

  test("fire during dedup window resolves immediately without invoking action", async () => {
    const clock = fakeClock();
    const gate = createFleetFallbackGate({ dedupMs: 30_000, nowFn: clock.nowFn });
    let calls = 0;

    await gate.fire(async () => { calls += 1; return true; });
    expect(calls).toBe(1);

    await gate.fire(async () => { calls += 1; return true; });
    expect(calls).toBe(1);

    clock.advance(30_000);

    await gate.fire(async () => { calls += 1; return true; });
    expect(calls).toBe(2);
  });
});

describe("createFleetFallbackGate — broker reachability check", () => {
  test("brokerReachable=false makes wouldFire return false even on fresh state", () => {
    const gate = createFleetFallbackGate({
      dedupMs: 30_000,
      nowFn: fakeClock().nowFn,
      brokerReachable: () => false,
    });
    expect(gate.wouldFire()).toBe(false);
  });

  test("brokerReachable=true gates as if no check provided", () => {
    const gate = createFleetFallbackGate({
      dedupMs: 30_000,
      nowFn: fakeClock().nowFn,
      brokerReachable: () => true,
    });
    expect(gate.wouldFire()).toBe(true);
  });

  test("brokerReachable=false makes fire() short-circuit without invoking action", async () => {
    let calls = 0;
    const gate = createFleetFallbackGate({
      dedupMs: 30_000,
      nowFn: fakeClock().nowFn,
      brokerReachable: () => false,
    });

    await gate.fire(async () => { calls += 1; return true; });
    expect(calls).toBe(0);
    expect(gate.inspect().lastFiredAtMs).toBe(Number.NEGATIVE_INFINITY);
  });

  test("brokerReachable can flip from false to true between calls", async () => {
    let reachable = false;
    let calls = 0;
    const gate = createFleetFallbackGate({
      dedupMs: 30_000,
      nowFn: fakeClock().nowFn,
      brokerReachable: () => reachable,
    });

    expect(gate.wouldFire()).toBe(false);
    await gate.fire(async () => { calls += 1; return true; });
    expect(calls).toBe(0);

    reachable = true;
    expect(gate.wouldFire()).toBe(true);
    await gate.fire(async () => { calls += 1; return true; });
    expect(calls).toBe(1);
  });
});

describe("createFleetFallbackGate — reset (test seam)", () => {
  test("reset clears in-flight + lastFiredAtMs", async () => {
    const clock = fakeClock();
    const gate = createFleetFallbackGate({ dedupMs: 30_000, nowFn: clock.nowFn });

    await gate.fire(async () => true);
    expect(gate.inspect().lastFiredAtMs).toBeGreaterThan(Number.NEGATIVE_INFINITY);
    expect(gate.wouldFire()).toBe(false);

    gate.reset();
    expect(gate.inspect().lastFiredAtMs).toBe(Number.NEGATIVE_INFINITY);
    expect(gate.inspect().inFlight).toBe(false);
    expect(gate.wouldFire()).toBe(true);
  });
});
