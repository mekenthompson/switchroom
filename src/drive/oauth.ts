/**
 * Google Drive OAuth flow — three-tier auto-selection (RFC C §3).
 *
 * Tier preference (in order):
 *   1. RFC 8628 device-code (preferred — works over SSH, no port binding).
 *   2. OOB-paste (fallback — Google may reject device-code for Drive scopes).
 *   3. Desktop loopback (last resort — only when a local browser is reachable).
 *
 * Auto-detect headlessness from env: if `$DISPLAY` and `$WAYLAND_DISPLAY` are
 * both empty AND we are inside an SSH session (`$SSH_CONNECTION` present),
 * the host is headless and we MUST avoid the loopback path.
 *
 * Pure functions where possible. Network I/O lives in the `*Exchange` helpers
 * so unit tests can drive the selector and the polling logic without hitting
 * Google.
 */

export type OAuthTier = "device_code" | "oob_paste" | "desktop_loopback";

export interface OAuthEnv {
  DISPLAY?: string;
  WAYLAND_DISPLAY?: string;
  SSH_CONNECTION?: string;
  SSH_TTY?: string;
  /** Test override: force a tier regardless of env. */
  SWITCHROOM_DRIVE_OAUTH_TIER?: string;
}

/**
 * Decide whether the host is headless. A host is "headless" when there is no
 * graphical display server AND we are inside an SSH login.
 */
export function detectHeadless(env: OAuthEnv): boolean {
  const hasDisplay = Boolean(
    (env.DISPLAY && env.DISPLAY.trim() !== "") ||
    (env.WAYLAND_DISPLAY && env.WAYLAND_DISPLAY.trim() !== ""),
  );
  const inSsh = Boolean(
    (env.SSH_CONNECTION && env.SSH_CONNECTION.trim() !== "") ||
    (env.SSH_TTY && env.SSH_TTY.trim() !== ""),
  );
  // "Local desktop" = DISPLAY/WAYLAND set AND not over SSH (X-forwarding
  // can set DISPLAY remotely, in which case we still can't reliably pop a
  // browser on the user's screen). Anything else is headless.
  if (hasDisplay && !inSsh) return false;
  return true;
}

/**
 * Pick the preferred OAuth tier given the host environment.
 *
 * The selector is conservative: it returns the tier we'll TRY FIRST.
 * Runtime fall-through (device-code rejected by Google for the configured
 * scopes → OOB-paste) is the caller's responsibility.
 */
export function selectInitialTier(env: OAuthEnv): OAuthTier {
  const override = env.SWITCHROOM_DRIVE_OAUTH_TIER;
  if (override === "device_code" || override === "oob_paste" || override === "desktop_loopback") {
    return override;
  }

  if (detectHeadless(env)) {
    // Headless: device-code first, OOB on rejection.
    return "device_code";
  }

  // Has a display: device-code is still simpler (no port binding) so
  // prefer it; loopback is the last resort.
  return "device_code";
}

/**
 * Compute the fall-through tier given the current tier failed.
 * Returns null when there are no more tiers to try.
 */
export function nextTier(current: OAuthTier, env: OAuthEnv): OAuthTier | null {
  if (current === "device_code") {
    // Device-code failed (e.g. Google rejected it for Drive scopes) →
    // OOB-paste works universally over SSH.
    return "oob_paste";
  }
  if (current === "oob_paste") {
    // OOB-paste failed → only loopback remains, and only if we have a
    // browser. On a truly headless host, return null.
    if (detectHeadless(env)) return null;
    return "desktop_loopback";
  }
  return null;
}

// ─── Network shapes (Google's RFC 8628 + token endpoint) ─────────────────────

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface OAuthClientConfig {
  client_id: string;
  client_secret: string;
  scopes: string[];
}

/**
 * RFC 8628 §3.1: device-authorization request.
 * Hits https://oauth2.googleapis.com/device/code with form-urlencoded body.
 * Throws OAuthTierRejected when Google refuses the scope set.
 */
