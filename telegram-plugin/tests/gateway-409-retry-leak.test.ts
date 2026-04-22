import { describe, it, expect, vi } from "vitest";
import { runWithRetry, withTimeout, type RetryableHandle } from "../gateway/run-with-retry";

/**
 * Regression guard for the 2026-04-22 grammy-runner connection leak.
 *
 * Incident (live observation): pid 1566402, 13× "starting bot polling"
 * log lines, 11× GrammyError 409, and 3 ESTABLISHED TCP connections to
 * api.telegram.org on a single gateway process.
 *
 * Root cause: the inline retry loop in gateway.ts and server.ts
 * overwrote `runnerHandle = run(bot)` on each 409 retry WITHOUT calling
 * `.stop()` on the previous handle. @grammyjs/runner's stop() triggers
 * an AbortController that closes the underlying fetch() long-poll.
 * Without it, stale pollers accumulated, each holding its own TCP
 * connection, each getting 409'd by Telegram — a positive-feedback
 * storm.
 *
 * Fix: the pure runWithRetry helper in ../gateway/run-with-retry.ts
 * guarantees "stop old → run new" ordering. This test pins that
 * contract so we can't regress without red.
 */

function makeHandle(
  stopImpl: () => Promise<void> = async () => {},
): RetryableHandle & { id: number; running: boolean; _resolveTask: (err?: Error) => void } {
  let resolveTask!: (err?: Error) => void;
  const task = new Promise<void>((resolve, reject) => {
    resolveTask = (err?: Error) => (err ? reject(err) : resolve());
  });
  const handle = {
    id: Math.floor(Math.random() * 1e9),
    running: true,
    _resolveTask: resolveTask,
    task: () => task,
    stop: async () => {
      handle.running = false;
      await stopImpl();
    },
  };
  return handle;
}

