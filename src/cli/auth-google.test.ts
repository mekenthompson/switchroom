/**
 * Unit tests for `switchroom auth google` helpers.
 *
 * Coverage focus is the pure helpers extracted from registerAccountAdd
 * (Phase 3b.3 de-stub). Wiring of the full `auth google account add`
 * verb (OAuth flow + brokerCall + vault-ref resolution) is exercised
 * by manual smoke (RFC G §6) and the broker-server integration tests.
 */

import { describe, expect, it } from "vitest";

import { _testing } from "./auth-google.js";

const { validateAndNormalizeAccountEmail, buildGoogleCredentials } = _testing;

describe("validateAndNormalizeAccountEmail", () => {
  it("lowercases + trims valid emails", () => {
    expect(validateAndNormalizeAccountEmail("  Alice@Example.COM  ")).toBe(
      "alice@example.com",
    );
  });

  it("rejects malformed emails", () => {
    expect(() => validateAndNormalizeAccountEmail("not-an-email")).toThrow(
      /not a valid Google account email/,
    );
    expect(() => validateAndNormalizeAccountEmail("@example.com")).toThrow();
    expect(() => validateAndNormalizeAccountEmail("alice@")).toThrow();
  });

  it("rejects emails containing colon (would break broker slot-key parser)", () => {
    expect(() =>
      validateAndNormalizeAccountEmail("alice:bob@example.com"),
    ).toThrow();
  });
});

describe("buildGoogleCredentials", () => {
  const baseTokens = {
    access_token: "ya29.test-access",
    refresh_token: "1//test-refresh",
    expires_in: 3600,
    scope: "https://www.googleapis.com/auth/drive.readonly",
  };

  it("constructs the GoogleAddAccountCredentials shape the broker expects", () => {
    const creds = buildGoogleCredentials({
      tokens: baseTokens,
      clientId: "client-id-123.apps.googleusercontent.com",
      accountEmail: "alice@example.com",
      fallbackScope: "https://www.googleapis.com/auth/drive.readonly",
      now: () => 1_000_000,
    });
    expect(creds.googleOauth.accessToken).toBe("ya29.test-access");
    expect(creds.googleOauth.refreshToken).toBe("1//test-refresh");
    expect(creds.googleOauth.expiresAt).toBe(1_000_000 + 3600 * 1000);
    expect(creds.googleOauth.scope).toBe(
      "https://www.googleapis.com/auth/drive.readonly",
    );
    expect(creds.googleOauth.clientId).toBe(
      "client-id-123.apps.googleusercontent.com",
    );
    expect(creds.googleOauth.accountEmail).toBe("alice@example.com");
    expect(creds.googleOauth.tokenType).toBe("Bearer");
  });

  it("falls back to fallbackScope when Google omits scope", () => {
    const creds = buildGoogleCredentials({
      tokens: { ...baseTokens, scope: undefined },
      clientId: "x",
      accountEmail: "a@b.com",
      fallbackScope: "scope-a scope-b",
      now: () => 0,
    });
    expect(creds.googleOauth.scope).toBe("scope-a scope-b");
  });

  it("throws when refresh_token is missing", () => {
    expect(() =>
      buildGoogleCredentials({
        tokens: { ...baseTokens, refresh_token: undefined },
        clientId: "x",
        accountEmail: "a@b.com",
        fallbackScope: "x",
      }),
    ).toThrow(/refresh_token/);
  });
});

describe("oauthClientSetupGuidance", () => {
  const { oauthClientSetupGuidance } = _testing;

  it("leads with the caller-supplied reason", () => {
    const msg = oauthClientSetupGuidance("SPECIFIC_REASON_X");
    expect(msg.startsWith("SPECIFIC_REASON_X")).toBe(true);
  });

  it("surfaces the native one-command fix first, then the manual path", () => {
    const msg = oauthClientSetupGuidance("r");
    expect(msg).toContain("switchroom auth google connect");
    expect(msg).toContain("switchroom vault set google-oauth-client-id");
    expect(msg).toContain("switchroom vault set google-oauth-client-secret");
    expect(msg).toContain("google_workspace:");
    const nativeIdx = msg.indexOf("switchroom auth google connect");
    const manualIdx = msg.indexOf("switchroom vault set");
    expect(nativeIdx).toBeGreaterThan(-1);
    expect(nativeIdx).toBeLessThan(manualIdx);
  });

  it("points at the canonical doc section", () => {
    expect(oauthClientSetupGuidance("r")).toContain(
      "docs/google-workspace.md",
    );
  });

  it("distinguishes the two callsites by reason", () => {
    const a = oauthClientSetupGuidance("no block");
    const b = oauthClientSetupGuidance("empty id/secret");
    expect(a).not.toBe(b);
    expect(a).toContain("no block");
    expect(b).toContain("empty id/secret");
  });
});

describe("interpretConnectPutResult", () => {
  const { interpretConnectPutResult } = _testing;

  it("passes a successful put through", () => {
    expect(interpretConnectPutResult("k", { kind: "ok" })).toEqual({
      ok: true,
    });
  });

  it("unreachable → not stored + points at broker recovery, no direct-file fallback", () => {
    const v = interpretConnectPutResult("google-oauth-client-id", {
      kind: "unreachable",
      msg: "ENOENT socket",
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.message).toContain("google-oauth-client-id");
    expect(v.message).toContain("was not");
    expect(v.message).toContain("switchroom vault broker status");
    expect(v.message).toContain("ENOENT socket");
    // Must NOT suggest bypassing the broker — that's the bug we removed.
    expect(v.message.toLowerCase()).not.toContain("--no-broker");
    expect(v.message.toLowerCase()).not.toContain("vault.enc");
  });

  it("denied → surfaces code/msg and the passphrase-mismatch hint", () => {
    const v = interpretConnectPutResult("google-oauth-client-secret", {
      kind: "denied",
      code: "DENIED",
      msg: "supplied passphrase does not match",
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.message).toContain("[DENIED]");
    expect(v.message).toContain("supplied passphrase does not match");
    expect(v.message.toLowerCase()).toContain("passphrase");
  });

  it("not_found → explains operator attestation is required", () => {
    const v = interpretConnectPutResult("google-oauth-client-id", {
      kind: "not_found",
      code: "UNKNOWN_KEY",
      msg: "unknown key",
    });
    expect(v.ok).toBe(false);
    if (v.ok) throw new Error("unreachable");
    expect(v.message).toContain("[UNKNOWN_KEY]");
    expect(v.message.toLowerCase()).toContain("attest");
  });
});
