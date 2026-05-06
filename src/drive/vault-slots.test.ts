/**
 * vault-slots — round-trip + idempotent delete tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refreshTokenSlot,
  statusSlot,
  writeRefreshToken,
  readRefreshToken,
  writeStatus,
  readStatus,
  deleteSlots,
} from "./vault-slots.js";
import { createVault } from "../vault/vault.js";

let dir: string;
let vaultPath: string;
const PASS = "p";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drive-slots-"));
  vaultPath = join(dir, "vault.enc");
  createVault(PASS, vaultPath);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("slot key shapes (RFC C §4)", () => {
  it("refreshTokenSlot follows gdrive:<unit>:refresh_token", () => {
    expect(refreshTokenSlot("klanker")).toBe("gdrive:klanker:refresh_token");
  });
  it("statusSlot follows gdrive:<unit>:status", () => {
    expect(statusSlot("klanker")).toBe("gdrive:klanker:status");
  });
});

describe("round-trip", () => {
  it("stores and reads back the refresh token", () => {
    writeRefreshToken({
      passphrase: PASS,
      vaultPath,
      agentUnit: "klanker",
      refreshToken: "rt-1",
    });
    expect(
      readRefreshToken({ passphrase: PASS, vaultPath, agentUnit: "klanker" }),
    ).toBe("rt-1");
  });

  it("overwrites prior token (no version history)", () => {
    writeRefreshToken({
      passphrase: PASS,
      vaultPath,
      agentUnit: "k",
      refreshToken: "old",
    });
    writeRefreshToken({
      passphrase: PASS,
      vaultPath,
      agentUnit: "k",
      refreshToken: "new",
    });
    expect(
      readRefreshToken({ passphrase: PASS, vaultPath, agentUnit: "k" }),
    ).toBe("new");
  });

  it("stores and reads back status sidecar", () => {
    writeStatus({
      passphrase: PASS,
      vaultPath,
      agentUnit: "k",
      status: "invalid_grant",
      detail: "rotated",
      now: 1234,
    });
    const s = readStatus({ passphrase: PASS, vaultPath, agentUnit: "k" });
    expect(s?.status).toBe("invalid_grant");
    expect(s?.detail).toBe("rotated");
    expect(s?.ts).toBe(1234);
  });

  it("readStatus returns null when slot absent (healthy / never connected)", () => {
    expect(
      readStatus({ passphrase: PASS, vaultPath, agentUnit: "k" }),
    ).toBe(null);
  });
});

describe("deleteSlots", () => {
  it("removes both slots and is idempotent", () => {
    writeRefreshToken({ passphrase: PASS, vaultPath, agentUnit: "k", refreshToken: "rt" });
    writeStatus({
      passphrase: PASS,
      vaultPath,
      agentUnit: "k",
      status: "connected",
    });
    deleteSlots({ passphrase: PASS, vaultPath, agentUnit: "k" });
    deleteSlots({ passphrase: PASS, vaultPath, agentUnit: "k" });
    expect(
      readRefreshToken({ passphrase: PASS, vaultPath, agentUnit: "k" }),
    ).toBe(null);
    expect(
      readStatus({ passphrase: PASS, vaultPath, agentUnit: "k" }),
    ).toBe(null);
  });
});
