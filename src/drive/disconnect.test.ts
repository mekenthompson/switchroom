/**
 * Killswitch / disconnect path tests (RFC C §4.3).
 *
 * The load-bearing assertion: local cleanup ALWAYS happens, even when the
 * Google revoke endpoint fails or the network is down. The user is told
 * about the Google failure separately so they can manually revoke at
 * myaccount.google.com/permissions.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { disconnectDrive } from "./disconnect.js";
import { writeRefreshToken, readRefreshToken } from "./vault-slots.js";
import { createVault } from "../vault/vault.js";

let dir: string;
let vaultPath: string;
const PASS = "test-pass";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drive-disconnect-"));
  vaultPath = join(dir, "vault.enc");
  createVault(PASS, vaultPath);
  writeRefreshToken({
    passphrase: PASS,
    vaultPath,
    agentUnit: "klanker",
    refreshToken: "rt-abc",
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("disconnectDrive", () => {
  it("clears local slots even when Google revoke fails", async () => {
    const fakeFetch = mock(
      async () => new Response("oops", { status: 503 }),
    ) as unknown as typeof fetch;
    const r = await disconnectDrive({
      passphrase: PASS,
      vaultPath,
      agentUnit: "klanker",
      fetchImpl: fakeFetch,
    });

    expect(r.local_revoked).toBe(true);
    expect(r.google_revoke).toBe("failed");
    expect(
      readRefreshToken({ passphrase: PASS, vaultPath, agentUnit: "klanker" }),
    ).toBe(null);
  });

  it("clears local slots even when fetch itself throws (network down)", async () => {
    const fakeFetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await disconnectDrive({
      passphrase: PASS,
      vaultPath,
      agentUnit: "klanker",
      fetchImpl: fakeFetch,
    });

    expect(r.local_revoked).toBe(true);
    expect(r.google_revoke).toBe("failed");
    expect(
      readRefreshToken({ passphrase: PASS, vaultPath, agentUnit: "klanker" }),
    ).toBe(null);
  });

  it("returns ok when Google accepts the revoke", async () => {
    const fakeFetch = mock(
      async () => new Response("", { status: 200 }),
    ) as unknown as typeof fetch;
    const r = await disconnectDrive({
      passphrase: PASS,
      vaultPath,
      agentUnit: "klanker",
      fetchImpl: fakeFetch,
    });
    expect(r.google_revoke).toBe("ok");
    expect(r.local_revoked).toBe(true);
  });

  it("skipped when no refresh token is present (idempotent revoke)", async () => {
    // Wipe first
    await disconnectDrive({
      passphrase: PASS,
      vaultPath,
      agentUnit: "klanker",
      fetchImpl: mock(async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    });
    // Second call — slot already empty
    const r = await disconnectDrive({
      passphrase: PASS,
      vaultPath,
      agentUnit: "klanker",
      fetchImpl: mock(async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    });
    expect(r.google_revoke).toBe("skipped");
    expect(r.local_revoked).toBe(true);
  });

  it("vault file still exists after disconnect (we wipe slots, not the vault)", async () => {
    await disconnectDrive({
      passphrase: PASS,
      vaultPath,
      agentUnit: "klanker",
      fetchImpl: mock(async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    });
    expect(existsSync(vaultPath)).toBe(true);
  });
});
