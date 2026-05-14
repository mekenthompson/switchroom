/**
 * Tests for wrapper-broker — RFC G Phase 3b.4b.
 *
 * End-to-end against a real AuthBroker instance bound to a tmpdir.
 * Confirms the wrapper-side helper correctly:
 *   - Calls broker via per-agent UDS bind
 *   - Returns access token + expiry on happy path
 *   - Surfaces BrokerCredentialsExpiredError when expiry < now+window
 *   - Surfaces BrokerAccessDeniedError when broker returns FORBIDDEN/ACCOUNT_NOT_FOUND
 *   - Returns null when broker socket isn't reachable (caller decides fallback)
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthBroker } from "../auth/broker/server.js";
import {
  BrokerAccessDeniedError,
  BrokerCredentialsExpiredError,
  loadFromAuthBroker,
} from "./wrapper-broker.js";
import type { SwitchroomConfig } from "../config/schema.js";

let tmp: string;
let home: string;
let stateDir: string;
let socketRoot: string;
let agentsDir: string;
let broker: AuthBroker | null = null;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wrapper-broker-test-"));
  home = join(tmp, "home");
  stateDir = join(tmp, "state");
  socketRoot = join(tmp, "run", "switchroom", "auth-broker");
  agentsDir = join(tmp, "agents");
  mkdirSync(home, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(socketRoot, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
});

afterEach(() => {
  if (broker) {
    broker.stop();
    broker = null;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function makeConfig(): SwitchroomConfig {
  return ({
    switchroom: { version: 1, agents_dir: agentsDir },
    telegram: {},
    agents: {
      klanker: {
        google_workspace: { account: "alice@example.com" },
      },
      clerk: {},
    },
    auth: {
      active: "default",
      admin_agents: ["clerk"],
    },
    google_workspace: {
      google_client_id: "test-client-id",
      google_client_secret: "test-secret",
    },
    google_accounts: {
      "alice@example.com": { enabled_for: ["klanker"] },
    },
  } as unknown) as SwitchroomConfig;
}

function seedAnthropicAccount(label: string): void {
  const dir = join(home, ".switchroom", "accounts", label);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `at-${label}`,
        refreshToken: `rt-${label}`,
        expiresAt: Date.now() + 3600_000,
      },
    }),
  );
}

async function startBroker(): Promise<AuthBroker> {
  const cfg = makeConfig();
  seedAnthropicAccount("default");
  mkdirSync(join(agentsDir, "klanker"), { recursive: true });
  mkdirSync(join(agentsDir, "clerk"), { recursive: true });
  broker = new AuthBroker(cfg, {
    home,
    stateDir,
    socketRoot,
    disableRefreshLoop: true,
  });
  await broker.start();
  return broker;
}

async function addGoogleCredentials(
  account: string,
  expiresAt: number,
): Promise<void> {
  // Hand-write the credentials.json under the broker's stateDir,
  // matching what `opGoogleAddAccount` would do. Faster than going
  // through the admin RPC for every test.
  const dir = join(stateDir, "google", account);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({
      googleOauth: {
        accessToken: `at-${account}`,
        refreshToken: `rt-${account}`,
        expiresAt,
        scope: "drive",
        clientId: "cid",
        accountEmail: account,
        tokenType: "Bearer",
      },
    }),
    { mode: 0o600 },
  );
}

describe("loadFromAuthBroker — happy path", () => {
  it("returns access token + expiry when agent IS in enabled_for[]", async () => {
    await startBroker();
    const expiresAt = Date.now() + 3600_000;
    await addGoogleCredentials("alice@example.com", expiresAt);
    const handle = await loadFromAuthBroker({
      socketPath: join(socketRoot, "klanker", "sock"),
    });
    expect(handle).not.toBeNull();
    expect(handle?.access_token).toBe("at-alice@example.com");
    expect(handle?.expires_at).toBe(expiresAt);
  });
});

describe("loadFromAuthBroker — error paths", () => {
  it("returns null when broker socket isn't reachable (caller decides fallback)", async () => {
    // No broker started — socket doesn't exist.
    const handle = await loadFromAuthBroker({
      socketPath: join(socketRoot, "klanker", "sock"),
    });
    expect(handle).toBeNull();
  });

  it("throws BrokerAccessDeniedError when agent NOT in enabled_for[]", async () => {
    await startBroker();
    // Override the config to remove klanker from enabled_for.
    // The broker's opGoogleGetCredentials reads from this.config which
    // is set at construction; since we already started, mutate the
    // backing config and re-run. Simpler: use a fresh broker with
    // klanker absent from enabled_for.
    broker?.stop();
    const cfg = makeConfig();
    (cfg as { google_accounts?: Record<string, { enabled_for?: string[] }> })
      .google_accounts!["alice@example.com"]!.enabled_for = ["gymbro"];
    broker = new AuthBroker(cfg, {
      home,
      stateDir,
      socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    await addGoogleCredentials("alice@example.com", Date.now() + 3600_000);
    await expect(
      loadFromAuthBroker({ socketPath: join(socketRoot, "klanker", "sock") }),
    ).rejects.toThrow(BrokerAccessDeniedError);
  });

  it("throws BrokerCredentialsExpiredError when stored credentials expired", async () => {
    await startBroker();
    // Expiry 1ms in the past — broker returns the credentials, helper
    // detects expiry against the refresh window.
    const longExpired = Date.now() - 1000;
    await addGoogleCredentials("alice@example.com", longExpired);
    await expect(
      loadFromAuthBroker({ socketPath: join(socketRoot, "klanker", "sock") }),
    ).rejects.toThrow(BrokerCredentialsExpiredError);
  });

  it("BrokerCredentialsExpiredError carries the account + timestamps for diagnostics", async () => {
    await startBroker();
    const oldExpiry = Date.now() - 1000;
    await addGoogleCredentials("alice@example.com", oldExpiry);
    try {
      await loadFromAuthBroker({
        socketPath: join(socketRoot, "klanker", "sock"),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BrokerCredentialsExpiredError);
      const e = err as BrokerCredentialsExpiredError;
      expect(e.account).toBe("alice@example.com");
      expect(e.expiresAt).toBe(oldExpiry);
      expect(e.message).toContain("auth google account add alice@example.com");
    }
  });

  it("throws BrokerAccessDeniedError with broker code when agent has no google_workspace.account", async () => {
    const cfg = makeConfig();
    // Remove klanker's google_workspace entirely.
    (cfg.agents.klanker as { google_workspace?: unknown }).google_workspace =
      undefined;
    seedAnthropicAccount("default");
    mkdirSync(join(agentsDir, "klanker"), { recursive: true });
    mkdirSync(join(agentsDir, "clerk"), { recursive: true });
    broker = new AuthBroker(cfg, {
      home,
      stateDir,
      socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    try {
      await loadFromAuthBroker({
        socketPath: join(socketRoot, "klanker", "sock"),
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BrokerAccessDeniedError);
      expect((err as BrokerAccessDeniedError).brokerCode).toBe("ACCOUNT_NOT_FOUND");
    }
  });

  it("respects refreshWindowMs — credentials expiring within window treated as expired", async () => {
    await startBroker();
    // Credentials expire in 30s; default refresh window is 60s.
    const soonExpiry = Date.now() + 30_000;
    await addGoogleCredentials("alice@example.com", soonExpiry);
    await expect(
      loadFromAuthBroker({ socketPath: join(socketRoot, "klanker", "sock") }),
    ).rejects.toThrow(BrokerCredentialsExpiredError);
    // With a SMALLER window, the same credentials are treated as fresh.
    const handle = await loadFromAuthBroker({
      socketPath: join(socketRoot, "klanker", "sock"),
      refreshWindowMs: 10_000,
    });
    expect(handle?.expires_at).toBe(soonExpiry);
  });
});
