/**
 * Drive MCP wrapper — auth-broker credentials path (RFC G Phase 3b.4b).
 *
 * Sibling to `wrapper.ts`. Where `wrapper.ts` does its own refresh
 * exchange (calls Google's `/token` endpoint with a refresh token from
 * the vault), this module fetches already-refreshed credentials from
 * the auth-broker over UDS — the broker owns the refresh loop, the
 * wrapper just consumes.
 *
 * **Phase split:**
 *   - 3b.4 (#1272): broker-side `get-credentials({provider: "google"})`
 *     dispatch + ACL gate. Lands in the broker.
 *   - 3b.4b (this file): client-side helper. Wrapper's broker-mode
 *     consumer.
 *   - 3b.4c (future): wire `loadFromAuthBroker` into the agent's MCP-
 *     spawn args. Today the gateway hands the wrapper a
 *     `loadRefreshToken` callback (vault path); 3b.4c will branch on
 *     `google_workspace.account` config presence to use the broker
 *     path instead.
 *
 * **Why a sibling module rather than extending wrapper.ts:**
 *   - `wrapper.ts` is RFC D legacy-shape (one OAuth client config per
 *     wrapper instance, refresh-on-demand). The broker path is
 *     fundamentally different (no client config needed in the agent;
 *     no refresh in the wrapper). Forcing both into one class would
 *     muddy the interface.
 *   - Phase 3b.4c picks which to use at agent-spawn time based on
 *     config — clean either/or, not a runtime mode flag.
 *
 * Today (Phase 3b.4b): broker doesn't yet refresh Google tokens
 * (that's Phase 3b.2d). So credentials returned by this helper may
 * be stale. The wrapper-broker path will correctly surface
 * `BrokerCredentialsExpired` when that happens — operators must
 * re-run `auth google account add` to get fresh tokens until the
 * tick lands.
 *
 * ── DEPRECATED for the MCP-spawn path ──────────────────────────────
 *
 * The "Phase 3b.4c: wire `loadFromAuthBroker` into the agent's
 * MCP-spawn args" plan referenced above is **superseded** and will
 * NOT be implemented. `loadFromAuthBroker` returns a ~1-hour Google
 * *access token*; an MCP server is long-lived and must self-refresh,
 * so handing it a 1h access token at spawn time means it dies an
 * hour later with no recovery. The chosen mechanism is instead the
 * **refresh-token seed launcher**: `src/cli/drive-mcp-launcher.ts`
 * pulls the *refresh token* from the broker, seeds upstream's
 * credentials file (`token:null, refresh_token, …, expiry:null`),
 * and execs `google-workspace-mcp --single-user` so upstream owns
 * the refresh loop itself. The `gdrive` MCP scaffold entry points at
 * that launcher (see `getGdriveMcpSettingsEntry`).
 *
 * This module is NOT dead — `loadFromAuthBroker` is still the right
 * tool for short-lived, single-request callers that need a bearer
 * token *now* and don't outlive it. Its only current caller is the
 * Drive-write pre-tool hook (`src/cli/drive-write-pretool.ts`), which
 * makes one Drive API call per invocation and exits — exactly the
 * access-token use case. Do NOT extend this for the MCP path; use
 * the launcher.
 */

import { withAuthBrokerClient } from "../auth/broker/client.js";

export interface DriveAccessHandle {
  /** Bearer token for `Authorization: Bearer <token>`. */
  access_token: string;
  /** Unix-ms when this access token expires. */
  expires_at: number;
}

/**
 * Distinguished error class for broker-credentials-expired. Wrapper
 * callers can branch on this to surface the right operator-actionable
 * message ("re-run `auth google account add`" until refresh-tick
 * lands; will become "broker should have refreshed by now —
 * investigate" post-3b.2d).
 */
export class BrokerCredentialsExpiredError extends Error {
  constructor(
    public readonly account: string,
    public readonly expiresAt: number,
    public readonly nowMs: number,
  ) {
    super(
      `Google credentials for account '${account}' expired at ${new Date(expiresAt).toISOString()} (now ${new Date(nowMs).toISOString()}). Re-run \`switchroom auth google account add ${account}\` to mint fresh tokens.`,
    );
    this.name = "BrokerCredentialsExpiredError";
  }
}

/**
 * Distinguished error class for "broker says agent has no access" —
 * thrown when the broker returns FORBIDDEN (agent not in
 * `google_accounts.<account>.enabled_for[]`) or ACCOUNT_NOT_FOUND
 * (agent has no `google_workspace.account` configured, or the
 * referenced account isn't stored in the broker).
 *
 * Specifically NOT thrown for other broker error codes like
 * INVALID_ARGS or INTERNAL — those rethrow as `BrokerCallFailedError`
 * so the gateway can distinguish "ACL says no" (operator runs
 * `auth google enable` or `account add`) from "broker bug" (page
 * the operator).
 */
