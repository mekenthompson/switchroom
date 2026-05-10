/**
 * Tests for the broker's vault-layout drift detection (plan v3 §5
 * companion to apply-time state-E refusal).
 *
 * Scenario: an older switchroom CLI wrote to the legacy vault path
 * AFTER migration ran, replacing the symlink with a fresh regular
 * file. Broker has been writing to /state/vault/vault.enc; legacy
 * /state/vault.enc now has stale or independent content. The broker
 * must REFUSE to unlock so it doesn't keep serving the wrong file.
 *
 * The actual function is package-private (declared in server.ts);
 * we exercise it via the broker's `unlockFromPassphrase` entry point,
 * mirroring what happens at boot in production.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createVault } from "../vault.js";
import { VaultBroker } from "./server.js";

describe("Broker vault-layout drift detection", () => {
  let tmpHome: string;
  let switchroomDir: string;
  let vaultDir: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "broker-drift-test-"));
    switchroomDir = join(tmpHome, ".switchroom");
    vaultDir = join(switchroomDir, "vault");
    mkdirSync(switchroomDir, { recursive: true, mode: 0o700 });
    mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
  });

  afterEach(() => {
    delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
  });

  it("unlocks normally when only the canonical vault exists (state D)", () => {
    // Init a real encrypted vault at the canonical path.
    const newVault = join(vaultDir, "vault.enc");
    createVault("test-passphrase", newVault);
    // Symlink at the legacy path → this is the post-migration shape.
    const legacyVault = join(switchroomDir, "vault.enc");
    symlinkSync("vault/vault.enc", legacyVault);

    const broker = new VaultBroker({
      _testConfig: { agents: {} } as never,
      _testVaultPath: newVault,
    });
    expect(() => broker.unlockFromPassphrase("test-passphrase")).not.toThrow();
    broker.lock();
  });

  it("REFUSES to unlock when legacy path has divergent content (state E)", () => {
    // Plan v3 §5 companion: an older CLI wrote to the legacy path
    // after migration. Broker reads new path; legacy is stale and
    // different. Broker must refuse so it doesn't serve stale data
    // unbounded.
    const newVault = join(vaultDir, "vault.enc");
    createVault("test-passphrase", newVault);
    const legacyVault = join(switchroomDir, "vault.enc");
    // Write a regular file at the legacy path (the rename-replaces-
    // symlink hazard) with arbitrary content that differs from the
    // canonical vault.
    writeFileSync(legacyVault, "STALE_LEGACY_CONTENT_FROM_OLD_CLI", { mode: 0o600 });

    const broker = new VaultBroker({
      _testConfig: { agents: {} } as never,
      _testVaultPath: newVault,
    });
    expect(() => broker.unlockFromPassphrase("test-passphrase"))
      .toThrow(/divergence detected|drift/i);
  });

  it("does NOT trigger when vault path is not the canonical /vault/vault.enc shape", () => {
    // Custom paths (operator's vault.path = /opt/secrets/vault.enc)
    // skip the drift check — we don't know what the legacy sibling
    // would even be. Plan v3 §5: only triggers on canonical layout.
    const customVault = join(switchroomDir, "custom-vault.enc");
    createVault("test-passphrase", customVault);
    // Add an unrelated regular file at a sibling path that LOOKS like
    // legacy (just to ensure we don't accidentally tag it as drift).
    writeFileSync(join(switchroomDir, "vault.enc"), "unrelated bytes", { mode: 0o600 });

    const broker = new VaultBroker({
      _testConfig: { agents: {} } as never,
      _testVaultPath: customVault,
    });
    // No throw — custom path skips the check.
    expect(() => broker.unlockFromPassphrase("test-passphrase")).not.toThrow();
    broker.lock();
  });

  it("does NOT trigger when both files have identical content (state C in transit)", () => {
    // State C is "partial migration" — both files exist with the
    // same content because the migration helper crashed mid-symlink.
    // Broker shouldn't refuse to boot for state C; it'll be caught
    // and finished by the next switchroom apply.
    const newVault = join(vaultDir, "vault.enc");
    createVault("test-passphrase", newVault);

    // Read the bytes the canonical vault landed at, and write the
    // SAME bytes to the legacy path.
    const fs = require("node:fs") as typeof import("node:fs");
    const sameBytes = fs.readFileSync(newVault);
    fs.writeFileSync(join(switchroomDir, "vault.enc"), sameBytes, { mode: 0o600 });

    const broker = new VaultBroker({
      _testConfig: { agents: {} } as never,
      _testVaultPath: newVault,
    });
    expect(() => broker.unlockFromPassphrase("test-passphrase")).not.toThrow();
    broker.lock();
  });

  it("does NOT trigger when legacy path doesn't exist (clean install)", () => {
    const newVault = join(vaultDir, "vault.enc");
    createVault("test-passphrase", newVault);

    const broker = new VaultBroker({
      _testConfig: { agents: {} } as never,
      _testVaultPath: newVault,
    });
    expect(() => broker.unlockFromPassphrase("test-passphrase")).not.toThrow();
    broker.lock();
  });
});
