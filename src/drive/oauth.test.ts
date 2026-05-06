/**
 * Tests for OAuth tier auto-selection + refresh-token rotation handling.
 */

import { describe, expect, it, mock } from "bun:test";
import {
  detectHeadless,
  selectInitialTier,
  nextTier,
  refreshAccessToken,
  InvalidGrantError,
  pollDeviceToken,
  buildOobAuthUrl,
  exchangeOobCode,
  revokeRefreshToken,
} from "./oauth.js";

const cfg = {
  client_id: "cid",
  client_secret: "csecret",
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
};

describe("detectHeadless", () => {
  it("treats SSH session with no display as headless", () => {
    expect(
      detectHeadless({ SSH_CONNECTION: "1.2.3.4 22 5.6.7.8 22" }),
    ).toBe(true);
  });

  it("treats laptop with $DISPLAY set as not headless", () => {
    expect(detectHeadless({ DISPLAY: ":0" })).toBe(false);
  });

  it("treats Wayland display as not headless", () => {
    expect(detectHeadless({ WAYLAND_DISPLAY: "wayland-0" })).toBe(false);
  });

  it("ignores empty DISPLAY/WAYLAND_DISPLAY strings (real-world env shape)", () => {
    expect(
      detectHeadless({ DISPLAY: "", WAYLAND_DISPLAY: "", SSH_TTY: "/dev/pts/0" }),
    ).toBe(true);
  });

  it("non-SSH headless box still treated as headless (no display means no browser)", () => {
    expect(detectHeadless({})).toBe(true);
  });
});

describe("selectInitialTier", () => {
  it("picks device_code on headless SSH boxes", () => {
    expect(
      selectInitialTier({ SSH_CONNECTION: "x" }),
    ).toBe("device_code");
  });

  it("picks device_code on laptops with display (still simpler than loopback)", () => {
    expect(selectInitialTier({ DISPLAY: ":0" })).toBe("device_code");
  });

  it("honours SWITCHROOM_DRIVE_OAUTH_TIER override", () => {
    expect(
      selectInitialTier({
        DISPLAY: ":0",
        SWITCHROOM_DRIVE_OAUTH_TIER: "desktop_loopback",
      }),
    ).toBe("desktop_loopback");
  });
});

describe("nextTier", () => {
  it("falls device_code → oob_paste", () => {
    expect(nextTier("device_code", { SSH_CONNECTION: "x" })).toBe("oob_paste");
  });

  it("falls oob_paste → desktop_loopback when display present", () => {
    expect(nextTier("oob_paste", { DISPLAY: ":0" })).toBe("desktop_loopback");
  });

  it("falls oob_paste → null on truly headless boxes", () => {
    expect(nextTier("oob_paste", { SSH_CONNECTION: "x" })).toBe(null);
  });

  it("returns null after desktop_loopback (last tier)", () => {
    expect(nextTier("desktop_loopback", { DISPLAY: ":0" })).toBe(null);
  });
});

describe("refreshAccessToken — invalid_grant rotation", () => {
  it("throws InvalidGrantError when Google rejects the refresh token", async () => {
    const fakeFetch = mock(async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    await expect(refreshAccessToken(cfg, "rt", fakeFetch)).rejects.toBeInstanceOf(
      InvalidGrantError,
    );
  });

  it("returns the new access token on success", async () => {
    const fakeFetch = mock(async () =>
      new Response(
        JSON.stringify({
          access_token: "at-new",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;
    const r = await refreshAccessToken(cfg, "rt", fakeFetch);
    expect(r.access_token).toBe("at-new");
    expect(r.expires_in).toBe(3600);
  });

  it("rethrows non-invalid_grant errors as plain Error", async () => {
    const fakeFetch = mock(async () =>
      new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
    await expect(refreshAccessToken(cfg, "rt", fakeFetch)).rejects.toThrow(
      /refresh failed/,
    );
  });
});

describe("pollDeviceToken", () => {
  it("returns access_token on first non-pending poll", async () => {
    let calls = 0;
    const fakeFetch = mock(async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
        });
      }
      return new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const tok = await pollDeviceToken(
      cfg,
      { device_code: "dc", user_code: "uc", verification_url: "v", expires_in: 600, interval: 1 },
      { fetchImpl: fakeFetch, sleepMs: async () => undefined },
    );
    expect(tok.access_token).toBe("at");
    expect(tok.refresh_token).toBe("rt");
  });

  it("backs off on slow_down then succeeds", async () => {
    let calls = 0;
    const fakeFetch = mock(async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "slow_down" }), { status: 400 });
      }
      return new Response(
        JSON.stringify({ access_token: "at", expires_in: 3600, token_type: "Bearer" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const tok = await pollDeviceToken(
      cfg,
      { device_code: "dc", user_code: "uc", verification_url: "v", expires_in: 600, interval: 1 },
      { fetchImpl: fakeFetch, sleepMs: async () => undefined },
    );
    expect(tok.access_token).toBe("at");
  });

  it("throws on access_denied", async () => {
    const fakeFetch = mock(
      async () => new Response(JSON.stringify({ error: "access_denied" }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(
      pollDeviceToken(
        cfg,
        { device_code: "dc", user_code: "uc", verification_url: "v", expires_in: 600, interval: 1 },
        { fetchImpl: fakeFetch, sleepMs: async () => undefined },
      ),
    ).rejects.toThrow(/denied/);
  });
});

describe("OOB-paste flow", () => {
  it("buildOobAuthUrl includes redirect_uri=urn:ietf:wg:oauth:2.0:oob", () => {
    const url = buildOobAuthUrl(cfg);
    expect(url).toContain("redirect_uri=urn%3Aietf%3Awg%3Aoauth%3A2.0%3Aoob");
    expect(url).toContain("client_id=cid");
    expect(url).toContain("access_type=offline");
  });

  it("exchangeOobCode round-trips via the token endpoint", async () => {
    const fakeFetch = mock(async () =>
      new Response(
        JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const tok = await exchangeOobCode(cfg, "pasted-code", fakeFetch);
    expect(tok.refresh_token).toBe("rt");
  });
});

describe("revokeRefreshToken", () => {
  it("returns ok on Google 200", async () => {
    const fakeFetch = mock(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    expect(await revokeRefreshToken("rt", fakeFetch)).toEqual({ ok: true });
  });

  it("returns ok on Google 400 (already invalidated counts as consistent)", async () => {
    const fakeFetch = mock(
      async () => new Response(JSON.stringify({ error: "invalid_token" }), { status: 400 }),
    ) as unknown as typeof fetch;
    expect(await revokeRefreshToken("rt", fakeFetch)).toEqual({ ok: true });
  });

  it("returns failed on unexpected non-2xx", async () => {
    const fakeFetch = mock(
      async () => new Response("oops", { status: 503 }),
    ) as unknown as typeof fetch;
    const r = await revokeRefreshToken("rt", fakeFetch);
    expect(r.ok).toBe(false);
  });

  it("returns failed when fetch itself throws (network down)", async () => {
    const fakeFetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await revokeRefreshToken("rt", fakeFetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain("ECONNREFUSED");
  });
});
