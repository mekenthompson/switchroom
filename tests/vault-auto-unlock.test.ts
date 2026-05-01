/**
 * Tests for the CLI helper module that wraps the machine-bound crypto
 * (encryption, YAML mutation, apply flow). The crypto itself is tested in
 * src/vault/auto-unlock.test.ts.
 */

import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyAutoUnlock,
  encryptCredential,
  setVaultBrokerAutoUnlock,
} from "../src/cli/vault-auto-unlock.js";
import { readAutoUnlockFile } from "../src/vault/auto-unlock.js";

describe("encryptCredential", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "switchroom-au-cli-"));
  });

  it("writes a blob that decrypts back to the original passphrase", () => {
    const credPath = join(tmp, "auto-unlock.bin");
    encryptCredential("p4ssphrase", credPath);
    expect(readAutoUnlockFile(credPath)).toBe("p4ssphrase");
  });

  it("creates parent directory and tightens perms to 0600", () => {
    const credPath = join(tmp, "subdir", "auto-unlock.bin");
    encryptCredential("p", credPath);
    const stat = statSync(credPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("overwrites a stale blob on re-run (idempotent)", () => {
    const credPath = join(tmp, "auto-unlock.bin");
    encryptCredential("first", credPath);
    encryptCredential("second", credPath);
    expect(readAutoUnlockFile(credPath)).toBe("second");
  });
});

describe("setVaultBrokerAutoUnlock", () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "switchroom-yaml-"));
    configPath = join(tmp, "switchroom.yaml");
  });

  it("creates vault.broker.autoUnlock when config has none of those keys", () => {
    writeFileSync(
      configPath,
      "# header comment\nagents:\n  alice:\n    extends: default\n",
      "utf-8",
    );
    setVaultBrokerAutoUnlock(configPath, true);
    const after = readFileSync(configPath, "utf-8");
    expect(after).toContain("autoUnlock: true");
    expect(after).toContain("# header comment");
    expect(after).toContain("alice:");
  });

  it("flips an existing false value to true without disturbing siblings", () => {
    writeFileSync(
      configPath,
      [
        "vault:",
        "  path: ~/.switchroom/vault.enc",
        "  broker:",
        "    autoUnlock: false  # toggled by enable-auto-unlock",
        "    socket: ~/.switchroom/vault-broker.sock",
        "agents: {}",
        "",
      ].join("\n"),
      "utf-8",
    );
    setVaultBrokerAutoUnlock(configPath, true);
    const after = readFileSync(configPath, "utf-8");
    expect(after).toMatch(/autoUnlock: true/);
    expect(after).toContain("path: ~/.switchroom/vault.enc");
    expect(after).toContain("socket: ~/.switchroom/vault-broker.sock");
    expect(after).toContain("# toggled by enable-auto-unlock");
  });
});

describe("applyAutoUnlock", () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "switchroom-apply-"));
    configPath = join(tmp, "switchroom.yaml");
    writeFileSync(
      configPath,
      [
        "switchroom:",
        "  version: 1",
        "telegram:",
        '  bot_token: "vault:telegram-bot-token"',
        '  forum_chat_id: "-1001234567890"',
        "vault:",
        "  path: " + join(tmp, "vault.enc"),
        "  broker:",
        "    autoUnlock: false",
        "    socket: " + join(tmp, "broker.sock"),
        "agents: {}",
        "",
      ].join("\n"),
      "utf-8",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flips YAML, calls systemctl, polls status, and reports success when vault unlocks", async () => {
    const systemd = await import("../src/agents/systemd.js");
    vi.spyOn(systemd, "installAllUnits").mockImplementation(() => {});

    const systemctlCalls: string[][] = [];
    const runSystemctl = vi.fn((args: string[]) => {
      systemctlCalls.push(args);
      return { status: 0 };
    });
    let polled = 0;
    const pollStatus = vi.fn(async () => {
      polled++;
      return polled >= 2 ? { unlocked: true } : { unlocked: false };
    });

    await applyAutoUnlock({
      configPath,
      log: () => {},
      err: () => {},
      runSystemctl,
      pollStatus,
      verifyTimeoutMs: 2000,
    });

    expect(readFileSync(configPath, "utf-8")).toContain("autoUnlock: true");
    expect(systemctlCalls).toContainEqual(["--user", "daemon-reload"]);
    expect(systemctlCalls).toContainEqual(["--user", "restart", "switchroom-vault-broker.service"]);
    expect(polled).toBeGreaterThanOrEqual(2);
  });

  it("throws when the broker restart exits non-zero", async () => {
    const systemd = await import("../src/agents/systemd.js");
    vi.spyOn(systemd, "installAllUnits").mockImplementation(() => {});

    const runSystemctl = vi.fn((args: string[]) => {
      if (args.includes("restart")) return { status: 1 };
      return { status: 0 };
    });

    await expect(
      applyAutoUnlock({
        configPath,
        log: () => {},
        err: () => {},
        runSystemctl,
        pollStatus: async () => ({ unlocked: false }),
        verifyTimeoutMs: 500,
      }),
    ).rejects.toThrow(/broker restart exited 1/);
  });

  it("throws when verify-poll times out", async () => {
    const systemd = await import("../src/agents/systemd.js");
    vi.spyOn(systemd, "installAllUnits").mockImplementation(() => {});

    await expect(
      applyAutoUnlock({
        configPath,
        log: () => {},
        err: () => {},
        runSystemctl: () => ({ status: 0 }),
        pollStatus: async () => ({ unlocked: false }),
        verifyTimeoutMs: 500,
      }),
    ).rejects.toThrow(/verification timeout/);
  });
});
