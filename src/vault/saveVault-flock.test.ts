/**
 * Tests for saveVault's flock-based concurrency protection.
 *
 * Plan v3 §4: post-#952 (op:put), the broker AND the host CLI both
 * write the same vault file. Without flock the two writers can race
 * (last rename wins, lost update). saveVault now acquires an
 * exclusive lock via proper-lockfile before reading/writing.
 *
 * The lock has a 5s retry budget for contended writes; busy-wait
 * busy-wait holds the calling thread but proper-lockfile's
 * stale-lock detection auto-recovers from a crashed holder.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVault, openVault, saveVault, acquireVaultLock, VaultError } from "./vault.js";

describe("saveVault flock", () => {
  let tmpDir: string;
  let vaultPath: string;
  const passphrase = "test-passphrase-flock";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "save-vault-flock-"));
    mkdirSync(tmpDir, { recursive: true });
    vaultPath = join(tmpDir, "vault.enc");
    createVault(passphrase, vaultPath);
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it("baseline: saveVault round-trip works without contention", () => {
    const secrets = { foo: { kind: "string" as const, value: "bar" } };
    saveVault(passphrase, vaultPath, secrets);
    const reread = openVault(passphrase, vaultPath);
    expect(reread).toEqual(secrets);
  });

  it("acquireVaultLock + release round-trip works", () => {
    const release = acquireVaultLock(vaultPath);
    expect(typeof release).toBe("function");
    release();
  });

  it("saveVault errors with VaultError when another writer holds the lock and budget expires", () => {
    // Acquire the lock manually and don't release. saveVault should
    // try for ~5s and then throw VaultError("vault busy").
    const release = acquireVaultLock(vaultPath);
    try {
      const start = Date.now();
      const secrets = { foo: { kind: "string" as const, value: "bar" } };
      expect(() => saveVault(passphrase, vaultPath, secrets)).toThrow(VaultError);
      const elapsed = Date.now() - start;
      // Should have spent close to the 5s budget before giving up.
      // Allow generous slack since we're busy-waiting in a tight loop.
      expect(elapsed).toBeGreaterThan(4500);
      expect(elapsed).toBeLessThan(7000);
    } finally {
      release();
    }
  }, 15000);

  it("saveVault error message includes 'vault busy' and the path for diagnosability (closes #954)", () => {
    // #954 ask: holder PID + path in the error. Our error message is
    // path-bearing; "another writer holds the lock at <path>" gives
    // operators an actionable starting point. (PID would be a follow-up
    // — proper-lockfile doesn't expose the holder PID directly.)
    const release = acquireVaultLock(vaultPath);
    try {
      const secrets = { foo: { kind: "string" as const, value: "bar" } };
      try {
        saveVault(passphrase, vaultPath, secrets);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(VaultError);
        const msg = (err as Error).message;
        expect(msg).toContain("vault busy");
        expect(msg).toContain(vaultPath);
      }
    } finally {
      release();
    }
  }, 15000);

  it("two sequential saveVaults with same passphrase succeed (lock released between calls)", () => {
    saveVault(passphrase, vaultPath, { a: { kind: "string", value: "1" } });
    saveVault(passphrase, vaultPath, { b: { kind: "string", value: "2" } });
    const reread = openVault(passphrase, vaultPath);
    expect(reread).toEqual({ b: { kind: "string", value: "2" } });
  });

  it("acquireVaultLock errors if held by another and budget expires", () => {
    const release = acquireVaultLock(vaultPath);
    try {
      expect(() => acquireVaultLock(vaultPath)).toThrow(VaultError);
    } finally {
      release();
    }
  }, 15000);
});
