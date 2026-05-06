/**
 * DriveTokenCache — refresh + invalid_grant rotation tests.
 */

import { describe, expect, it, mock } from "bun:test";
import { DriveTokenCache } from "./wrapper.js";
import { InvalidGrantError } from "./oauth.js";

const oauth = {
  client_id: "cid",
  client_secret: "csec",
  scopes: ["x"],
};

function tokenResp(opts: { status?: number; body?: unknown } = {}): Response {
  return new Response(
    JSON.stringify(
      opts.body ?? { access_token: "at", expires_in: 3600, token_type: "Bearer" },
    ),
    { status: opts.status ?? 200 },
  );
}

describe("DriveTokenCache", () => {
  it("mints a fresh access token on first call", async () => {
    const cache = new DriveTokenCache({
      oauth,
      loadRefreshToken: async () => "rt",
      onInvalidGrant: async () => {
        throw new Error("should not be called");
      },
      fetchImpl: mock(async () => tokenResp()) as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    const handle = await cache.getAccessToken();
    expect(handle.access_token).toBe("at");
    // 30s safety margin baked in
    expect(handle.expires_at).toBe(1_000_000 + (3600 - 30) * 1000);
  });

  it("returns the cached token on a subsequent call within window", async () => {
    let calls = 0;
    const cache = new DriveTokenCache({
      oauth,
      loadRefreshToken: async () => "rt",
      onInvalidGrant: async () => undefined,
      fetchImpl: mock(async () => {
        calls++;
        return tokenResp();
      }) as unknown as typeof fetch,
      now: () => 1_000_000,
    });
    await cache.getAccessToken();
    await cache.getAccessToken();
    expect(calls).toBe(1);
  });

  it("throws when no refresh token in vault", async () => {
    const cache = new DriveTokenCache({
      oauth,
      loadRefreshToken: async () => null,
      onInvalidGrant: async () => undefined,
    });
    await expect(cache.getAccessToken()).rejects.toThrow(/not connected/);
  });

  it("calls onInvalidGrant + rethrows when Google rotates the refresh token", async () => {
    const onInvalidGrant = mock(async (_d: string) => undefined);
    const cache = new DriveTokenCache({
      oauth,
      loadRefreshToken: async () => "rt",
      onInvalidGrant,
      fetchImpl: mock(async () =>
        tokenResp({
          status: 400,
          body: {
            error: "invalid_grant",
            error_description: "Token revoked.",
          },
        }),
      ) as unknown as typeof fetch,
    });
    await expect(cache.getAccessToken()).rejects.toBeInstanceOf(InvalidGrantError);
    expect(onInvalidGrant).toHaveBeenCalledTimes(1);
  });

  it("calls onReconnected when a fresh token is minted after a prior invalid_grant", async () => {
    const onReconnected = mock(async () => undefined);
    let attempt = 0;
    const cache = new DriveTokenCache({
      oauth,
      loadRefreshToken: async () => "rt",
      onInvalidGrant: async () => undefined,
      onReconnected,
      fetchImpl: mock(async () => {
        attempt++;
        if (attempt === 1) {
          return tokenResp({ status: 400, body: { error: "invalid_grant" } });
        }
        return tokenResp();
      }) as unknown as typeof fetch,
    });
    await expect(cache.getAccessToken()).rejects.toBeInstanceOf(InvalidGrantError);
    // User reconnected; vault now has a fresh token (loadRefreshToken returns "rt" still — fine for the test).
    await cache.getAccessToken();
    expect(onReconnected).toHaveBeenCalledTimes(1);
  });
});
