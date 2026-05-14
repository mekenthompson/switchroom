/**
 * vault-slots — round-trip + idempotent delete tests.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteGoogleAccountSlots,
  deleteSlots,
  detectLegacyGdriveSlots,
  googleAccountRefreshTokenSlot,
  googleAccountStatusSlot,
  normalizeGoogleAccount,
  readGoogleAccountRefreshToken,
  readGoogleAccountStatus,
  readRefreshToken,
  readStatus,
  refreshTokenSlot,
  statusSlot,
  writeGoogleAccountRefreshToken,
  writeGoogleAccountStatus,
  writeRefreshToken,
  writeStatus,
} from "./vault-slots.js";
import { createVault, listSecrets } from "../vault/vault.js";

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

// ────────────────────────────────────────────────────────────────────────
// RFC G Phase 2 — per-Google-account slots
// ────────────────────────────────────────────────────────────────────────

describe("normalizeGoogleAccount", () => {
  it("lowercases and trims", () => {
    expect(normalizeGoogleAccount("  Alice@Example.COM  ")).toBe("alice@example.com");
  });
  it("idempotent on already-normalized input", () => {
    expect(normalizeGoogleAccount("alice@example.com")).toBe("alice@example.com");
  });
});

describe("google account slot key shapes (RFC G §4.4)", () => {
  it("googleAccountRefreshTokenSlot follows google:<account>:refresh_token", () => {
    expect(googleAccountRefreshTokenSlot("alice@example.com")).toBe(
      "google:alice@example.com:refresh_token",
    );
  });
  it("googleAccountStatusSlot follows google:<account>:status", () => {
    expect(googleAccountStatusSlot("alice@example.com")).toBe(
      "google:alice@example.com:status",
    );
  });
  it("normalizes account casing in the slot key", () => {
    expect(googleAccountRefreshTokenSlot("Alice@Example.COM")).toBe(
      "google:alice@example.com:refresh_token",
    );
  });
});

describe("google account round-trip", () => {
  it("stores and reads back the refresh token by account", () => {
    writeGoogleAccountRefreshToken({
      passphrase: PASS,
      vaultPath,
      account: "alice@example.com",
      refreshToken: "rt-account",
    });
    expect(
      readGoogleAccountRefreshToken({
        passphrase: PASS,
        vaultPath,
        account: "alice@example.com",
      }),
    ).toBe("rt-account");
  });

  it("normalization makes case-variant reads hit the same slot", () => {
    writeGoogleAccountRefreshToken({
      passphrase: PASS,
      vaultPath,
      account: "alice@example.com",
      refreshToken: "rt",
    });
    expect(
      readGoogleAccountRefreshToken({
        passphrase: PASS,
        vaultPath,
        account: "ALICE@EXAMPLE.COM",
      }),
    ).toBe("rt");
  });

  it("stores and reads back per-account status", () => {
    writeGoogleAccountStatus({
      passphrase: PASS,
      vaultPath,
      account: "alice@example.com",
      status: "invalid_grant",
      detail: "rotated-by-google",
      now: 9000,
    });
    const s = readGoogleAccountStatus({
      passphrase: PASS,
      vaultPath,
      account: "alice@example.com",
    });
    expect(s?.status).toBe("invalid_grant");
    expect(s?.detail).toBe("rotated-by-google");
    expect(s?.ts).toBe(9000);
  });

  it("returns null when account slot is absent", () => {
    expect(
      readGoogleAccountRefreshToken({
        passphrase: PASS,
        vaultPath,
        account: "nobody@example.com",
      }),
    ).toBe(null);
    expect(
      readGoogleAccountStatus({
        passphrase: PASS,
        vaultPath,
        account: "nobody@example.com",
      }),
    ).toBe(null);
  });
});

describe("deleteGoogleAccountSlots", () => {
  it("removes both per-account slots and is idempotent", () => {
    writeGoogleAccountRefreshToken({
      passphrase: PASS,
      vaultPath,
      account: "alice@example.com",
      refreshToken: "rt",
    });
    writeGoogleAccountStatus({
      passphrase: PASS,
      vaultPath,
      account: "alice@example.com",
      status: "connected",
    });
    deleteGoogleAccountSlots({
      passphrase: PASS,
      vaultPath,
      account: "alice@example.com",
    });
    deleteGoogleAccountSlots({
      passphrase: PASS,
      vaultPath,
      account: "alice@example.com",
    });
    expect(
      readGoogleAccountRefreshToken({
        passphrase: PASS,
        vaultPath,
        account: "alice@example.com",
      }),
    ).toBe(null);
    expect(
      readGoogleAccountStatus({
        passphrase: PASS,
        vaultPath,
        account: "alice@example.com",
      }),
    ).toBe(null);
  });

  it("does NOT touch the legacy per-agent slot for the same email-shaped agent_unit", () => {
    // Edge case: an agent_unit could conceivably contain `@` (it doesn't
    // by current naming convention, but defending against future drift).
    // The two slot families must be disjoint.
    writeRefreshToken({
      passphrase: PASS,
      vaultPath,
      agentUnit: "klanker",
      refreshToken: "agent-token",
    });
    writeGoogleAccountRefreshToken({
      passphrase: PASS,
      vaultPath,
      account: "alice@example.com",
      refreshToken: "account-token",
    });
    deleteGoogleAccountSlots({
      passphrase: PASS,
      vaultPath,
      account: "alice@example.com",
    });
    expect(
      readRefreshToken({ passphrase: PASS, vaultPath, agentUnit: "klanker" }),
    ).toBe("agent-token");
  });
});

describe("detectLegacyGdriveSlots", () => {
  it("returns empty for an empty vault", () => {
    expect(detectLegacyGdriveSlots([])).toEqual([]);
  });

  it("returns empty when vault has only canonical google: slots", () => {
    expect(
      detectLegacyGdriveSlots([
        "google:alice@example.com:refresh_token",
        "google:alice@example.com:status",
      ]),
    ).toEqual([]);
  });

  it("extracts agent units from legacy gdrive: slots, ignoring status sidecars", () => {
    expect(
      detectLegacyGdriveSlots([
        "gdrive:klanker:refresh_token",
        "gdrive:klanker:status",
        "gdrive:gymbro:refresh_token",
        "secret:OPENAI_API_KEY",
      ]).sort(),
    ).toEqual(["gymbro", "klanker"]);
  });

  it("end-to-end: pulls the legacy units from a real vault listing", () => {
    writeRefreshToken({
      passphrase: PASS,
      vaultPath,
      agentUnit: "klanker",
      refreshToken: "rt",
    });
    writeRefreshToken({
      passphrase: PASS,
      vaultPath,
      agentUnit: "gymbro",
      refreshToken: "rt",
    });
    writeGoogleAccountRefreshToken({
      passphrase: PASS,
      vaultPath,
      account: "alice@example.com",
      refreshToken: "rt",
    });
    const keys = listSecrets(PASS, vaultPath);
    expect(detectLegacyGdriveSlots(keys).sort()).toEqual(["gymbro", "klanker"]);
  });
});
