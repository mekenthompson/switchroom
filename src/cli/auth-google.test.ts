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
