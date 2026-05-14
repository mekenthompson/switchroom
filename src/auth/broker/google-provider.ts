/**
 * GoogleProvider — Provider implementation for Google OAuth
 * (RFC G Phase 3b.2a).
 *
 * Wraps `src/drive/oauth.ts:refreshAccessToken` (the existing RFC D
 * refresh exchange) as a Provider. Unlike AnthropicProvider — which
 * delegates back to the broker's storage layer — GoogleProvider
 * actually calls Google's OAuth token endpoint, parses the response,
 * and returns a structured `RefreshSuccess` for the broker to store.
 *
 * **What this provider owns:**
 *   - HTTP refresh exchange against Google's `/token` endpoint
 *   - Google-specific error mapping (`invalid_grant` for password change /
 *     app revocation / 7-day Testing-mode expiry; rate-limit detection)
 *   - Credential shape (`googleOauth: { ... }` per protocol.ts)
 *   - Expiry extraction from `googleOauth.expiresAt`
 *
 * **What the broker owns** (per the per-account state model that
 * Phase 3b.2b will refactor onto AccountKey):
 *   - On-disk persistence of refresh + status sidecar
 *   - Refresh leases (one in-flight refresh per account)
 *   - Sha-index drift detection (across-restart consistency)
 *   - Fanout to consumers (MCP wrapper subprocesses for Google;
 *     per-agent .credentials.json mirrors for Anthropic)
 *
 * **Phase split:**
 *   - 3b.2a (this file): provider class + tests against fixture HTTP.
 *     Not registered with the broker yet — landing the unit standalone.
 *   - 3b.2b: register GoogleProvider when `google_accounts:` config
 *     non-empty; refactor `refreshOneAccount(label)` →
 *     `refreshOneAccount(accountKey)`; swap remaining 8 hardcoded
 *     `claudeAiOauth?.expiresAt` reads to
 *     `lookup(provider).extractExpiresAt(...)`; wire Google-specific
 *     storage path (vault slot, not per-agent .credentials.json).
 */

import {
  refreshAccessToken,
  InvalidGrantError,
  type OAuthClientConfig,
  type TokenResponse,
} from "../../drive/oauth.js";
import type { Provider, RefreshRequest, RefreshResult } from "./provider.js";
import type { GoogleCredentialsShape } from "./protocol.js";

/**
 * Construction options. The OAuth client credentials (id + optional
 * secret) are passed in by the broker — they're per-install config
 * (one OAuth client per switchroom install per Google's terms),
 * sourced from the `google_workspace.google_client_id` / `_secret`
 * config block (RFC G Phase 1).
 *
 * Per Phase 5 (`examples/personal-google-workspace-mcp/`), Desktop
 * OAuth clients are public and don't strictly need a client_secret —
 * but `refreshAccessToken` (the existing implementation) sends one
 * regardless. Phase 3b.3 may revisit this for the OAuth 2.1 PKCE
 * flow; for 3b.2a we preserve the existing shape.
 */
export interface GoogleProviderOptions {
  /** Google OAuth client id, e.g. "12345-abc.apps.googleusercontent.com". */
  clientId: string;
  /**
   * Google OAuth client secret. Empty string for PKCE flow (Desktop
   * client public mode). The existing `refreshAccessToken` always
   * passes this in the body; Google accepts an empty string for
   * Desktop clients.
   */
  clientSecret: string;
  /**
   * Injectable fetch — tests pass a stub that returns canned Google
   * token-endpoint responses. Defaults to global fetch.
   */
  fetcher?: typeof fetch;
}

export class GoogleProvider implements Provider {
  readonly name = "google" as const;

  constructor(private readonly opts: GoogleProviderOptions) {}