describe("runWithRetry — 409 teardown contract", () => {
  it("calls stop() on the previous handle exactly once per retry, always before next run()", async () => {
    // Sequence of call events lets us assert ordering: run-N then stop-N
    // must appear before run-(N+1).
    const events: string[] = [];
    let runCount = 0;
    let lastHandle: ReturnType<typeof makeHandle> | null = null;

    const loopPromise = runWithRetry({
      run: () => {
        runCount += 1;
        events.push(`run-${runCount}`);
        const h = makeHandle(async () => {
          events.push(`stop-${runCount}`);
        });
        lastHandle = h;
        // Fire 409 on every attempt except the 3rd, which resolves gracefully.
        if (runCount < 3) {
          queueMicrotask(() => h._resolveTask(new Error("409")));
        } else {
          queueMicrotask(() => h._resolveTask());
        }
        return h;
      },
      shouldRetry: (err) => (err as Error).message === "409",
      sleep: async () => {},
      maxAttempts: 5,
    });

    await loopPromise;

    // Exactly 3 runs happened (2 retries + 1 graceful).
    expect(runCount).toBe(3);
    // Every handle ever created was stopped — including the final one
    // that resolved gracefully (graceful-exit drain keeps the local ref clean).
    const runs = events.filter((e) => e.startsWith("run-")).length;
    const stops = events.filter((e) => e.startsWith("stop-")).length;
    expect(runs).toBe(3);
    expect(stops).toBe(3);
    // Ordering: run-1, stop-1, run-2, stop-2, run-3, stop-3
    expect(events).toEqual(["run-1", "stop-1", "run-2", "stop-2", "run-3", "stop-3"]);
    void lastHandle;
  });

  it("5 consecutive 409s produce AT MOST 1 live handle at any point (stops == runs-1 mid-flight)", async () => {
    // Track "live" handle set. Invariant: size <= 1 at all times.
    const live = new Set<number>();
    let maxLive = 0;
    let runCount = 0;

    await runWithRetry({
      run: () => {
        runCount += 1;
        const h = makeHandle(async () => {
          live.delete(h.id);
        });
        live.add(h.id);
        if (live.size > maxLive) maxLive = live.size;
        // 5 failed attempts then 1 graceful success.
        if (runCount <= 5) {
          queueMicrotask(() => h._resolveTask(new Error("409")));
        } else {
          queueMicrotask(() => h._resolveTask());
        }
        return h;
      },
      shouldRetry: (err) => (err as Error).message === "409",
      sleep: async () => {},
      maxAttempts: 10,
    });

    expect(runCount).toBe(6);
    expect(maxLive).toBe(1); // THE invariant the 2026-04-22 leak violated
    expect(live.size).toBe(0); // everything drained on exit
  });

  it("a stubbed stop() that hangs 10s is bounded by the 3s timeout; retry proceeds", async () => {
    // Real timers + short stopTimeoutMs (50ms) + shorter "hang" (500ms) so
    // the test runs in real time without fake-timer coordination issues.
    // This still proves the invariant: a stop() that takes longer than the
    // timeout MUST NOT block the retry loop.
    let runCount = 0;
    const stopFailures: unknown[] = [];
    const t0 = Date.now();

    await runWithRetry({
      run: () => {
        runCount += 1;
        const h = makeHandle(async () => {
          // Hangs far longer than the 50ms stop timeout.
          await new Promise((r) => setTimeout(r, 500));
        });
        queueMicrotask(() => h._resolveTask(new Error("409")));
        return h;
      },
      shouldRetry: (err, attempt) =>
        (err as Error).message === "409" && attempt < 2,
      sleep: async () => {},
      stopTimeoutMs: 50,
      maxAttempts: 2,
      onStopFailure: (err) => stopFailures.push(err),
    });
    const elapsed = Date.now() - t0;

    expect(runCount).toBe(2); // retry proceeded despite the hanging stop
    expect(stopFailures.length).toBeGreaterThanOrEqual(1);
    expect(String(stopFailures[0])).toMatch(/timeout/i);
    // Loose upper bound — if stop() had blocked, we'd see 500ms × 2 handles.
    // 400ms gives plenty of slack for CI noise while still catching a regression.
    expect(elapsed).toBeLessThan(400);
  });

  it("graceful task() resolution: loop returns cleanly, no double-stop", async () => {
    let stopCount = 0;
    let runCount = 0;

    await runWithRetry({
      run: () => {
        runCount += 1;
        const h = makeHandle(async () => {
          stopCount += 1;
        });
        queueMicrotask(() => h._resolveTask()); // graceful
        return h;
      },
      shouldRetry: () => false,
      sleep: async () => {},
      maxAttempts: 3,
    });

    expect(runCount).toBe(1);
    expect(stopCount).toBe(1); // stopped exactly once (graceful-exit drain)
  });

  it("non-retryable fatal error: loop exits, outstanding handle is stopped", async () => {
    let stopCount = 0;
    let runCount = 0;
    const fatals: unknown[] = [];

    await runWithRetry({
      run: () => {
        runCount += 1;
        const h = makeHandle(async () => {
          stopCount += 1;
        });
        queueMicrotask(() => h._resolveTask(new Error("fatal boom")));
        return h;
      },
      shouldRetry: (err) => (err as Error).message === "409", // not our error
      sleep: async () => {},
      maxAttempts: 3,
      onFatal: (err) => fatals.push(err),
    });

    expect(runCount).toBe(1); // did not retry
    expect(stopCount).toBe(1); // handle was drained on fatal exit
    expect(fatals).toHaveLength(1);
    expect(String(fatals[0])).toMatch(/fatal boom/);
  });

  it("stop() is called exactly once per handle (no double-stop on graceful path)", async () => {
    // Map of handle-id -> stop call count. Must never exceed 1.
    const stopCounts = new Map<number, number>();
    let runCount = 0;

    await runWithRetry({
      run: () => {
        runCount += 1;
        const h = makeHandle(async () => {
          stopCounts.set(h.id, (stopCounts.get(h.id) ?? 0) + 1);
        });
        if (runCount < 3) {
          queueMicrotask(() => h._resolveTask(new Error("409")));
        } else {
          queueMicrotask(() => h._resolveTask());
        }
        return h;
      },
      shouldRetry: (err) => (err as Error).message === "409",
      sleep: async () => {},
      maxAttempts: 5,
    });

    for (const [id, count] of stopCounts) {
      expect(count, `handle ${id} stopped ${count} times`).toBe(1);
    }
  });
});

