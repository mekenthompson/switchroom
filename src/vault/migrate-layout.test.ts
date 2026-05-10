/**
 * Tests for the vault layout migration helper.
 *
 * Plan v3 §2 state machine: A (virgin), B (pre-migration),
 * C (partial-finished), D (post-migration), E (divergent).
 *
 * Each test sets up the disk state, calls migrateVaultLayout, and
 * asserts the state machine produces the expected MigrationResult
 * AND leaves the disk in the expected post-migration shape.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  existsSync,
  lstatSync,
  readlinkSync,
  readFileSync,
  chmodSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  migrateVaultLayout,
  inspectVaultLayout,
  formatDivergentRecoveryMessage,
  vaultLayoutPaths,
  type DivergentDetails,
} from "./migrate-layout.js";

describe("migrateVaultLayout", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "vault-migrate-test-"));
    mkdirSync(join(home, ".switchroom"), { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
  });

  it("State A — virgin install: returns no-vault, leaves disk untouched", () => {
    const result = migrateVaultLayout(home);
    expect(result.kind).toBe("no-vault");
    expect(existsSync(join(home, ".switchroom", "vault.enc"))).toBe(false);
    expect(existsSync(join(home, ".switchroom", "vault"))).toBe(false);
  });

  it("State B — pre-migration: moves file, creates symlink, mode 0600 preserved", () => {
    const oldPath = join(home, ".switchroom", "vault.enc");
    const newPath = join(home, ".switchroom", "vault", "vault.enc");
    writeFileSync(oldPath, "ENCRYPTED_BLOB_BYTES", { mode: 0o600 });

    const result = migrateVaultLayout(home);
    expect(result.kind).toBe("migrated");

    // New file exists with correct content + mode 0600.
    expect(existsSync(newPath)).toBe(true);
    expect(readFileSync(newPath, "utf8")).toBe("ENCRYPTED_BLOB_BYTES");
    expect(statSync(newPath).mode & 0o777).toBe(0o600);

    // Old path is now a symlink → vault/vault.enc.
    expect(lstatSync(oldPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(oldPath)).toBe("vault/vault.enc");

    // Reading the symlink follows to the new content.
    expect(readFileSync(oldPath, "utf8")).toBe("ENCRYPTED_BLOB_BYTES");
  });

  it("State D — already migrated: no-op, idempotent on second call", () => {
    const oldPath = join(home, ".switchroom", "vault.enc");
    const newPath = join(home, ".switchroom", "vault", "vault.enc");
    mkdirSync(join(home, ".switchroom", "vault"), { recursive: true, mode: 0o700 });
    writeFileSync(newPath, "blob", { mode: 0o600 });
    symlinkSync("vault/vault.enc", oldPath);

    const result1 = migrateVaultLayout(home);
    expect(result1.kind).toBe("already-migrated");

    // Idempotent — state untouched.
    expect(lstatSync(oldPath).isSymbolicLink()).toBe(true);
    expect(readFileSync(newPath, "utf8")).toBe("blob");

    // Second call is also a no-op.
    const result2 = migrateVaultLayout(home);
    expect(result2.kind).toBe("already-migrated");
  });

  it("State C — partial-finished: hashes match, completes by replacing old with symlink", () => {
    // Operator was mid-migration, crashed after copy but before
    // symlink creation. Both paths exist as regular files with
    // identical content.
    const oldPath = join(home, ".switchroom", "vault.enc");
    const newPath = join(home, ".switchroom", "vault", "vault.enc");
    mkdirSync(join(home, ".switchroom", "vault"), { recursive: true, mode: 0o700 });
    writeFileSync(oldPath, "SAME_CONTENT", { mode: 0o600 });
    writeFileSync(newPath, "SAME_CONTENT", { mode: 0o600 });

    const result = migrateVaultLayout(home);
    expect(result.kind).toBe("completed-partial");

    // Old path is now a symlink — partial state recovered.
    expect(lstatSync(oldPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(oldPath)).toBe("vault/vault.enc");
    // New path content untouched.
    expect(readFileSync(newPath, "utf8")).toBe("SAME_CONTENT");
  });

  it("State E — divergent: hashes differ, refuses, returns details for recovery message", () => {
    // The 2026-05-10 hazard reviewers flagged: an old switchroom CLI
    // wrote to the legacy path AFTER migration ran, replacing the
    // symlink with a fresh regular file. Now both paths exist as
    // regular files with DIFFERENT content. Plan v3 §2 says: refuse,
    // print recovery recipe, exit non-zero.
    const oldPath = join(home, ".switchroom", "vault.enc");
    const newPath = join(home, ".switchroom", "vault", "vault.enc");
    mkdirSync(join(home, ".switchroom", "vault"), { recursive: true, mode: 0o700 });
    writeFileSync(oldPath, "OLD_CONTENT", { mode: 0o600 });
    writeFileSync(newPath, "NEW_CONTENT", { mode: 0o600 });

    const result = migrateVaultLayout(home);
    expect(result.kind).toBe("divergent");
    if (result.kind === "divergent") {
      expect(result.details.oldPath).toBe(oldPath);
      expect(result.details.newPath).toBe(newPath);
      expect(result.details.oldHash).not.toBe(result.details.newHash);
      expect(result.details.oldSize).toBe("OLD_CONTENT".length);
      expect(result.details.newSize).toBe("NEW_CONTENT".length);
      expect(result.details.oldMtime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    // Disk is UNTOUCHED — refusal is the contract.
    expect(lstatSync(oldPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(oldPath, "utf8")).toBe("OLD_CONTENT");
    expect(readFileSync(newPath, "utf8")).toBe("NEW_CONTENT");
  });

  it("custom vault.path: returns custom-path-skipped, no migration", () => {
    // Operator with vault.path: /opt/secrets/vault.enc — migration
    // is keyed off the canonical default; custom paths are left alone.
    const oldPath = join(home, ".switchroom", "vault.enc");
    writeFileSync(oldPath, "shouldn't migrate this", { mode: 0o600 });

    const result = migrateVaultLayout(home, {
      customVaultPath: "/opt/secrets/vault.enc",
    });
    expect(result.kind).toBe("custom-path-skipped");
    if (result.kind === "custom-path-skipped") {
      expect(result.path).toBe("/opt/secrets/vault.enc");
    }

    // Disk untouched — custom paths are operator territory.
    expect(lstatSync(oldPath).isSymbolicLink()).toBe(false);
    expect(readFileSync(oldPath, "utf8")).toBe("shouldn't migrate this");
  });

  it("idempotency — calling migration repeatedly converges to state D and stays", () => {
    const oldPath = join(home, ".switchroom", "vault.enc");
    writeFileSync(oldPath, "blob", { mode: 0o600 });

    const r1 = migrateVaultLayout(home);
    expect(r1.kind).toBe("migrated");

    for (let i = 0; i < 5; i++) {
      const r = migrateVaultLayout(home);
      expect(r.kind).toBe("already-migrated");
    }
  });

  describe("inspectVaultLayout (read-only)", () => {
    it("returns the same state as migrateVaultLayout would, without mutating disk", () => {
      const oldPath = join(home, ".switchroom", "vault.enc");
      writeFileSync(oldPath, "blob", { mode: 0o600 });

      // Inspect should report state B (pre-migration would be "migrated"
      // shape if executed — but read-only returns "migrated" kind too,
      // signifying "would migrate"). After inspect, disk is unchanged.
      const r = inspectVaultLayout(home);
      expect(r.kind).toBe("migrated");
      expect(lstatSync(oldPath).isFile()).toBe(true);
      expect(existsSync(join(home, ".switchroom", "vault"))).toBe(false);
    });

    it("read-only state E inspection reports divergent without mutation", () => {
      const oldPath = join(home, ".switchroom", "vault.enc");
      const newPath = join(home, ".switchroom", "vault", "vault.enc");
      mkdirSync(join(home, ".switchroom", "vault"), { recursive: true, mode: 0o700 });
      writeFileSync(oldPath, "DIFF_OLD", { mode: 0o600 });
      writeFileSync(newPath, "DIFF_NEW", { mode: 0o600 });

      const r = inspectVaultLayout(home);
      expect(r.kind).toBe("divergent");
      // Disk untouched.
      expect(readFileSync(oldPath, "utf8")).toBe("DIFF_OLD");
      expect(readFileSync(newPath, "utf8")).toBe("DIFF_NEW");
    });
  });

  describe("vaultLayoutPaths", () => {
    it("derives canonical paths under a given home", () => {
      const paths = vaultLayoutPaths("/home/operator");
      expect(paths.oldPath).toBe("/home/operator/.switchroom/vault.enc");
      expect(paths.newPath).toBe("/home/operator/.switchroom/vault/vault.enc");
      expect(paths.parent).toBe("/home/operator/.switchroom/vault");
      expect(paths.switchroomRoot).toBe("/home/operator/.switchroom");
    });
  });

  describe("formatDivergentRecoveryMessage", () => {
    const sampleDetails: DivergentDetails = {
      oldPath: "/home/op/.switchroom/vault.enc",
      newPath: "/home/op/.switchroom/vault/vault.enc",
      oldHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      newHash: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      oldSize: 12345,
      newSize: 12378,
      oldMtime: "2026-05-10T11:00:00.000Z",
      newMtime: "2026-05-11T12:00:00.000Z",
    };

    it("includes the actual file paths in the recipe", () => {
      const msg = formatDivergentRecoveryMessage(sampleDetails);
      expect(msg).toContain("/home/op/.switchroom/vault.enc");
      expect(msg).toContain("/home/op/.switchroom/vault/vault.enc");
    });

    it("includes both hash prefixes", () => {
      const msg = formatDivergentRecoveryMessage(sampleDetails);
      expect(msg).toContain("0123456789abcdef...");
      expect(msg).toContain("fedcba9876543210...");
    });

    it("includes both option a, b, and c with executable commands", () => {
      const msg = formatDivergentRecoveryMessage(sampleDetails);
      expect(msg).toMatch(/a\) Keep the NEW path/);
      expect(msg).toMatch(/b\) Keep the OLD path/);
      expect(msg).toMatch(/c\) If unsure, decrypt both and diff/);
      // Each option should produce executable shell.
      expect(msg).toMatch(/cp .+\.divergent\.bak/);
      expect(msg).toMatch(/ln -s vault\/vault\.enc/);
      expect(msg).toMatch(/switchroom apply/);
    });

    it("starts with the failure marker for grep-friendliness", () => {
      const msg = formatDivergentRecoveryMessage(sampleDetails);
      expect(msg.startsWith("✗ Vault layout divergence detected")).toBe(true);
    });

    it("ends with a safety-net reminder about .divergent.bak", () => {
      const msg = formatDivergentRecoveryMessage(sampleDetails);
      expect(msg).toContain(".divergent.bak file is your safety net");
    });
  });
});
