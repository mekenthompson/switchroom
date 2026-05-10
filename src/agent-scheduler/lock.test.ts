/**
 * Unit tests for the agent-scheduler lockfile (Phase 3 dual-run dedup).
 *
 * Properties:
 *   - first acquire creates the file with the calling pid
 *   - second acquire while live returns acquired=false + holderPid
 *   - second acquire after the holder exits removes the stale lock
 *     and succeeds (one retry built in)
 *   - release is idempotent (missing file is fine)
 */

import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock, readContainerBootTimeMs } from "./lock.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "agent-scheduler-lock-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("acquireLock / releaseLock", () => {
  it("acquires when no lockfile exists and writes the calling pid", () => {
    const path = join(tmp, "scheduler.lock");
    const result = acquireLock(path, 12345);
    expect(result.acquired).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe("12345");
  });

  it("refuses to acquire when held by a live process", () => {
    const path = join(tmp, "scheduler.lock");
    // The current test process IS alive — write our own pid in.
    writeFileSync(path, String(process.pid));
    const result = acquireLock(path);
    expect(result.acquired).toBe(false);
    expect(result.holderPid).toBe(process.pid);
  });

  it("clears a stale lock (PID no longer exists) and acquires on retry", () => {
    const path = join(tmp, "scheduler.lock");
    // Pick a pid that's almost certainly not alive — high enough to
    // exceed any plausible recent fork, low enough to be valid.
    // process.kill(pid, 0) raises ESRCH, which acquireLock treats
    // as stale.
    writeFileSync(path, "999999");
    const result = acquireLock(path, 7777);
    expect(result.acquired).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe("7777");
  });

  it("clears a garbage lockfile (non-numeric content) and acquires", () => {
    const path = join(tmp, "scheduler.lock");
    writeFileSync(path, "not-a-number\n");
    const result = acquireLock(path, 4242);
    expect(result.acquired).toBe(true);
    expect(readFileSync(path, "utf8").trim()).toBe("4242");
  });

  it("creates the parent directory if missing", () => {
    const path = join(tmp, "nested", "deeper", "scheduler.lock");
    const result = acquireLock(path, 1);
    expect(result.acquired).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  it("releaseLock removes the file", () => {
    const path = join(tmp, "scheduler.lock");
    acquireLock(path, 1);
    expect(existsSync(path)).toBe(true);
    releaseLock(path);
    expect(existsSync(path)).toBe(false);
  });

  it("releaseLock is idempotent (missing file is fine)", () => {
    const path = join(tmp, "no-such.lock");
    expect(() => releaseLock(path)).not.toThrow();
  });

  // Boot-time freshness check — defends against PID reuse across
  // container restarts (#895). Inside an agent container PID density
  // is low (tini=1, single-digit siblings), so a SIGKILL'd lock can
  // legitimately point at a PID the new generation reuses for an
  // unrelated process — kill(pid, 0) returns true and the supervisor
  // wedges. The freshness check breaks this by trusting mtime first.
  describe("boot-time freshness (#895)", () => {
    it("treats a lock older than container boot time as stale even when its PID is live", () => {
      const path = join(tmp, "scheduler.lock");
      // Write our own (live) PID into the lock so kill(pid, 0) succeeds.
      writeFileSync(path, String(process.pid));
      // Backdate the mtime to 1 hour before "boot" — pretend the
      // container restarted and this lock is from the previous gen.
      const fakeBootMs = Date.now();
      const oldTime = new Date(fakeBootMs - 60 * 60 * 1000);
      utimesSync(path, oldTime, oldTime);
      const result = acquireLock(path, 7777, { containerBootTimeMs: fakeBootMs });
      expect(result.acquired).toBe(true);
      expect(readFileSync(path, "utf8").trim()).toBe("7777");
    });

    it("honors a fresh lock (mtime newer than boot time) via the PID-liveness path", () => {
      const path = join(tmp, "scheduler.lock");
      writeFileSync(path, String(process.pid));
      // mtime is "now"; pretend boot was an hour ago.
      const fakeBootMs = Date.now() - 60 * 60 * 1000;
      const result = acquireLock(path, 8888, { containerBootTimeMs: fakeBootMs });
      expect(result.acquired).toBe(false);
      expect(result.holderPid).toBe(process.pid);
    });

    it("skips the freshness check entirely when containerBootTimeMs is null", () => {
      const path = join(tmp, "scheduler.lock");
      writeFileSync(path, String(process.pid));
      // Backdate mtime — would be stale under the freshness check, but
      // null disables it, falling back to PID-liveness only.
      const oldTime = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(path, oldTime, oldTime);
      const result = acquireLock(path, 9999, { containerBootTimeMs: null });
      expect(result.acquired).toBe(false);
      expect(result.holderPid).toBe(process.pid);
    });

    it("readContainerBootTimeMs returns a finite recent timestamp on Linux", () => {
      // Smoke test the auto-detect path. On non-Linux runners this
      // returns null; on the Linux CI box it returns the real boot
      // time (seconds-to-days ago, depending on uptime).
      const v = readContainerBootTimeMs();
      if (v == null) return; // non-Linux — not applicable
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });
});
