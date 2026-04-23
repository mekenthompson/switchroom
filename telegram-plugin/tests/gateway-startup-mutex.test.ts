/**
 * Regression tests for the gateway startup mutex + SIGTERM drain.
 *
 * Background — 2026-04-23 incident:
 *   Two clerk-gateway processes were alive simultaneously after a
 *   restart. The new one looped 13+ times on `409: Conflict: terminated
 *   by other getUpdates request` because the OLD one's long-poll TCP
 *   connection hadn't FIN'd yet. PRs #45–#50 added a PID-file probe
 *   and SIGTERM marker but no real startup mutex.
 *
 * These tests pin the invariants of the architectural fix:
 *   - Startup mutex prevents double-start when a live PID holds the file
 *   - Startup mutex auto-recovers when the holder PID is dead
 *   - Lock releases on clean shutdown
 *   - SIGTERM drain returns within budget for cooperative in-flight
 *   - SIGTERM drain reports timed_out=true when in-flight never drops
 *
 * Run with:
 *   bun test telegram-plugin/tests/gateway-startup-mutex.test.ts
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  acquireStartupLock,
  releaseStartupLock,
  type MutexRecord,
} from "../gateway/startup-mutex.js";
import { drainShutdown } from "../gateway/shutdown-drain.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpLockPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "gw-mutex-test-"));
  return { dir, path: join(dir, "gateway.pid.json") };
}

function makeRecord(pid: number, startedAtMs = Date.now()): MutexRecord {
  return { pid, startedAtMs };
}

function noopLog(): { lines: string[]; log: (s: string) => void } {
  const lines: string[] = [];
  return { lines, log: (s: string) => { lines.push(s); } };
}

// ---------------------------------------------------------------------------
// Mutex tests
// ---------------------------------------------------------------------------

describe("acquireStartupLock", () => {
  const cleanups: string[] = [];

  afterEach(() => {
    while (cleanups.length > 0) {
      const dir = cleanups.pop();
      if (dir) {
        try { rmSync(dir, { recursive: true, force: true }); } catch {}
      }
    }
  });

  it("(a) blocks when an alive holder owns the file", async () => {
    // Setup: someone else holds the lock with PID 12345 (which our
    // injected isPidAlive will report as alive).
    const { dir, path } = tmpLockPath();
    cleanups.push(dir);
    const incumbent = makeRecord(12345, Date.now() - 5000);
    writeFileSync(path, JSON.stringify(incumbent), "utf-8");

    const { lines, log } = noopLog();
    const result = await acquireStartupLock({
      path,
      record: makeRecord(99999),
      isPidAlive: (pid) => pid === 12345, // incumbent is alive
      log,
      agentName: "test-agent",
    });

    expect(result.status).toBe("blocked");
    if (result.status !== "blocked") throw new Error("unreachable");
    expect(result.holder.pid).toBe(12345);
    expect(result.holderAgeSec).toBeGreaterThanOrEqual(4);

    // File should still contain the incumbent record (not overwritten).
    const onDisk = JSON.parse(readFileSync(path, "utf-8")) as MutexRecord;
    expect(onDisk.pid).toBe(12345);

    // Should have logged a boot.lock_blocked line for journalctl.
    const blocked = lines.find((l) => l.includes("boot.lock_blocked"));
    expect(blocked).toBeDefined();
    expect(blocked).toContain("holder_pid=12345");
    expect(blocked).toContain("agent=test-agent");
  });

  it("(b) releases the lock on shutdown — file is gone afterwards", async () => {
    const { dir, path } = tmpLockPath();
    cleanups.push(dir);

    const { log } = noopLog();
    const acquired = await acquireStartupLock({
      path,
      record: makeRecord(process.pid),
      isPidAlive: () => true,
      log,
    });
    expect(acquired.status).toBe("acquired");
    expect(existsSync(path)).toBe(true);

    const releaseLog = noopLog();
    await releaseStartupLock({
      path,
      pid: process.pid,
      log: releaseLog.log,
      agentName: "test-agent",
    });
    expect(existsSync(path)).toBe(false);
    const released = releaseLog.lines.find((l) => l.includes("shutdown.lock_released"));
    expect(released).toBeDefined();
    expect(released).toContain(`pid=${process.pid}`);
  });

  it("(c) auto-recovers a stale lock (dead PID) and writes our own", async () => {
    const { dir, path } = tmpLockPath();
    cleanups.push(dir);
    // Pre-populate with a "dead" PID. 999999 is effectively impossible
    // to allocate on Linux (kernel.pid_max default is 4194304 on
    // x86_64 but most systems use the older 32768 ceiling — either way,
    // 999999 is almost certainly unallocated). We override isPidAlive
    // to make the test deterministic regardless of kernel config.
    const stalePid = 999999;
    const stale = makeRecord(stalePid, Date.now() - 600_000); // 10min old
    writeFileSync(path, JSON.stringify(stale), "utf-8");

    const ourPid = 4242;
    const { lines, log } = noopLog();
    const result = await acquireStartupLock({
      path,
      record: makeRecord(ourPid),
      isPidAlive: (pid) => pid !== stalePid, // stale is dead, all else alive
      log,
      agentName: "test-agent",
    });

    expect(result.status).toBe("acquired");
    if (result.status !== "acquired") throw new Error("unreachable");
    expect(result.recoveredFrom).toBeDefined();
    expect(result.recoveredFrom?.pid).toBe(stalePid);

    // File should now contain OUR record.
    const onDisk = JSON.parse(readFileSync(path, "utf-8")) as MutexRecord;
    expect(onDisk.pid).toBe(ourPid);

    // Audit log: must include the stale-recovered line so an operator
    // grepping journalctl can see what happened.
    const recovered = lines.find((l) => l.includes("boot.lock_stale_recovered"));
    expect(recovered).toBeDefined();
    expect(recovered).toContain(`prior_pid=${stalePid}`);
    expect(recovered).toContain("agent=test-agent");

    const acquired = lines.find((l) => l.includes("boot.lock_acquired"));
    expect(acquired).toBeDefined();
    expect(acquired).toContain(`pid=${ourPid}`);
  });

  it("(c.bonus) double-acquire by the SAME process does NOT corrupt state", async () => {
    // Defensive: if the boot path somehow runs acquireStartupLock twice
    // in the same process, we should detect ourselves as the holder and
    // NOT mutate the file. (Currently we report blocked, which is the
    // safe failure mode — caller exits non-zero.)
    const { dir, path } = tmpLockPath();
    cleanups.push(dir);
    const { log } = noopLog();
    const first = await acquireStartupLock({
      path,
      record: makeRecord(process.pid),
      isPidAlive: () => true,
      log,
    });
    expect(first.status).toBe("acquired");

    const second = await acquireStartupLock({
      path,
      record: makeRecord(process.pid),
      isPidAlive: () => true,
      log,
    });
    expect(second.status).toBe("blocked");
  });
});

// ---------------------------------------------------------------------------
// Drain tests
// ---------------------------------------------------------------------------

describe("drainShutdown", () => {
  // Real-time tests for the drain. We use real setTimeout (the module
  // default) and small budgets so the suite stays under a second total.
  // Mocking the clock is fragile here because Promise.race against the
  // budget sleep tangles with the in-flight poll loop's clock.

  it("(d.1) returns timed_out=false when in-flight drains within budget", async () => {
    // In-flight starts at 3, drops to 0 after ~200ms of real time.
    let count = 3;
    setTimeout(() => { count = 0; }, 200);

    const { lines, log } = noopLog();
    const result = await drainShutdown({
      signal: "SIGTERM",
      stopPolling: async () => { /* cooperative — returns immediately */ },
      inFlight: () => count,
      budgetMs: 1000,
      pollIntervalMs: 25,
      log,
      agentName: "test-agent",
    });

    expect(result.timedOut).toBe(false);
    expect(result.inFlightRemaining).toBe(0);
    expect(result.elapsedMs).toBeLessThan(1000);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(150);

    const start = lines.find((l) => l.includes("shutdown.drain_start"));
    expect(start).toBeDefined();
    expect(start).toContain("signal=SIGTERM");
    expect(start).toContain("in_flight=3");

    const complete = lines.find((l) => l.includes("shutdown.drain_complete"));
    expect(complete).toBeDefined();
    expect(complete).toContain("timed_out=false");
    expect(complete).toContain("in_flight_remaining=0");
  });

  it("(d.2) returns timed_out=true when in-flight never drops", async () => {
    const { lines, log } = noopLog();
    const result = await drainShutdown({
      signal: "SIGTERM",
      stopPolling: async () => { /* returns instantly; in-flight never clears */ },
      inFlight: () => 5,
      budgetMs: 250, // small budget keeps the test fast
      pollIntervalMs: 25,
      log,
      agentName: "test-agent",
    });

    expect(result.timedOut).toBe(true);
    expect(result.inFlightRemaining).toBe(5);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(250);
    // Generous upper bound — wall clock tolerance under load.
    expect(result.elapsedMs).toBeLessThan(1500);

    const complete = lines.find((l) => l.includes("shutdown.drain_complete"));
    expect(complete).toBeDefined();
    expect(complete).toContain("timed_out=true");
    expect(complete).toContain("in_flight_remaining=5");
  });

  it("(d.3) survives stopPolling throwing without aborting the drain", async () => {
    let count = 2;
    setTimeout(() => { count = 0; }, 100);

    const { lines, log } = noopLog();
    const result = await drainShutdown({
      signal: "SIGTERM",
      stopPolling: async () => {
        throw new Error("simulated bot.stop() failure");
      },
      inFlight: () => count,
      budgetMs: 1000,
      pollIntervalMs: 25,
      log,
    });

    expect(result.timedOut).toBe(false);
    expect(result.inFlightRemaining).toBe(0);
    const errLine = lines.find((l) => l.includes("stop_polling_error"));
    expect(errLine).toBeDefined();
    expect(errLine).toContain("simulated bot.stop() failure");
  });
});
