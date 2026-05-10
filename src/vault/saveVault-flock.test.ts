/**
 * Tests for saveVault's flock-based concurrency protection.
 *
 * Plan v3 §4: post-#952 (op:put), the broker AND the host CLI both
 * write the same vault file. Without flock the two writers can race
 * (last rename wins, lost update). saveVault acquires an exclusive
 * lock before reading/writing.
 *
 * Lock impl (v0.7.15+ per #964): PID-file at `<vaultPath>.lock`,
 * acquired via `openSync(O_CREAT|O_EXCL)` with the holder PID written
 * to the file content. Replaces the v0.7.12-v0.7.14 proper-lockfile
 * sentinel directory. See src/vault/flock.ts for the rationale and
 * src/vault/flock.test.ts for tests of the lock primitive itself.
 *
 * The lock has a 5s retry budget for contended writes; the new
 * `VaultBusyError` (surfaced as a `VaultError` to keep saveVault's
 * thrown-type contract stable) carries the holder PID in its
 * message per plan v3 §11.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVault, openVault, saveVault, acquireVaultLock, VaultError } from "./vault.js";
import { VaultBusyError } from "./flock.js";

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
    // #954 + plan v3 §11: holder PID + path in the error. Post-#964
    // the PID-file flock surfaces the holder PID — "held by pid <N>"
    // — plus the lock-file path (`<vaultPath>.lock`). Operators get
    // an actionable starting point without grepping /proc.
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
        // The lock-file path is `<vaultPath>.lock`; checking for the
        // vault path is enough to confirm we identified the right file.
        expect(msg).toContain(vaultPath);
        // Post-#964: holder PID is named.
        expect(msg).toMatch(/held by pid \d+/);
      }
    } finally {
      release();
    }
  }, 15000);

  it("VaultError carries VaultBusyError as cause when saveVault loses contention (#964 reviewer ask)", () => {
    // Reviewer on PR #974 flagged that VaultBusyError's structured
    // fields (holderPid, heldForMs, lockPath, budgetMs) were being
    // stripped at the saveVault boundary — the gateway error renderer
    // in #972 would have to re-parse the message. Fixed by plumbing
    // the cause through. This test pins the contract.
    const release = acquireVaultLock(vaultPath);
    try {
      const secrets = { foo: { kind: "string" as const, value: "bar" } };
      try {
        saveVault(passphrase, vaultPath, secrets);
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(VaultError);
        const cause = (err as VaultError).cause;
        expect(cause).toBeInstanceOf(VaultBusyError);
        const busy = cause as VaultBusyError;
        expect(busy.holderPid).toBe(process.pid);
        expect(busy.lockPath).toBe(`${vaultPath}.lock`);
        expect(busy.vaultPath).toBe(vaultPath);
        expect(busy.budgetMs).toBeGreaterThan(0);
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
