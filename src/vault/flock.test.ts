/**
 * Tests for the PID-file flock that replaces proper-lockfile in
 * saveVault (#964).
 *
 * Coverage:
 *   - basic acquire/release lifecycle
 *   - contention surfaces VaultBusyError with holder PID per plan v3 §11
 *   - stale-lock recovery when holder PID is dead
 *   - v0.7.14 sentinel-dir → v0.7.15 PID-file migration on first acquire
 *   - structured fields on VaultBusyError (for the gateway error
 *     renderer added in #972 to consume programmatically)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireLock,
  lockPathFor,
  readLockHolder,
  VaultBusyError,
} from "./flock.js";

describe("flock — basic lifecycle", () => {
  let tmp: string;
  let vaultPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vault-flock-test-"));
    vaultPath = join(tmp, "vault.enc");
    writeFileSync(vaultPath, "stub-encrypted-payload");
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  it("acquires, exposes holder PID in lockfile contents, releases", () => {
    const lock = acquireLock(vaultPath);
    const lockPath = lockPathFor(vaultPath);
    expect(existsSync(lockPath)).toBe(true);

    // Content is human-readable: pid\nts\nargv0\n
    const content = readFileSync(lockPath, "utf8");
    const [pidStr, tsStr] = content.split("\n");
    expect(Number.parseInt(pidStr, 10)).toBe(process.pid);
    expect(Number.parseInt(tsStr, 10)).toBeGreaterThan(Date.now() - 5000);

    lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("lockPathFor produces `<vaultPath>.lock`", () => {
    expect(lockPathFor("/x/y/vault.enc")).toBe("/x/y/vault.enc.lock");
    expect(lockPathFor("/x/y/vault.enc.legacy")).toBe("/x/y/vault.enc.legacy.lock");
  });

  it("release is idempotent (double-release doesn't throw)", () => {
    const lock = acquireLock(vaultPath);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  it("readLockHolder returns null on missing / malformed file", () => {
    expect(readLockHolder(join(tmp, "no-such-file"))).toBeNull();
    writeFileSync(join(tmp, "garbage.lock"), "not\nparseable\n");
    expect(readLockHolder(join(tmp, "garbage.lock"))).toBeNull();
    writeFileSync(join(tmp, "empty.lock"), "");
    expect(readLockHolder(join(tmp, "empty.lock"))).toBeNull();
  });

  it("readLockHolder parses well-formed lock file", () => {
    writeFileSync(join(tmp, "ok.lock"), "12345\n1700000000000\nswitchroom-vault-set\n");
    const h = readLockHolder(join(tmp, "ok.lock"));
    expect(h).not.toBeNull();
    expect(h?.pid).toBe(12345);
    expect(h?.acquiredAtMs).toBe(1700000000000);
    expect(h?.argv0).toBe("switchroom-vault-set");
  });
});

describe("flock — contention (plan v3 §11 — VaultBusyError shape)", () => {
  let tmp: string;
  let vaultPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vault-flock-test-"));
    vaultPath = join(tmp, "vault.enc");
    writeFileSync(vaultPath, "stub");
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  it("contention against a live holder throws VaultBusyError with holder PID", () => {
    // Simulate another live holder by writing a lock file with the
    // CURRENT process's PID (definitely alive). The acquirer will
    // see EEXIST → pidIsLive(self) → true → wait → budget expires.
    const lockPath = lockPathFor(vaultPath);
    writeFileSync(
      lockPath,
      `${process.pid}\n${Date.now()}\nphantom-writer\n`,
    );

    // Tight budget so the test doesn't hang. 200ms is enough to
    // exercise two retry sleeps + the deadline check.
    let caught: unknown = null;
    try {
      acquireLock(vaultPath, { budgetMs: 200 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VaultBusyError);
    const err = caught as VaultBusyError;
    expect(err.holderPid).toBe(process.pid);
    expect(err.heldForMs).toBeGreaterThanOrEqual(0);
    expect(err.budgetMs).toBe(200);
    expect(err.vaultPath).toBe(vaultPath);
    expect(err.lockPath).toBe(lockPath);
    expect(err.message).toMatch(/vault busy: held by pid \d+/);
    expect(err.message).toMatch(/retried for 200ms/);
  });

  it("contention with FRESH unreadable lock file surfaces 'holder PID unreadable'", () => {
    // An unreadable lock file whose mtime is YOUNGER than the retry
    // budget is treated as "fresh" — could be a writer in the middle
    // of populating the metadata. Acquirer waits the full budget
    // and gives up with a "PID unreadable" message.
    //
    // (The mtime-stale path #977 kicks in when the file is *older*
    // than the budget — see the next test for that case.)
    const lockPath = lockPathFor(vaultPath);
    writeFileSync(lockPath, "garbage-content-no-pid");

    let caught: VaultBusyError | null = null;
    try {
      // Long budget relative to mtime age so the mtime-stale path
      // doesn't fire while we wait. The file was JUST written; even
      // with the deadline+wait cadence it'll never exceed budgetMs.
      acquireLock(vaultPath, { budgetMs: 300 });
    } catch (e) {
      if (e instanceof VaultBusyError) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught?.holderPid).toBeNull();
    expect(caught?.message).toMatch(/holder PID unreadable/);
  });

  it("unparseable lock file older than budget → acquirer reclaims it (closes #977)", () => {
    // A lock file that's unparseable AND older than the retry budget
    // almost certainly came from a writer that crashed mid-write of
    // the metadata block. Pre-#977 the acquirer waited the full
    // budget anyway; post-#977 it unlinks the stale file and retries.
    const lockPath = lockPathFor(vaultPath);
    writeFileSync(lockPath, "");
    // Backdate the mtime well past the stale-mtime floor
    // (STALE_MTIME_FLOOR_MS = 10s) and past 2× any reasonable
    // budget — 60s back is comfortably stale.
    const sixtySecondsAgo = Date.now() / 1000 - 60;
    utimesSync(lockPath, sixtySecondsAgo, sixtySecondsAgo);

    // Tight budget — proves we reclaimed without waiting it out.
    const lock = acquireLock(vaultPath, { budgetMs: 500 });
    try {
      const holder = readLockHolder(lockPath);
      expect(holder?.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });
});

describe("flock — PID-reuse defense (#976)", () => {
  let tmp: string;
  let vaultPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vault-flock-test-"));
    vaultPath = join(tmp, "vault.enc");
    writeFileSync(vaultPath, "stub");
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  it("planted lock with our PID + acquired-time BEFORE this process started → reclaimed as stale (#976)", () => {
    // PID reuse scenario: the lockfile claims `process.pid` as the
    // holder (so kill(0)/proc check shows "alive"), but the
    // acquired-at timestamp predates this process's own start time.
    // No way the original holder is us → must be PID reuse → stale.
    //
    // Skip on non-Linux — pidStartTimeMs returns null on other
    // platforms (conservative: treats as live). The defense is a
    // Linux-only refinement; the underlying pidIsLive check still
    // covers the most common (dead-PID) case everywhere.
    if (process.platform !== "linux") {
      return;
    }

    const lockPath = lockPathFor(vaultPath);
    // Acquired-at = 1 hour before any reasonable test process start.
    // We can't easily read THIS process's exact start time from
    // userland, but it's certainly less than 1 hour old in CI.
    const acquiredAt = Date.now() - 60 * 60 * 1000;
    writeFileSync(lockPath, `${process.pid}\n${acquiredAt}\nlong-ago\n`);

    // Tight budget so a regression would manifest as a timeout
    // rather than a slow pass.
    const lock = acquireLock(vaultPath, { budgetMs: 500 });
    try {
      const holder = readLockHolder(lockPath);
      // Reclaimed: the lockfile now records the current acquire's
      // timestamp, not the planted one.
      expect(holder?.pid).toBe(process.pid);
      expect(holder?.acquiredAtMs).toBeGreaterThan(acquiredAt + 60_000);
    } finally {
      lock.release();
    }
  });

  it("planted lock with our PID + acquired-time WITHIN tolerance → treated as live (don't reclaim)", () => {
    // If the planted acquired-at is recent enough that we can't rule
    // out same-process acquisition, the conservative defense is to
    // treat it as live. Acquirer waits the full budget.
    if (process.platform !== "linux") return;

    const lockPath = lockPathFor(vaultPath);
    // Acquired-at = now. pidStartTimeMs returns a time before "now"
    // (process must have started before it could write the lock),
    // so pidIsOriginalHolder returns true → treat as live.
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\ncurrent-process\n`);

    let caught: VaultBusyError | null = null;
    try {
      acquireLock(vaultPath, { budgetMs: 300 });
    } catch (e) {
      if (e instanceof VaultBusyError) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught?.holderPid).toBe(process.pid);
  });
});

describe("flock — stale-lock recovery", () => {
  let tmp: string;
  let vaultPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vault-flock-test-"));
    vaultPath = join(tmp, "vault.enc");
    writeFileSync(vaultPath, "stub");
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  it("dead holder PID → acquirer reclaims the lock instead of timing out", () => {
    // Pick a PID that's almost certainly dead. PID 1 is init (alive),
    // but a very high number unlikely to be allocated works. We
    // double-check liveness via /proc.
    //
    // On non-Linux platforms the kill(0)-based liveness check is used
    // and behaves the same.
    const lockPath = lockPathFor(vaultPath);

    // Hunt for a dead PID. Try a few candidates; if none are
    // confirmable-dead in this process (e.g. process restrictions),
    // skip the assertion rather than flake.
    let deadPid: number | null = null;
    for (const candidate of [2_147_483_640, 999_999, 888_888]) {
      if (process.platform === "linux") {
        if (!existsSync(`/proc/${candidate}`)) {
          deadPid = candidate;
          break;
        }
      } else {
        try {
          process.kill(candidate, 0);
          // Alive — try next candidate.
        } catch {
          deadPid = candidate;
          break;
        }
      }
    }
    if (deadPid === null) {
      // Defensive — couldn't find a dead PID, skip the assertion.
      return;
    }

    // Plant a stale lock with the dead PID. The acquirer must:
    //   1. open(O_EXCL) → EEXIST
    //   2. read holder, see dead PID
    //   3. unlink the stale lock
    //   4. retry open → success
    writeFileSync(lockPath, `${deadPid}\n${Date.now()}\nzombie-writer\n`);

    // Budget tight to prove we didn't wait for it.
    const lock = acquireLock(vaultPath, { budgetMs: 1000 });
    try {
      expect(existsSync(lockPath)).toBe(true);
      const post = readLockHolder(lockPath);
      expect(post?.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });
});

describe("flock — v0.7.14 sentinel-dir migration", () => {
  let tmp: string;
  let vaultPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vault-flock-test-"));
    vaultPath = join(tmp, "vault.enc");
    writeFileSync(vaultPath, "stub");
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  it("legacy v0.7.14 sentinel-dir (with old leftover) → acquirer migrates to file", () => {
    // v0.7.14's proper-lockfile leaves `vault.enc.lock/` as a dir.
    // The v0.7.15 acquirer's EEXIST handler detects the dir-shape,
    // clears it, and retries the openSync.
    //
    // Post-#979: clearStaleSentinelDir refuses to migrate if any
    // file inside has been written within the last 60s (defensive
    // against an in-flight v0.7.14 writer). Backdate the leftover
    // so the migration proceeds.
    const lockPath = lockPathFor(vaultPath);
    mkdirSync(lockPath, { recursive: true });
    const leftoverPath = join(lockPath, "leftover");
    writeFileSync(leftoverPath, "stale-content");
    // Backdate to 2 minutes ago — beyond the 60s recent-write window.
    const twoMinAgo = Date.now() / 1000 - 120;
    utimesSync(leftoverPath, twoMinAgo, twoMinAgo);

    const lock = acquireLock(vaultPath, { budgetMs: 1000 });
    try {
      expect(existsSync(lockPath)).toBe(true);
      // Post-migration the lock path is a regular file (not a dir).
      expect(statSync(lockPath).isFile()).toBe(true);
      const holder = readLockHolder(lockPath);
      expect(holder?.pid).toBe(process.pid);
    } finally {
      lock.release();
    }
  });

  it("legacy v0.7.14 sentinel-dir with RECENT write → refuses migration, waits (closes #979)", () => {
    // Defense for the v0.7.14 → v0.7.15 upgrade window. If a
    // v0.7.14 writer is still active (e.g. broker not yet bounced
    // post-upgrade), the sentinel dir's contents have fresh mtimes.
    // clearStaleSentinelDir refuses to migrate; the acquirer falls
    // through to the contention path and waits the budget.
    const lockPath = lockPathFor(vaultPath);
    mkdirSync(lockPath, { recursive: true });
    // Fresh write — within the 60s recent-write window.
    writeFileSync(join(lockPath, "leftover"), "in-flight-writer-data");

    let caught: VaultBusyError | null = null;
    try {
      acquireLock(vaultPath, { budgetMs: 200 });
    } catch (e) {
      if (e instanceof VaultBusyError) caught = e;
    }
    // We expect a VaultBusyError (didn't migrate, waited budget).
    expect(caught).not.toBeNull();
    // Sentinel-dir is still on disk — defensive refusal worked.
    expect(existsSync(lockPath)).toBe(true);
    expect(statSync(lockPath).isDirectory()).toBe(true);
  });

  it("empty sentinel-dir → acquirer migrates cleanly", () => {
    const lockPath = lockPathFor(vaultPath);
    mkdirSync(lockPath, { recursive: true });

    const lock = acquireLock(vaultPath, { budgetMs: 1000 });
    try {
      expect(statSync(lockPath).isFile()).toBe(true);
    } finally {
      lock.release();
    }
  });
});