describe("withTimeout", () => {
  it("resolves with value when the promise resolves in time", async () => {
    const result = await withTimeout(Promise.resolve(42), 100);
    expect(result).toBe(42);
  });

  it("rejects with a timeout error when the promise hangs past ms", async () => {
    const hang = new Promise<never>(() => {}); // never resolves
    await expect(withTimeout(hang, 10)).rejects.toThrow(/timeout after 10ms/);
  });

  it("propagates the underlying rejection when it fires first", async () => {
    const err = new Error("real error");
    await expect(withTimeout(Promise.reject(err), 100)).rejects.toBe(err);
  });
});

/**
 * Source-level guards: read gateway.ts and server.ts, assert the production
 * retry flow delegates to the unit-tested runWithRetry helper. Once inline
 * retry loops are replaced with helper calls, the helper's own unit tests
 * (above) validate production — but we still guard the wiring so nobody
 * accidentally re-inlines a custom loop and drifts from the helper's
 * "drain before retry" invariant.
 */
describe("production retry flow delegates to runWithRetry helper", () => {
  it("gateway.ts imports runWithRetry and calls it with the expected hooks", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../gateway/gateway.ts", import.meta.url),
      "utf8",
    );

    // Pin the distinctive comment marker (kept as a grep-friendly anchor).
    expect(src).toContain("─── 409 retry teardown ───");
    // Helper is imported from the same module as withTimeout.
    expect(src).toMatch(/import\s*\{[^}]*runWithRetry[^}]*\}\s*from\s*['"]\.\/run-with-retry\.js['"]/);
    // Helper is actually called (not just imported).
    expect(src).toMatch(/runWithRetry</);
    // shouldRetry narrows on GrammyError 409 (unchanged behavior).
    expect(src).toMatch(/err instanceof GrammyError && err\.error_code === 409/);
    // Heavy setup is gated by !didOneTimeSetup inside beforeRun.
    expect(src).toMatch(/beforeRun/);
    expect(src).toMatch(/if\s*\(didOneTimeSetup\)\s*return/);
    // Retry-specific log line present (UX polish).
    expect(src).toContain("retry attempt=");
    // Back-compat log line kept so existing greps still match.
    expect(src).toContain("409 Conflict, retrying in");
    // shutdown() nulls runnerHandle and bounds stop() with withTimeout.
    expect(src).toMatch(/withTimeout\(h\.stop\(\),\s*2000\)/);
    expect(src).toMatch(/runnerHandle\s*=\s*null/);
  });

  it("server.ts imports runWithRetry and calls it with the expected hooks", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../server.ts", import.meta.url),
      "utf8",
    );

    expect(src).toContain("─── 409 retry teardown ───");
    expect(src).toMatch(/import\s*\{[^}]*runWithRetry[^}]*\}\s*from\s*['"]\.\/gateway\/run-with-retry\.js['"]/);
    expect(src).toMatch(/runWithRetry</);
    expect(src).toMatch(/err instanceof GrammyError && err\.error_code === 409/);
    expect(src).toMatch(/beforeRun/);
    expect(src).toMatch(/if\s*\(didOneTimeSetup\)\s*return/);
    expect(src).toContain("retry attempt=");
    expect(src).toContain("409 Conflict");
    // shutdown() bounds stop() with withTimeout.
    expect(src).toMatch(/withTimeout\(Promise\.resolve\(h\.stop\(\)\),\s*2000\)/);
    expect(src).toMatch(/runnerHandle\s*=\s*null/);
  });

  it("gateway.ts no longer contains an inline `for (let attempt` retry loop", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../gateway/gateway.ts", import.meta.url),
      "utf8",
    );
    // The prior inline loop was the home of the 2026-04-22 leak. Pin that
    // it's gone so a well-meaning refactor can't re-introduce it silently.
    expect(src).not.toMatch(/for\s*\(let\s+attempt\s*=\s*1\s*;/);
  });

  it("server.ts no longer contains an inline `for (let attempt` retry loop", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../server.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/for\s*\(let\s+attempt\s*=\s*1\s*;/);
  });
});

