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

  it("contention with unreadable lock file surfaces 'holder PID unreadable'", () => {
    // Write an unparseable lock file so readLockHolder returns null
    // BUT the file still exists, so openSync(O_EXCL) fails with
    // EEXIST. Without a valid PID we can't liveness-check, so the
    // acquirer waits the full budget and gives up.
    //
    // NOTE: this is also why the test uses a tight budget — the
    // acquirer can't tell if the holder is alive or dead, so it
    // defaults to waiting (the safe option).
    const lockPath = lockPathFor(vaultPath);
    writeFileSync(lockPath, "garbage-content-no-pid");

    let caught: VaultBusyError | null = null;
    try {
      acquireLock(vaultPath, { budgetMs: 150 });
    } catch (e) {
      if (e instanceof VaultBusyError) caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught?.holderPid).toBeNull();
    expect(caught?.message).toMatch(/holder PID unreadable/);
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

  it("legacy v0.7.14 sentinel-dir at lock path → acquirer migrates to file", () => {
    // v0.7.14's proper-lockfile leaves `vault.enc.lock/` as a dir.
    // The v0.7.15 acquirer's open(O_EXCL) fails with EISDIR; the
    // migration branch rmdir's the legacy dir and retries.
    const lockPath = lockPathFor(vaultPath);
    mkdirSync(lockPath, { recursive: true });
    // proper-lockfile may leave a file inside the sentinel dir; the
    // migration must remove it too. Plant one to make sure.
    writeFileSync(join(lockPath, "leftover"), "stale-content");

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
