/**
 * auth-broker — `list-google-accounts` op (RFC G follow-up).
 *
 * Tests the broker-side inventory of stored Google accounts. Returns
 * metadata only (account, expiresAt, scope, clientId) — refresh + access
 * tokens stay on disk.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import { writeGoogleAccountCredentials } from "./google-storage.js";
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
  const tmp = mkdtempSync(
    join(tmpdir(), "auth-broker-list-google-test-"),
  );
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

function makeConfig(h: Harness, agents: Record<string, object> = {}): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents,
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
  opts: { expiresAt: number; scope?: string; clientId?: string } = { expiresAt: Date.now() + 3600_000 },
): void {
  const creds: GoogleCredentialsShape = {
    googleOauth: {
      accessToken: `at-${account}`,
      refreshToken: `rt-${account}`,
      expiresAt: opts.expiresAt,
      scope: opts.scope ?? "https://www.googleapis.com/auth/drive.readonly",
      clientId: opts.clientId ?? "client-id-test.apps.googleusercontent.com",
      accountEmail: account,
      tokenType: "Bearer",
    },
  };
  writeGoogleAccountCredentials(h.stateDir, account, creds);
}

/** Open UDS, send one request, read one response, close. */
async function rpc(socketPath: string, req: object): Promise<unknown> {
  return await new Promise<unknown>((resolveP, rejectP) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    let settled = false;
    const settle = (v: unknown, err?: Error): void => {
      if (settled) return;
      settled = true;
      try {
        c.destroy();
      } catch {
        /* ignore */
      }
      if (err) rejectP(err);
      else resolveP(v);
    };
    c.on("connect", () => {
      c.write(encodeRequest(req as Parameters<typeof encodeRequest>[0]));
    });
    c.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        const line = buf.slice(0, nl);
        try {
          settle(decodeResponse(line));
        } catch (err) {
          settle(null, err as Error);
        }
      }
    });
    c.on("error", (err) => settle(null, err));
    setTimeout(() => settle(null, new Error("rpc timeout")), 3000);
  });
}

describe("AuthBroker — list-google-accounts op", () => {
  it("returns every stored Google account, sorted by email, without tokens", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { ziggy: {} });
    seedGoogleAccount(h, "carol@example.com", {
      expiresAt: 3000,
      scope: "https://www.googleapis.com/auth/drive.readonly",
    });
    seedGoogleAccount(h, "alice@example.com", {
      expiresAt: 1000,
      scope: "https://www.googleapis.com/auth/calendar",
    });
    seedGoogleAccount(h, "bob@example.com", { expiresAt: 2000 });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "test-1",
      op: "list-google-accounts",
    })) as { ok: true; data: { accounts: Array<Record<string, unknown>> } };

    expect(resp.ok).toBe(true);
    const emails = resp.data.accounts.map((a) => a.account);
    expect(emails).toEqual([
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
    ]);
    expect(resp.data.accounts[0].expiresAt).toBe(1000);
    expect(resp.data.accounts[0].scope).toBe(
      "https://www.googleapis.com/auth/calendar",
    );
    expect(resp.data.accounts[0].clientId).toBe(
      "client-id-test.apps.googleusercontent.com",
    );
    // Refresh + access tokens are explicitly NOT in the response.
    for (const a of resp.data.accounts) {
      expect(a).not.toHaveProperty("refreshToken");
      expect(a).not.toHaveProperty("accessToken");
    }

    broker.stop();
  });

  it("returns an empty list when no Google accounts are stored", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { ziggy: {} });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "test-2",
      op: "list-google-accounts",
    })) as { ok: true; data: { accounts: unknown[] } };

    expect(resp.ok).toBe(true);
    expect(resp.data.accounts).toEqual([]);

    broker.stop();
  });

  it("returns an empty list when google_workspace config is absent", async () => {
    const h = makeHarness();
    // Config without google_workspace block.
    const config = {
      switchroom: { version: 1, agents_dir: h.agentsDir },
      telegram: {},
      agents: { ziggy: {} },
      auth: {},
    } as unknown as SwitchroomConfig;

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "test-3",
      op: "list-google-accounts",
    })) as { ok: true; data: { accounts: unknown[] } };

    // Even without the provider registered, this op just reads disk.
    // If the dir doesn't exist, it returns []. No INVALID_ARGS — the
    // op's contract is "what's stored on disk."
    expect(resp.ok).toBe(true);
    expect(resp.data.accounts).toEqual([]);

    broker.stop();
  });
});