/**
 * Retry-specific log line: UX polish. Prior to this, both first-boot and
 * in-process retries wrote the exact same "starting bot polling" line,
 * which made the 2026-04-22 leak ("13× starting bot polling") hard to
 * read. The new line fires ONLY on retry so operators can distinguish
 * fresh boot from in-process retry at a glance.
 */
describe("retry log line fires only on retry, not on first boot", () => {
  it("onAttempt fires on attempt 1, onRetry does not", async () => {
    const onAttempt = vi.fn();
    const onRetry = vi.fn();

    await runWithRetry({
      run: () => {
        const h = makeHandle();
        queueMicrotask(() => h._resolveTask()); // graceful on first attempt
        return h;
      },
      shouldRetry: () => false,
      sleep: async () => {},
      maxAttempts: 3,
      onAttempt,
      onRetry,
    });

    expect(onAttempt).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledWith(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("onRetry fires on attempt 2 with attempt number=1 (the one that just failed)", async () => {
    const onAttempt = vi.fn();
    const onRetry = vi.fn();
    let runCount = 0;

    await runWithRetry({
      run: () => {
        runCount += 1;
        const h = makeHandle();
        if (runCount === 1) {
          queueMicrotask(() => h._resolveTask(new Error("409")));
        } else {
          queueMicrotask(() => h._resolveTask());
        }
        return h;
      },
      shouldRetry: (err) => (err as Error).message === "409",
      sleep: async () => {},
      maxAttempts: 3,
      onAttempt,
      onRetry,
    });

    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    // onRetry is called with the attempt number that just failed (=1).
    // Production gateway.ts logs `attempt=${attempt + 1}` so the log
    // reads as the UPCOMING attempt number (=2), matching operator intuition.
    expect(onRetry).toHaveBeenCalledWith(expect.any(Error), 1);
  });
});

/**
 * Shutdown contract: bound stop() with withTimeout + null handle after.
 * Defensive under double-SIGTERM; snappy so systemd doesn't escalate to
 * SIGKILL. This models the shape of gateway.ts/server.ts shutdown().
 */
describe("shutdown() nulls handle and bounds stop() with a timeout", () => {
  it("shutdown() that nulls the handle survives a subsequent stop() attempt", async () => {
    let handle: RetryableHandle | null = {
      task: () => new Promise(() => {}),
      stop: vi.fn(async () => {}),
    };
    const stopSpy = handle.stop as ReturnType<typeof vi.fn>;

    // First shutdown: mimic the gateway.ts shape — snapshot, null, stop.
    async function shutdown(): Promise<void> {
      if (handle != null) {
        const h = handle;
        handle = null;
        await withTimeout(h.stop(), 2000);
      }
    }

    await shutdown();
    // Second shutdown should be a no-op — handle is null.
    await shutdown();

    // stop() called exactly once across both invocations.
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(handle).toBeNull();
  });

  it("shutdown() bounds a hanging stop() at the configured timeout", async () => {
    const stopHangMs = 500;
    const stopTimeoutMs = 50;
    const handle: RetryableHandle = {
      task: () => new Promise(() => {}),
      stop: async () => {
        await new Promise((r) => setTimeout(r, stopHangMs));
      },
    };

    const t0 = Date.now();
    await expect(withTimeout(handle.stop(), stopTimeoutMs)).rejects.toThrow(
      /timeout/i,
    );
    const elapsed = Date.now() - t0;

    // Should NOT have waited anywhere near the 500ms hang.
    expect(elapsed).toBeLessThan(200);
    // Must have waited at least the timeout bound.
    expect(elapsed).toBeGreaterThanOrEqual(stopTimeoutMs - 5);
  });

  it("gateway.ts shutdown() bounds stop() with withTimeout and nulls the handle", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../gateway/gateway.ts", import.meta.url),
      "utf8",
    );
    // Isolate the shutdown() function body.
    const idx = src.indexOf("async function shutdown(): Promise<void> {");
    expect(idx).toBeGreaterThan(-1);
    // Find the matching closing brace — shutdown is roughly ~60 lines.
    const body = src.slice(idx, idx + 4000);
    // The null-before-stop idiom (const h = handle; handle = null; stop).
    expect(body).toMatch(/runnerHandle\s*=\s*null/);
    // The withTimeout(..., 2000) bound on stop() (or tighter).
    expect(body).toMatch(/withTimeout\([^)]*\.stop\(\),\s*2000\)/);
  });

  it("server.ts shutdown() bounds stop() with withTimeout and nulls the handle", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../server.ts", import.meta.url),
      "utf8",
    );
    const idx = src.indexOf("function shutdown(): void {");
    expect(idx).toBeGreaterThan(-1);
    const body = src.slice(idx, idx + 2000);
    expect(body).toMatch(/runnerHandle\s*=\s*null/);
    expect(body).toMatch(/withTimeout\([^)]*\.stop\(\)[^)]*\),\s*2000\)/);
  });
});

