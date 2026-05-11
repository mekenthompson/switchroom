/**
 * Test for #1000 — `vault set --no-broker` must preserve a symlinked
 * vault path rather than replacing the symlink with a regular file.
 *
 * Reproduces the v0.7.12+ layout where `~/.switchroom/vault.enc` is a
 * symlink to `~/.switchroom/vault/vault.enc`, then exercises a write
 * through the symlinked path. Pre-fix the rename targeted the symlink
 * itself (replacing it); post-fix it follows the link and targets the
 * underlying file.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createVault, setStringSecret, openVault } from "./vault.js";

const PASSPHRASE = "symlink-preserve-test-pass";

describe("saveVault — symlink preservation (#1000)", () => {
  it("writing through a symlinked vault path preserves the symlink", () => {
    // Set up the canonical v0.7.12+ layout: symlink at the legacy path,
    // real file at the new path.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-symlink-"));
    const vaultDir = path.join(tmpDir, "vault");
    fs.mkdirSync(vaultDir, { recursive: true });

    const realPath = path.join(vaultDir, "vault.enc");
    const linkPath = path.join(tmpDir, "vault.enc");

    createVault(PASSPHRASE, realPath);
    fs.symlinkSync("vault/vault.enc", linkPath);

    // Sanity: the layout we expect.
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(realPath).isFile()).toBe(true);

    // Write a secret through the SYMLINK path.
    setStringSecret(PASSPHRASE, linkPath, "shared_token", "fresh-value");

    // The symlink must STILL be a symlink (pre-fix it became a regular file).
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    // And the real file at the target must have been updated.
    expect(fs.lstatSync(realPath).isFile()).toBe(true);

    // Read back through either path — both must see the new secret.
    const viaLink = openVault(PASSPHRASE, linkPath);
    const viaReal = openVault(PASSPHRASE, realPath);
    expect(viaLink.shared_token).toBeDefined();
    expect(viaReal.shared_token).toBeDefined();
    if (viaLink.shared_token?.kind === "string") {
      expect(viaLink.shared_token.value).toBe("fresh-value");
    }
    if (viaReal.shared_token?.kind === "string") {
      expect(viaReal.shared_token.value).toBe("fresh-value");
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("non-symlinked vault path is unaffected (regression guard)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-plain-"));
    const vaultPath = path.join(tmpDir, "vault.enc");
    createVault(PASSPHRASE, vaultPath);

    setStringSecret(PASSPHRASE, vaultPath, "shared_token", "v1");
    expect(fs.lstatSync(vaultPath).isFile()).toBe(true);

    setStringSecret(PASSPHRASE, vaultPath, "shared_token", "v2");
    const opened = openVault(PASSPHRASE, vaultPath);
    if (opened.shared_token?.kind === "string") {
      expect(opened.shared_token.value).toBe("v2");
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
