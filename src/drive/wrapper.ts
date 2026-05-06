/**
 * Drive MCP wrapper — refreshes access tokens on demand, handles
 * `invalid_grant` rotation per RFC C §4.2.
 *
 * Pure orchestration; no side-effecting I/O lives here directly. The two
 * collaborators it uses are both injectable so unit tests don't need a vault
 * or a network:
 *
 *   - `loadRefreshToken()` — pulls the durable token from the vault.
 *   - `markInvalidGrant()` — flips the sidecar status slot AND fires a
 *     kernel approval card titled "reconnect google drive". The approval
 *     surface is `system` so it goes through the standard kernel channel.
 *
 * The wrapper holds the access token in process memory only. On any
 * `invalid_grant` from Google we drop the cached access token AND mark the
 * status slot — the next call will re-attempt refresh and (if the user has
 * re-connected) recover; otherwise the request_approval card is the user's
 * recovery path.
 */

import {
  refreshAccessToken,
  InvalidGrantError,
  type OAuthClientConfig,
  type TokenResponse,
} from "./oauth.js";

export interface DriveAccessHandle {
  /** Bearer token for Authorization: Bearer <token>. */
  access_token: string;
  /** Unix-ms when this access token expires (with a small safety margin). */
  expires_at: number;
}

export interface WrapperDeps {
  /** Read the refresh token from the vault for this agent. */
  loadRefreshToken: () => Promise<string | null>;
  /**
   * Called when Google rotates/revokes the refresh token. Implementations
   * should:
   *   1. Write status slot = `invalid_grant`.
   *   2. Fire a kernel `request_approval` card with surface `system`,
   *      action `reconnect_drive`. On user tap, run `switchroom drive
   *      connect <agent>` again.
   * The wrapper does not block on the approval — it just signals.
   */
  onInvalidGrant: (detail: string) => Promise<void>;
  /**
   * Called the first time we successfully mint an access token after a prior
   * invalid_grant. Used to flip the sidecar status slot back to `connected`.
   */
  onReconnected?: () => Promise<void>;
  /** Google OAuth client config (client_id / client_secret / scopes). */
  oauth: OAuthClientConfig;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  now?: () => number;
}

/**
 * Per-agent in-memory cache of the access token. One instance per running
 * agent process. NOT shared across processes (each process refreshes
 * independently — Google permits parallel refresh).
 */
export class DriveTokenCache {
  private cached: DriveAccessHandle | null = null;
  /** Tracks whether the previous refresh attempt failed with invalid_grant. */
  private inInvalidGrant = false;

  constructor(private readonly deps: WrapperDeps) {}

  /**
   * Return a valid access token, minting a new one if the cache is cold or
   * within `refreshWindowMs` of expiry. Throws when no refresh token is
   * available (caller should surface "drive disconnected") or when refresh
   * itself fails for a non-invalid_grant reason.
   *
   * On invalid_grant: drops cache, calls `onInvalidGrant`, and rethrows
   * InvalidGrantError so the caller can surface the disconnect. Subsequent
   * calls keep failing the same way until the user reconnects (writing a
   * fresh refresh token to the vault).
   */
  async getAccessToken(refreshWindowMs = 60_000): Promise<DriveAccessHandle> {
    const now = (this.deps.now ?? Date.now)();
    if (this.cached && this.cached.expires_at > now + refreshWindowMs) {
      return this.cached;
    }
    const refreshToken = await this.deps.loadRefreshToken();
    if (!refreshToken) {
      throw new Error(
        "Drive not connected for this agent (no refresh token in vault). " +
          "Run `switchroom drive connect <agent>`.",
      );
    }
    let resp: TokenResponse;
    try {
      resp = await refreshAccessToken(
        this.deps.oauth,
        refreshToken,
        this.deps.fetchImpl ?? fetch,
      );
    } catch (e) {
      if (e instanceof InvalidGrantError) {
        this.cached = null;
        this.inInvalidGrant = true;
        await this.deps.onInvalidGrant(e.detail);
        throw e;
      }
      throw e;
    }
    // Successful refresh — clear the invalid_grant flag if we were in it.
    const handle: DriveAccessHandle = {
      access_token: resp.access_token,
      expires_at: now + (resp.expires_in - 30) * 1000,
    };
    this.cached = handle;
    if (this.inInvalidGrant) {
      this.inInvalidGrant = false;
      if (this.deps.onReconnected) {
        await this.deps.onReconnected();
      }
    }
    return handle;
  }

  /** Drop the cached access token. Used by tests + after explicit revoke. */
  reset(): void {
    this.cached = null;
    this.inInvalidGrant = false;
  }
}