export class BrokerAccessDeniedError extends Error {
  constructor(
    public readonly brokerCode: "FORBIDDEN" | "ACCOUNT_NOT_FOUND",
    public readonly brokerMessage: string,
  ) {
    super(`auth-broker denied get-credentials: ${brokerCode}: ${brokerMessage}`);
    this.name = "BrokerAccessDeniedError";
  }
}

/**
 * Catch-all for broker errors that aren't ACL-shaped. Wraps the
 * broker's error code + message so callers can branch (e.g. retry
 * vs surface).
 */
export class BrokerCallFailedError extends Error {
  constructor(
    public readonly brokerCode: string,
    public readonly brokerMessage: string,
  ) {
    super(`auth-broker get-credentials failed: ${brokerCode}: ${brokerMessage}`);
    this.name = "BrokerCallFailedError";
  }
}

export interface LoadFromAuthBrokerOptions {
  /**
   * Override the broker socket path. Defaults to the per-agent UDS
   * the auth-broker binds for the calling agent (resolved by the
   * client). Tests pass a tmp socket path.
   */
  socketPath?: string;
  /**
   * Refresh-window margin: if the broker's credentials would expire
   * within this many ms, treat them as expired and surface
   * BrokerCredentialsExpiredError. Default 60_000 (1 min).
   *
   * Phase 3b.2d will change the semantics — once the broker refreshes
   * proactively, a token within the window means "broker about to
   * refresh; retry once briefly." Today (no refresh tick) the window
   * is the operator's "you have N seconds before this fails" headline.
   */
  refreshWindowMs?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Pull Google access credentials from the auth-broker. Identity is
 * path-as-identity (the agent's per-agent socket bind); broker reads
 * the agent's `google_workspace.account` config to know which account
 * to return, and enforces `google_accounts.<account>.enabled_for[]`
 * before responding.
 *
 * Returns null when the broker socket isn't reachable (broker not
 * running) — caller decides whether to fall back to the legacy vault
 * path or surface "broker unreachable." Throws for other broker errors
 * via the distinguished classes above.
 */
export async function loadFromAuthBroker(
  options: LoadFromAuthBrokerOptions = {},
): Promise<DriveAccessHandle | null> {
  const now = (options.now ?? Date.now)();
  const refreshWindowMs = options.refreshWindowMs ?? 60_000;

  // Lazy-import the broker client classes so the wrapper module
  // doesn't drag the broker code into every consumer that doesn't use
  // the broker path.
  const { AuthBrokerError, AuthBrokerUnreachableError } = await import(
    "../auth/broker/client.js"
  );

  let result: { account: string; credentials: unknown; expiresAt?: number };
  try {
    result = await withAuthBrokerClient(
      async (client) => {
        return (await client.getCredentials("google")) as {
          account: string;
          credentials: unknown;
          expiresAt?: number;
        };
      },
      options.socketPath !== undefined ? { socket: options.socketPath } : undefined,
    );
  } catch (err) {
    if (err instanceof AuthBrokerUnreachableError) {
      // Broker not reachable — caller decides fallback policy.
      return null;
    }
    if (err instanceof AuthBrokerError) {
      // Only the ACL-shaped codes get the AccessDenied wrapper —
      // everything else (INVALID_ARGS, INTERNAL, etc.) routes through
      // BrokerCallFailedError so the gateway can distinguish "operator
      // misconfig" from "broker bug."
      if (err.code === "FORBIDDEN" || err.code === "ACCOUNT_NOT_FOUND") {
        throw new BrokerAccessDeniedError(err.code, err.message);
      }
      throw new BrokerCallFailedError(err.code, err.message);
    }
    throw err;
  }

  const creds = result.credentials as {
    googleOauth?: { accessToken?: string; expiresAt?: number };
  };
  const accessToken = creds.googleOauth?.accessToken;
  const expiresAt = result.expiresAt ?? creds.googleOauth?.expiresAt;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error(
      `auth-broker returned credentials for '${result.account}' without a Google accessToken — refusing to proceed`,
    );
  }
  if (typeof expiresAt !== "number") {
    throw new Error(
      `auth-broker returned credentials for '${result.account}' without an expiresAt — refusing to proceed`,
    );
  }
  if (expiresAt <= now + refreshWindowMs) {
    throw new BrokerCredentialsExpiredError(result.account, expiresAt, now);
  }
  return { access_token: accessToken, expires_at: expiresAt };
}
