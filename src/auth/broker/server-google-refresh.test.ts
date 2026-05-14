/**
 * auth-broker — RFC G Phase 3b.2d Google refresh-tick.
 *
 * Tests the broker's pre-emptive Google refresh path: walk every
 * stored Google account on each tick, refresh the ones near expiry
 * via GoogleProvider (talking to Google's `/token` endpoint), and
 * persist the new credentials back to disk.
 *
 * The Anthropic equivalent has been integration-tested in
 * `server.test.ts` for many releases; these tests target Google's
 * additional surface — separate provider, separate storage path,
 * no per-agent fanout.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthBroker } from "./server.js";
import {
  googleAccountCredentialsPath,
  writeGoogleAccountCredentials,
} from "./google-storage.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import type { GoogleCredentialsShape } from "./protocol.js";

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-google-refresh-test-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  const socketRoot = join(tmp, "run", "switchroom", "auth-broker");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const h: Harness = { tmp, home, agentsDir, stateDir, socketRoot };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses) {
    try {
      rmSync(h.tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  harnesses = [];
});

function makeConfig(h: Harness): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents: {},
    auth: {},
    google_workspace: {
      google_client_id: "client-id-test.apps.googleusercontent.com",
      google_client_secret: "test-secret",
    },
  } as unknown as SwitchroomConfig;
}

function seedGoogleAccount(
  h: Harness,
  account: string,
  opts: { expiresAt: number; refreshToken?: string; accessToken?: string },
): void {
  const creds: GoogleCredentialsShape = {
    googleOauth: {
      accessToken: opts.accessToken ?? `at-${account}`,
      refreshToken: opts.refreshToken ?? `rt-${account}`,
      expiresAt: opts.expiresAt,
      scope: "https://www.googleapis.com/auth/drive.readonly",
      clientId: "client-id-test.apps.googleusercontent.com",
      accountEmail: account,
      tokenType: "Bearer",
    },
  };
  writeGoogleAccountCredentials(h.stateDir, account, creds);
}

/**
 * Stub fetch returning a successful Google token-exchange response.
 * Records every URL hit so tests can assert exactly which accounts
 * the tick refreshed.
 */
