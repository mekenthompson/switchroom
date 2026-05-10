/**
 * Tests for the vault-bind-mount-dir helpers extracted from apply.ts.
 *
 * Closes #961 (the apply.ts vault-dir guard test gap from the v0.7.12
 * deploy hotfix #958). Pre-fix, the inline guard logic in apply.ts
 * had a bug — `dirname(customVaultPath)` for legacy-path operators
 * resolved to `~/.switchroom/` (parent of the legacy file, not the
 * new mount target) and refused to mount because of unrelated
 * sibling dirs. Caught by self-deploying v0.7.12 against the
 * operator's actual fleet, NOT by unit tests.
 *
 * These tests pin the four enumerated cases from PR #958's reviewer
 * walk-through:
 *   1. Default config, legacy `vault.path: ~/.switchroom/vault.enc`
 *   2. Default config, new canonical `vault.path: ~/.switchroom/vault/vault.enc`
 *   3. Genuinely custom `vault.path: /opt/secrets/vault.enc`
 *   4. No `vault.path` configured
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  mkdtempSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveVaultBindMountDir,
  inspectVaultBindMountDir,
} from "./apply.js";

describe("resolveVaultBindMountDir (#961)", () => {
  const fakeHome = "/home/op";

  it("default config + legacy vault.path → canonical NEW parent dir", () => {
    // Operator has `vault.path: ~/.switchroom/vault.enc` (legacy
    // default for v0.7.0–.11 installs). After migration runs at apply
    // time, the actual file lives at `~/.switchroom/vault/vault.enc`
    // and the legacy path is a symlink. The bind-mount target is the
    // NEW parent dir, NOT `dirname(customVaultPath)`.
    expect(resolveVaultBindMountDir(fakeHome, {
      migrationKind: "migrated",
      customVaultPath: "/home/op/.switchroom/vault.enc",
    })).toBe("/home/op/.switchroom/vault");

    // Same when the operator re-runs apply (already-migrated):
    expect(resolveVaultBindMountDir(fakeHome, {
      migrationKind: "already-migrated",
      customVaultPath: "/home/op/.switchroom/vault.enc",
    })).toBe("/home/op/.switchroom/vault");
  });

  it("default config + new canonical vault.path → canonical parent dir", () => {
    // Operator updated their config to the new path explicitly.
    expect(resolveVaultBindMountDir(fakeHome, {
      migrationKind: "already-migrated",
      customVaultPath: "/home/op/.switchroom/vault/vault.enc",
    })).toBe("/home/op/.switchroom/vault");
  });

  it("genuinely custom vault.path → dirname(customPath)", () => {
    // Operator with `vault.path: /opt/secrets/vault.enc`. Migration
    // returns `custom-path-skipped`. Bind-mount target derives from
    // the configured path's parent.
    expect(resolveVaultBindMountDir(fakeHome, {
      migrationKind: "custom-path-skipped",
      customVaultPath: "/opt/secrets/vault.enc",
    })).toBe("/opt/secrets");
  });

  it("no vault.path configured → canonical parent dir (default)", () => {
    // No vault.path means schema default kicks in (post-v0.7.12 that's
    // `~/.switchroom/vault/vault.enc`). Migration returns `migrated`
    // or `no-vault` depending on disk state.
    expect(resolveVaultBindMountDir(fakeHome, {
      migrationKind: "no-vault",
      customVaultPath: undefined,
    })).toBe("/home/op/.switchroom/vault");
    expect(resolveVaultBindMountDir(fakeHome, {
      migrationKind: "migrated",
      customVaultPath: undefined,
    })).toBe("/home/op/.switchroom/vault");
  });

  it("custom-path-skipped without customVaultPath → falls back to canonical", () => {
    // Defensive — shouldn't happen in practice (custom-path-skipped
    // implies customVaultPath is set), but the guard handles it
    // safely rather than throwing.
    expect(resolveVaultBindMountDir(fakeHome, {
      migrationKind: "custom-path-skipped",
      customVaultPath: undefined,
    })).toBe("/home/op/.switchroom/vault");
  });
});

describe("inspectVaultBindMountDir (#961)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "vault-guard-test-"));
  });

  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  });

  it("missing dir → kind:'missing'", () => {
    const result = inspectVaultBindMountDir(join(tmp, "nope"));
    expect(result.kind).toBe("missing");
  });

  it("dir with only canonical vault.enc → kind:'ok'", () => {
    writeFileSync(join(tmp, "vault.enc"), "blob");
    expect(inspectVaultBindMountDir(tmp).kind).toBe("ok");
  });

  it("dir with vault.enc + .bak → kind:'ok'", () => {
    writeFileSync(join(tmp, "vault.enc"), "blob");
    writeFileSync(join(tmp, "vault.enc.bak"), "old-blob");
    expect(inspectVaultBindMountDir(tmp).kind).toBe("ok");
  });

  it("dir with sibling-tmp pattern → kind:'ok' (atomic-write in flight)", () => {
    writeFileSync(join(tmp, "vault.enc"), "blob");
    // atomicWriteFileSync produces `.vault.enc.<pid>.<ms>.tmp` —
    // appears mid-write. Whitelist matches it.
    writeFileSync(join(tmp, ".vault.enc.12345.1700000000000.tmp"), "in-flight");
    expect(inspectVaultBindMountDir(tmp).kind).toBe("ok");
  });

  it("dir with proper-lockfile sentinel-dir → kind:'ok'", () => {
    writeFileSync(join(tmp, "vault.enc"), "blob");
    mkdirSync(join(tmp, "vault.enc.lock"), { recursive: true });
    expect(inspectVaultBindMountDir(tmp).kind).toBe("ok");
  });

  it("dir with .symlink-tmp from migration helper → kind:'ok'", () => {
    writeFileSync(join(tmp, "vault.enc"), "blob");
    writeFileSync(join(tmp, ".vault.enc.symlink-tmp"), "x");
    expect(inspectVaultBindMountDir(tmp).kind).toBe("ok");
  });

  it("dir with operator's misplaced backup → kind:'unexpected-files'", () => {
    // The exact failure mode that #958 was caught against: an
    // operator's own ~/.switchroom/ contained ad-hoc backup files
    // and config dirs.
    writeFileSync(join(tmp, "vault.enc"), "blob");
    writeFileSync(join(tmp, "switchroom.yaml.bak.2026-04-20"), "stale-config");
    writeFileSync(join(tmp, ".env.vault"), "env-tmp");
    mkdirSync(join(tmp, "approvals"), { recursive: true });

    const result = inspectVaultBindMountDir(tmp);
    expect(result.kind).toBe("unexpected-files");
    if (result.kind === "unexpected-files") {
      expect(result.unknown).toContain("switchroom.yaml.bak.2026-04-20");
      expect(result.unknown).toContain(".env.vault");
      expect(result.unknown).toContain("approvals");
      expect(result.unknown).not.toContain("vault.enc");
    }
  });

  it("dir with ONLY unexpected files → kind:'unexpected-files' (no vault yet)", () => {
    // Defensive — even when there's no vault.enc yet, an unexpected
    // file in the dir blocks compose-gen.
    writeFileSync(join(tmp, "random-thing"), "x");
    const result = inspectVaultBindMountDir(tmp);
    expect(result.kind).toBe("unexpected-files");
    if (result.kind === "unexpected-files") {
      expect(result.unknown).toEqual(["random-thing"]);
    }
  });

  it("empty dir → kind:'ok' (compose will lay down vault.enc on first up)", () => {
    expect(inspectVaultBindMountDir(tmp).kind).toBe("ok");
  });
});