/**
 * beforeRun hook semantics: used in production to run one-time setup on
 * attempt 1 (gated by didOneTimeSetup). Retries skip it so 409 flaps
 * don't re-issue API calls or re-post banners.
 */
describe("runWithRetry — beforeRun hook", () => {
  it("fires beforeRun once per attempt, in order (before run())", async () => {
    const events: string[] = [];
    let runCount = 0;

    await runWithRetry({
      beforeRun: async (attempt) => {
        events.push(`beforeRun-${attempt}`);
      },
      run: () => {
        runCount += 1;
        events.push(`run-${runCount}`);
        const h = makeHandle();
        if (runCount < 2) {
          queueMicrotask(() => h._resolveTask(new Error("409")));
        } else {
          queueMicrotask(() => h._resolveTask());
        }
        return h;
      },
      shouldRetry: (err) => (err as Error).message === "409",
      sleep: async () => {},
      maxAttempts: 3,
    });

    expect(events).toEqual([
      "beforeRun-1",
      "run-1",
      "beforeRun-2",
      "run-2",
    ]);
  });

  it("gating beforeRun by a local flag mimics didOneTimeSetup — heavy work runs once across 5 retries", async () => {
    let heavySetupRuns = 0;
    let didSetup = false;
    let runCount = 0;

    await runWithRetry({
      beforeRun: async () => {
        if (didSetup) return;
        heavySetupRuns += 1;
        didSetup = true;
      },
      run: () => {
        runCount += 1;
        const h = makeHandle();
        if (runCount <= 5) {
          queueMicrotask(() => h._resolveTask(new Error("409")));
        } else {
          queueMicrotask(() => h._resolveTask());
        }
        return h;
      },
      shouldRetry: (err) => (err as Error).message === "409",
      sleep: async () => {},
      maxAttempts: 10,
    });

    expect(runCount).toBe(6);
    expect(heavySetupRuns).toBe(1); // heavy work NEVER re-runs on retry
  });

  it("a beforeRun failure is treated like a run/task failure (retry path)", async () => {
    let beforeRunCalls = 0;
    let runCalls = 0;
    const onRetry = vi.fn();

    await runWithRetry({
      beforeRun: async () => {
        beforeRunCalls += 1;
        if (beforeRunCalls === 1) throw new Error("setup failed — retry me");
      },
      run: () => {
        runCalls += 1;
        const h = makeHandle();
        queueMicrotask(() => h._resolveTask());
        return h;
      },
      shouldRetry: (err) => /retry me/.test((err as Error).message),
      sleep: async () => {},
      maxAttempts: 3,
      onRetry,
    });

    // Attempt 1: beforeRun throws -> retry path. Attempt 2: beforeRun OK,
    // run succeeds gracefully.
    expect(beforeRunCalls).toBe(2);
    expect(runCalls).toBe(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