function makeOkFetcher(opts: {
  newAccessToken?: string;
  rotatedRefreshToken?: string;
  expiresIn?: number;
}): { fetcher: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    const body: Record<string, unknown> = {
      access_token: opts.newAccessToken ?? "at-new",
      expires_in: opts.expiresIn ?? 3600,
      token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/drive.readonly",
    };
    if (opts.rotatedRefreshToken) {
      body.refresh_token = opts.rotatedRefreshToken;
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Awaited<ReturnType<typeof fetch>>;
    void init;
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

/** Stub fetch returning Google's `invalid_grant` error. */
function makeInvalidGrantFetcher(): typeof fetch {
  return (async () => {
    return new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    ) as unknown as Awaited<ReturnType<typeof fetch>>;
  }) as unknown as typeof fetch;
}

describe("AuthBroker — RFC G Phase 3b.2d Google refresh-tick", () => {
  it("refreshes a Google account whose token is within REFRESH_THRESHOLD_MS of expiry", async () => {
    const h = makeHarness();
    const config = makeConfig(h);
    // Expires in 30 minutes — well inside the 60-minute threshold.
    const aboutToExpire = Date.now() + 30 * 60 * 1000;
    seedGoogleAccount(h, "alice@example.com", {
      expiresAt: aboutToExpire,
      refreshToken: "rt-alice",
    });

    const { fetcher, calls } = makeOkFetcher({
      newAccessToken: "at-alice-fresh",
      expiresIn: 3600,
    });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      fetcher,
    });
    await broker.start();
    await broker._tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("oauth2.googleapis.com/token");

    const onDisk = JSON.parse(
      readFileSync(googleAccountCredentialsPath(h.stateDir, "alice@example.com"), "utf-8"),
    ) as GoogleCredentialsShape;
    expect(onDisk.googleOauth.accessToken).toBe("at-alice-fresh");
    // expiresAt should now be ~1h in the future, well past the original.
    expect(onDisk.googleOauth.expiresAt).toBeGreaterThan(aboutToExpire);
    // Refresh token preserved when Google didn't rotate it.
    expect(onDisk.googleOauth.refreshToken).toBe("rt-alice");

    broker.stop();
  });

  it("does NOT refresh when the token is comfortably within validity (>1h remaining)", async () => {
    const h = makeHarness();
    const config = makeConfig(h);
    const farFuture = Date.now() + 24 * 60 * 60 * 1000;
    seedGoogleAccount(h, "bob@example.com", { expiresAt: farFuture });

    const { fetcher, calls } = makeOkFetcher({});
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      fetcher,
    });
    await broker.start();
    await broker._tick();

    expect(calls).toHaveLength(0);
    const onDisk = JSON.parse(
      readFileSync(googleAccountCredentialsPath(h.stateDir, "bob@example.com"), "utf-8"),
    ) as GoogleCredentialsShape;
    // Untouched.
    expect(onDisk.googleOauth.accessToken).toBe("at-bob@example.com");
    expect(onDisk.googleOauth.expiresAt).toBe(farFuture);

    broker.stop();
  });

  it("preserves the old refresh token when Google rotates and includes it", async () => {
    const h = makeHarness();
    const config = makeConfig(h);
    seedGoogleAccount(h, "carol@example.com", {
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 min — definitely refresh
      refreshToken: "rt-carol-original",
    });

    const { fetcher } = makeOkFetcher({
      rotatedRefreshToken: "rt-carol-rotated",
    });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      fetcher,
    });
    await broker.start();
    await broker._tick();

    const onDisk = JSON.parse(
      readFileSync(googleAccountCredentialsPath(h.stateDir, "carol@example.com"), "utf-8"),
    ) as GoogleCredentialsShape;
    expect(onDisk.googleOauth.refreshToken).toBe("rt-carol-rotated");

    broker.stop();
  });

  it("does NOT touch on-disk credentials when Google returns invalid_grant", async () => {
    const h = makeHarness();
    const config = makeConfig(h);
    const originalExpiresAt = Date.now() + 5 * 60 * 1000;
    seedGoogleAccount(h, "dave@example.com", {
      expiresAt: originalExpiresAt,
      accessToken: "at-dave-original",
      refreshToken: "rt-dave-revoked",
    });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      fetcher: makeInvalidGrantFetcher(),
    });
    await broker.start();
    // Should not throw — the failure is logged and the tick proceeds.
    await broker._tick();

    const onDisk = JSON.parse(
      readFileSync(googleAccountCredentialsPath(h.stateDir, "dave@example.com"), "utf-8"),
    ) as GoogleCredentialsShape;
    // Untouched — the stale-but-still-valid creds give the operator
    // time to re-OAuth.
    expect(onDisk.googleOauth.accessToken).toBe("at-dave-original");
    expect(onDisk.googleOauth.refreshToken).toBe("rt-dave-revoked");
    expect(onDisk.googleOauth.expiresAt).toBe(originalExpiresAt);

    broker.stop();
  });

  it("walks every stored Google account on each tick", async () => {
    const h = makeHarness();
    const config = makeConfig(h);
    const near = Date.now() + 5 * 60 * 1000;
    seedGoogleAccount(h, "alice@example.com", { expiresAt: near });
    seedGoogleAccount(h, "bob@example.com", { expiresAt: near });
    seedGoogleAccount(h, "carol@example.com", { expiresAt: near });

    const { fetcher, calls } = makeOkFetcher({});
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      fetcher,
    });
    await broker.start();
    await broker._tick();

    expect(calls).toHaveLength(3);
    broker.stop();
  });

  it("is a no-op when google_workspace config is absent (no provider registered)", async () => {
    const h = makeHarness();
    // Config WITHOUT google_workspace block.
    const config = {
      switchroom: { version: 1, agents_dir: h.agentsDir },
      telegram: {},
      agents: {},
      auth: {},
    } as unknown as SwitchroomConfig;

    // Even seeding a Google account on disk shouldn't trigger anything.
    seedGoogleAccount(h, "alice@example.com", {
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    const { fetcher, calls } = makeOkFetcher({});
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      fetcher,
    });
    await broker.start();
    await broker._tick();

    // No refresh attempted — provider isn't registered.
    expect(calls).toHaveLength(0);
    broker.stop();
  });
});
