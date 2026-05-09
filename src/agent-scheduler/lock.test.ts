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
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock } from "./lock.js";

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
});
