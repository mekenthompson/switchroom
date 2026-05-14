/**
 * Unit tests for `enrichMirrorContent` — the broker's text-in /
 * text-out wrapper around `enrichClaudeCreds` used by
 * `mirrorAccountToAgent` to heal stale legacy source files at fanout
 * time.
 *
 * Companion integration test (`server-mirror-enrich.test.ts`) drives
 * the same path through `mirrorAccountToAgent` end-to-end.
 */

import { describe, expect, it } from "vitest";

import { enrichMirrorContent } from "./server.js";

describe("enrichMirrorContent", () => {
  it("fills empty scopes with the canonical user:inference scope", () => {
    const source = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-x",
        expiresAt: 123,
        scopes: [],
        subscriptionType: "max",
      },
    });
    const enriched = JSON.parse(enrichMirrorContent(source));
    expect(enriched.claudeAiOauth.scopes).toEqual(["user:inference"]);
  });

  it("fills missing scopes with the canonical user:inference scope", () => {
    const source = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-x",
        expiresAt: 123,
        subscriptionType: "max",
      },
    });
    const enriched = JSON.parse(enrichMirrorContent(source));
    expect(enriched.claudeAiOauth.scopes).toEqual(["user:inference"]);
  });

  it("fills missing subscriptionType with 'max'", () => {
    const source = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-x",
        expiresAt: 123,
        scopes: ["user:inference"],
      },
    });
    const enriched = JSON.parse(enrichMirrorContent(source));
    expect(enriched.claudeAiOauth.subscriptionType).toBe("max");
  });

  it("preserves existing non-empty scopes verbatim", () => {
    const customScopes = [
      "user:inference",
      "user:profile",
      "user:sessions:claude_code",
    ];
    const source = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-x",
        expiresAt: 123,
        scopes: customScopes,
        subscriptionType: "pro",
      },
    });
    expect(enrichMirrorContent(source)).toBe(source);
  });

  it("returns source string verbatim (byte-identical) when already enriched", () => {
    const source = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-x",
        expiresAt: 123,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    });
    // Critical for diff-stability of per-agent mirrors — operator
    // tooling that snapshots .credentials.json shouldn't see whitespace
    // churn just because the mirror got rewritten.
    expect(enrichMirrorContent(source)).toBe(source);
  });

  it("returns source string verbatim when JSON is malformed", () => {
    const source = "{not valid json";
    expect(enrichMirrorContent(source)).toBe(source);
  });

  it("returns source string verbatim when claudeAiOauth is missing", () => {
    const source = JSON.stringify({ otherShape: { foo: "bar" } });
    expect(enrichMirrorContent(source)).toBe(source);
  });

  it("preserves a custom (non-canonical) scope set when only subscriptionType is missing", () => {
    // Reviewer-flagged edge case: source has scopes the operator
    // explicitly chose (e.g. broader claude scopes) AND missing
    // subscriptionType. Enrichment must add subscriptionType WITHOUT
    // clobbering the existing scope set.
    const source = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-x",
        expiresAt: 123,
        scopes: ["org:create_api_key", "user:profile", "user:inference"],
      },
    });
    const enriched = JSON.parse(enrichMirrorContent(source));
    expect(enriched.claudeAiOauth.scopes).toEqual([
      "org:create_api_key",
      "user:profile",
      "user:inference",
    ]);
    expect(enriched.claudeAiOauth.subscriptionType).toBe("max");
  });

  it("preserves other claudeAiOauth fields when enriching (refreshToken, rateLimitTier)", () => {
    const source = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-x",
        refreshToken: "rt-x",
        expiresAt: 123,
        scopes: [],
        rateLimitTier: "default_claude_max_20x",
      },
    });
    const enriched = JSON.parse(enrichMirrorContent(source));
    expect(enriched.claudeAiOauth.refreshToken).toBe("rt-x");
    expect(enriched.claudeAiOauth.rateLimitTier).toBe("default_claude_max_20x");
    expect(enriched.claudeAiOauth.accessToken).toBe("at-x");
    expect(enriched.claudeAiOauth.expiresAt).toBe(123);
  });
});
