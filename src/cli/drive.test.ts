/**
 * Tests for `switchroom drive connect / disconnect`.
 *
 * The CLI runner is exercised through the `__test` exports so we can drive
 * the result-state machine without spawning a child process. All network and
 * vault I/O is faked through dependency injection on `DriveCliDeps`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../config/loader.js", () => ({
  loadConfig: vi.fn(() => ({
    switchroom: { version: 1 },
    telegram: { bot_token: "x", forum_chat_id: "1" },
    agents: { klanker: {} },
    vault: { path: "~/.switchroom/vault.enc" },
  })),
  resolvePath: (p: string) => p.replace(/^~/, "/tmp"),
  findConfigFile: () => "/tmp/switchroom.yaml",
  ConfigError: class ConfigError extends Error {},
}));

import { __test, type DriveCliDeps } from "./drive.js";
import type { WaitForApprovalResult } from "../vault/approvals/wait.js";
import type { TokenResponse } from "../drive/oauth.js";

const VALID_TOKENS: TokenResponse = {
  access_token: "at",
  refresh_token: "rt",
  expires_in: 3600,
  token_type: "Bearer",
};

interface CapturedExit {
  code: number | null;
}

function makeDeps(overrides: Partial<DriveCliDeps> = {}): {
  deps: DriveCliDeps;
  exit: CapturedExit;
  out: string[];
  errOut: string[];
  writes: { token: number; status: number; deletes: number };
} {
  const exit: CapturedExit = { code: null };
  const out: string[] = [];
  const errOut: string[] = [];
  const writes = { token: 0, status: 0, deletes: 0 };

  const deps: DriveCliDeps = {
    runOAuth: vi.fn(async () => VALID_TOKENS),
    waitForApproval: vi.fn(
      async () =>
        ({
          kind: "decided",
          state: "granted",
          decision: {} as never,
          request_id: "r1",
        }) as WaitForApprovalResult,
    ),
    writeRefreshToken: vi.fn(() => {
      writes.token++;
    }),
    readRefreshToken: vi.fn(() => null),
    writeStatus: vi.fn(() => {
      writes.status++;
    }),
    deleteSlots: vi.fn(() => {
      writes.deletes++;
    }),
    getPassphrase: vi.fn(async () => "pp"),
    exit: (c: number) => {
      exit.code = c;
    },
    log: (...a: unknown[]) => out.push(a.map(String).join(" ")),
    err: (...a: unknown[]) => errOut.push(a.map(String).join(" ")),
    ...overrides,
  };
  return { deps, exit, out, errOut, writes };
}

describe("drive connect", () => {
  beforeEach(() => {
    process.env.SWITCHROOM_GOOGLE_CLIENT_ID = "cid";
    process.env.SWITCHROOM_GOOGLE_CLIENT_SECRET = "csec";
    process.env.SWITCHROOM_APPROVER_USER_ID = "42";
  });

  it("granted: writes vault slots and exits 0", async () => {
    const { deps, exit, writes } = makeDeps();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(0);
    expect(writes.token).toBe(1);
    expect(writes.status).toBe(1);
    expect(writes.deletes).toBe(0);
  });

  it("denied: cleans up vault slots and exits 1", async () => {
    const { deps, exit, writes } = makeDeps({
      waitForApproval: vi.fn(
        async () =>
          ({
            kind: "decided",
            state: "denied",
            decision: {} as never,
            request_id: "r1",
          }) as WaitForApprovalResult,
      ),
    });
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(1);
    expect(writes.token).toBe(1); // initial write happens before wait
    expect(writes.deletes).toBe(1); // cleanup
  });

  it("timeout: cleans up and exits 2", async () => {
    const { deps, exit, writes } = makeDeps({
      waitForApproval: vi.fn(
        async () => ({ kind: "timeout", request_id: "r1" }) as WaitForApprovalResult,
      ),
    });
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(2);
    expect(writes.deletes).toBe(1);
  });

  it("aborted via SIGINT: cleans up and exits 130", async () => {
    const ac = new AbortController();
    const { deps, exit, writes } = makeDeps({
      abortSignal: ac.signal,
      waitForApproval: vi.fn(
        async () => ({ kind: "aborted", request_id: "r1" }) as WaitForApprovalResult,
      ),
    });
    ac.abort();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(130);
    expect(writes.deletes).toBe(1);
  });

  it("rate_limited: preserves vault slot and exits 3", async () => {
    const { deps, exit, writes } = makeDeps({
      waitForApproval: vi.fn(
        async () =>
          ({ kind: "rate_limited", retry_after_ms: 5000 }) as WaitForApprovalResult,
      ),
    });
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(3);
    expect(writes.token).toBe(1); // OAuth completed, write happened
    expect(writes.deletes).toBe(0); // but the slot was preserved for retry
  });

  it("existing refresh_token skips OAuth and re-fires approval", async () => {
    const { deps, exit, writes } = makeDeps({
      readRefreshToken: vi.fn(() => "existing-rt"),
    });
    const oauthSpy = deps.runOAuth as ReturnType<typeof vi.fn>;
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(0);
    expect(oauthSpy).not.toHaveBeenCalled();
    expect(writes.token).toBe(0); // already there, no fresh write
    expect(writes.status).toBe(0);
  });

  it("OAuth failure: exits 4 and does NOT call deleter", async () => {
    const { deps, exit, writes } = makeDeps({
      runOAuth: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(4);
    expect(writes.token).toBe(0);
    expect(writes.deletes).toBe(0); // nothing was written, nothing to clean
  });

  it("waitForApproval throws AbortError: exits 130 (defensive)", async () => {
    const ac = new AbortController();
    const { deps, exit, writes } = makeDeps({
      abortSignal: ac.signal,
      waitForApproval: vi.fn(async () => {
        const e = new Error("Aborted");
        e.name = "AbortError";
        throw e;
      }),
    });
    ac.abort();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(130);
    expect(writes.deletes).toBe(1);
  });

  it("non-numeric --approver: exits 4 without OAuth", async () => {
    const { deps, exit } = makeDeps();
    const oauthSpy = deps.runOAuth as ReturnType<typeof vi.fn>;
    await __test.runConnect({ agentName: "klanker", approver: "ken" }, deps);
    expect(exit.code).toBe(4);
    expect(oauthSpy).not.toHaveBeenCalled();
  });

  it("unknown agent: exits 4 without OAuth", async () => {
    const { deps, exit } = makeDeps();
    const oauthSpy = deps.runOAuth as ReturnType<typeof vi.fn>;
    await __test.runConnect({ agentName: "ghost" }, deps);
    expect(exit.code).toBe(4);
    expect(oauthSpy).not.toHaveBeenCalled();
  });

  it("missing client id: exits 4", async () => {
    delete process.env.SWITCHROOM_GOOGLE_CLIENT_ID;
    const { deps, exit } = makeDeps();
    await __test.runConnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(4);
  });
});

describe("drive disconnect", () => {
  it("happy path: local + Google ok, exit 0", async () => {
    const { deps, exit, out } = makeDeps({
      disconnectDrive: vi.fn(async () => ({
        agent_unit: "klanker",
        local_revoked: true,
        google_revoke: "ok" as const,
      })),
    });
    await __test.runDisconnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(0);
    expect(out.join("\n")).toMatch(/klanker/);
    expect(out.join("\n")).toMatch(/Google revoke: .*ok/);
  });

  it("Google revoke failed: still exit 0, surface in stdout", async () => {
    const { deps, exit, out } = makeDeps({
      disconnectDrive: vi.fn(async () => ({
        agent_unit: "klanker",
        local_revoked: true,
        google_revoke: "failed" as const,
        google_revoke_detail: "503: upstream",
      })),
    });
    await __test.runDisconnect({ agentName: "klanker" }, deps);
    expect(exit.code).toBe(0);
    expect(out.join("\n")).toMatch(/failed:503/);
  });

  it("unknown agent: exit 4", async () => {
    const { deps, exit } = makeDeps();
    await __test.runDisconnect({ agentName: "ghost" }, deps);
    expect(exit.code).toBe(4);
  });
});