export async function requestDeviceCode(
  cfg: OAuthClientConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: cfg.client_id,
    scope: cfg.scopes.join(" "),
  });
  const res = await fetchImpl("https://oauth2.googleapis.com/device/code", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    // Google returns 403 / 400 with `invalid_scope` or `disabled_client` when
    // device-code is not whitelisted for the requested scopes.
    if (res.status === 400 || res.status === 403) {
      throw new OAuthTierRejected(
        `device_code rejected (${res.status}): ${text}`,
      );
    }
    throw new Error(`device_code request failed (${res.status}): ${text}`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

/**
 * Poll the token endpoint until the user completes consent or we time out.
 * Implements RFC 8628 §3.5 polling semantics: respect `interval`, back off on
 * `slow_down`, terminate on `access_denied` / `expired_token`.
 */
export async function pollDeviceToken(
  cfg: OAuthClientConfig,
  device: DeviceCodeResponse,
  opts: {
    fetchImpl?: typeof fetch;
    sleepMs?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<TokenResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepMs = opts.sleepMs ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  let interval = device.interval > 0 ? device.interval : 5;
  const deadline = now() + device.expires_in * 1000;

  while (now() < deadline) {
    await sleepMs(interval * 1000);
    const body = new URLSearchParams({
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const res = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (res.ok && typeof json.access_token === "string") {
      return json as unknown as TokenResponse;
    }
    const err = json.error;
    if (err === "authorization_pending") continue;
    if (err === "slow_down") {
      interval += 5;
      continue;
    }
    if (err === "access_denied") {
      throw new Error("User denied the consent request.");
    }
    if (err === "expired_token") {
      throw new Error("Device code expired before consent.");
    }
    throw new Error(`Token poll failed: ${JSON.stringify(json)}`);
  }
  throw new Error("Device-code consent timed out.");
}

/**
 * Build the OOB consent URL the user opens in any browser; they paste back the
 * code Google shows them. Universal fallback when device-code is rejected.
 */
export function buildOobAuthUrl(cfg: OAuthClientConfig): string {
  const u = new URL("https://accounts.google.com/o/oauth2/auth");
  u.searchParams.set("client_id", cfg.client_id);
  u.searchParams.set("redirect_uri", "urn:ietf:wg:oauth:2.0:oob");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", cfg.scopes.join(" "));
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  return u.toString();
}

/** Exchange a pasted OOB auth code for tokens. */
export async function exchangeOobCode(
  cfg: OAuthClientConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    code,
    grant_type: "authorization_code",
    redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
  });
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OOB token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

/**
 * Refresh an access token using the durable refresh token.
 * Throws InvalidGrantError when Google has rotated/revoked the refresh token
 * — caller (drive wrapper) catches and updates the sidecar status slot.
 */
export class InvalidGrantError extends Error {
  constructor(public detail: string) {
    super(`invalid_grant: ${detail}`);
    this.name = "InvalidGrantError";
  }
}

export class OAuthTierRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthTierRejected";
  }
}

export async function refreshAccessToken(
  cfg: OAuthClientConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    if (typeof json.error === "string" && json.error === "invalid_grant") {
      throw new InvalidGrantError(
        typeof json.error_description === "string"
          ? json.error_description
          : "refresh token rejected by Google",
      );
    }
    throw new Error(`refresh failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json as unknown as TokenResponse;
}

/**
 * Best-effort revoke. Google's revoke endpoint returns 200 on success and
 * 400 ({error: invalid_token}) when the token is already invalid. We treat
 * both as "the local view is now consistent with Google's view."
 */
export async function revokeRefreshToken(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
  try {
    const res = await fetchImpl("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
    if (res.ok) return { ok: true };
    if (res.status === 400) {
      // already invalidated — treat as success for our purposes
      return { ok: true };
    }
    const text = await res.text();
    return { ok: false, status: res.status, detail: text };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}