  async refresh(req: RefreshRequest): Promise<RefreshResult> {
    if (!req.refreshToken) {
      return {
        ok: false,
        kind: "provider_error",
        detail: "GoogleProvider.refresh: refreshToken is required",
      };
    }
    const cfg: OAuthClientConfig = {
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      // Scopes are validated server-side at refresh time (Google echoes
      // them in the response); we don't re-request scopes on refresh,
      // so this field is unused by `refreshAccessToken` for the
      // refresh path. Pass empty array for type-safety.
      scopes: [],
    };
    let token: TokenResponse;
    try {
      token = await refreshAccessToken(
        cfg,
        req.refreshToken,
        this.opts.fetcher ?? fetch,
      );
    } catch (err) {
      if (err instanceof InvalidGrantError) {
        return {
          ok: false,
          kind: "invalid_grant",
          detail: err.message,
        };
      }
      return classifyAsyncError(err);
    }
    // Google sometimes rotates the refresh token, sometimes doesn't.
    // Pass through whichever shape we got.
    const expiresAt = Date.now() + token.expires_in * 1000;
    const rawCredentials: GoogleCredentialsShape = {
      googleOauth: {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? req.refreshToken,
        expiresAt,
        scope: token.scope ?? "",
        clientId: this.opts.clientId,
        // accountEmail is NOT in the refresh response — broker stores
        // the account label (which IS the email per RFC G's per-account
        // ACL) and the wrapper should look it up from there. Phase 3b.2b
        // will pass the accountEmail through `req.clientId`-style
        // smuggling or extend RefreshRequest properly.
        accountEmail: req.clientId ?? "",
        tokenType: "Bearer",
      },
    };
    return {
      ok: true,
      accessToken: token.access_token,
      expiresAt,
      newRefreshToken: token.refresh_token,
      rawCredentials,
    };
  }

  /**
   * Extract expiry from a Google credentials object. Returns undefined
   * if the credentials are malformed or the field is absent — broker
   * treats undefined as "needs immediate refresh."
   */
  extractExpiresAt(credentials: unknown): number | undefined {
    const c = credentials as GoogleCredentialsShape | null | undefined;
    return c?.googleOauth?.expiresAt;
  }

  /**
   * Validate the on-disk shape Google credentials must conform to.
   * Returns null on success; an actionable error string on failure.
   *
   * Mirrors the GoogleCredentialsSchema from protocol.ts but with
   * actionable messages — at this layer we know we're validating an
   * operator-or-OAuth-flow input, not a wire-protocol message.
   */
  validateCredentialShape(credentials: unknown): string | null {
    if (!credentials || typeof credentials !== "object") {
      return "Google credentials must be an object";
    }
    const c = credentials as { googleOauth?: unknown };
    if (!c.googleOauth || typeof c.googleOauth !== "object") {
      return "Google credentials must have a googleOauth object";
    }
    const oauth = c.googleOauth as Record<string, unknown>;
    const required = [
      "accessToken",
      "refreshToken",
      "expiresAt",
      "scope",
      "clientId",
      "accountEmail",
    ];
    for (const field of required) {
      if (oauth[field] === undefined || oauth[field] === null) {
        return `Google googleOauth.${field} is required`;
      }
    }
    if (typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) {
      return "Google googleOauth.accessToken must be a non-empty string";
    }
    if (typeof oauth.refreshToken !== "string" || oauth.refreshToken.length === 0) {
      return "Google googleOauth.refreshToken must be a non-empty string";
    }
    if (typeof oauth.expiresAt !== "number" || oauth.expiresAt <= 0) {
      return "Google googleOauth.expiresAt must be a positive unix-ms timestamp";
    }
    if (oauth.tokenType !== "Bearer") {
      return "Google googleOauth.tokenType must be 'Bearer'";
    }
    return null;
  }
}

/**
 * Map non-InvalidGrant errors from Google's OAuth endpoint to the
 * broker's RefreshErrorKind discriminant. `refreshAccessToken` throws
 * a generic Error wrapping the response body; we string-match the
 * common patterns to give downstream UX (CLI, MCP wrapper) a useful
 * branch.
 *
 * Patterns based on Google's documented OAuth error responses:
 *   - 429 / "rate" / "quota" → quota_exceeded
 *   - "ETIMEDOUT" / "ECONNRESET" / "fetch failed" → network
 *   - everything else → provider_error (caller surfaces detail)
 */
function classifyAsyncError(err: unknown): RefreshResult {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("getaddrinfo")
  ) {
    return { ok: false, kind: "network", detail: msg };
  }
  if (
    lower.includes("429") ||
    lower.includes("rate") ||
    lower.includes("quota") ||
    lower.includes("too many requests")
  ) {
    return { ok: false, kind: "quota_exceeded", detail: msg };
  }
  return { ok: false, kind: "provider_error", detail: msg };
}
