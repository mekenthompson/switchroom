import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock lifecycle module
vi.mock("../src/agents/lifecycle.js", () => ({
  getAllAgentStatuses: vi.fn(),
  startAgent: vi.fn(),
  stopAgent: vi.fn(),
  restartAgent: vi.fn(),
  containerName: (name: string) => `switchroom-${name}`,
}));

// Mock auth module
vi.mock("../src/auth/manager.js", () => ({
  getAllAuthStatuses: vi.fn(),
}));

// Mock config loader
vi.mock("../src/config/loader.js", () => ({
  resolveAgentsDir: vi.fn(() => "/home/test/.switchroom/agents"),
}));

// Account store — handleGetAccounts reads the on-disk inventory.
vi.mock("../src/auth/account-store.js", () => ({
  getAccountInfos: vi.fn(() => []),
}));

// Analytics is fire-and-forget; stub so handleUseAccount doesn't
// reach PostHog during the unit test.
vi.mock("../src/analytics/posthog.js", () => ({
  captureEvent: vi.fn(),
  captureException: vi.fn(),
}));

// Mock child_process
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
  spawn: vi.fn(),
}));

// Auth-broker client — used by the accounts handlers and the new
// system-health handler. vi.mock is hoisted above all top-level decls,
// so the shared state + error classes must live inside vi.hoisted().
const brokerHoist = vi.hoisted(() => {
  class FakeUnreachable extends Error {}
  class FakeBrokerError extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
    }
  }
  return {
    FakeUnreachable,
    FakeBrokerError,
    impl: { run: null as null | ((client: unknown) => Promise<unknown>) },
  };
});
const brokerImpl = brokerHoist.impl;
vi.mock("../src/auth/broker/client.js", () => ({
  AuthBrokerUnreachableError: brokerHoist.FakeUnreachable,
  AuthBrokerError: brokerHoist.FakeBrokerError,
  withAuthBrokerClient: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => {
    if (!brokerHoist.impl.run) {
      throw new brokerHoist.FakeUnreachable("broker down");
    }
    return brokerHoist.impl.run(fn);
  }),
}));

// Hindsight container probes.
vi.mock("../src/setup/hindsight.js", () => ({
  getHindsightStatus: vi.fn(() => null),
  isHindsightRunning: vi.fn(() => false),
}));

import {
  handleGetAgents,
  handleStartAgent,
  handleStopAgent,
  handleRestartAgent,
  handleGetLogs,
  handleGetSystemHealth,
  handleGetGoogleAccounts,
  handleGetSchedule,
  handleGetAccounts,
  handleUseAccount,
  type AgentInfo,
} from "../src/web/api.js";
import { resolveAgentsDir } from "../src/config/loader.js";
import { getAccountInfos } from "../src/auth/account-store.js";
import { isOriginAllowed, isTailscaleIdentified } from "../src/web/server.js";
import { getAllAgentStatuses, startAgent, stopAgent, restartAgent } from "../src/agents/lifecycle.js";
import { getAllAuthStatuses } from "../src/auth/manager.js";
import { getHindsightStatus, isHindsightRunning } from "../src/setup/hindsight.js";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SwitchroomConfig } from "../src/config/schema.js";

// Bun's vitest compat layer doesn't implement vi.mocked(). Use a
// cast helper so we can call .mockReturnValue() etc on the mock-wrapped
// imports without TypeScript complaining.
const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

const mockConfig: SwitchroomConfig = {
  switchroom: { version: 1, agents_dir: "~/.switchroom/agents" },
  telegram: { bot_token: "test-token", forum_chat_id: "-1001234" },
  agents: {
    coach: {
      extends: "health-coach",
      topic_name: "Fitness Coach",
      topic_emoji: "\u{1F3CB}\u{FE0F}",
      schedule: [],
      tools: undefined,
      soul: undefined,
      memory: { collection: "coach-mem", auto_recall: true, isolation: "default" },
    },
    sage: {
      extends: "default",
      topic_name: "Wisdom",
      topic_emoji: "\u{1F9D9}",
      schedule: [],
      tools: undefined,
      soul: undefined,
      memory: undefined,
    },
  },
};

describe("handleGetAgents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns combined status and auth info for each agent", () => {
    asMock(getAllAgentStatuses).mockReturnValue({
      coach: { active: "active", uptime: "2025-01-01T00:00:00Z", memory: "128MB", pid: 1234 },
      sage: { active: "inactive", uptime: null, memory: null, pid: null },
    });

    asMock(getAllAuthStatuses).mockReturnValue({
      coach: { authenticated: true, subscriptionType: "max", timeUntilExpiry: "7h 30m", expiresAt: Date.now() + 27000000 },
      sage: { authenticated: false },
    });

    const result = handleGetAgents(mockConfig);

    expect(result).toHaveLength(2);

    const coach = result.find((a) => a.name === "coach")!;
    expect(coach).toBeDefined();
    expect(coach.active).toBe("active");
    expect(coach.uptime).toBe("2025-01-01T00:00:00Z");
    expect(coach.memory).toBe("128MB");
    expect(coach.extends).toBe("health-coach");
    expect(coach.topic_name).toBe("Fitness Coach");
    expect(coach.topic_emoji).toBe("\u{1F3CB}\u{FE0F}");
    expect(coach.auth.authenticated).toBe(true);
    expect(coach.auth.subscriptionType).toBe("max");
    expect(coach.memoryCollection).toBe("coach-mem");

    const sage = result.find((a) => a.name === "sage")!;
    expect(sage).toBeDefined();
    expect(sage.active).toBe("inactive");
    expect(sage.auth.authenticated).toBe(false);
    expect(sage.memoryCollection).toBe("sage"); // Falls back to agent name
  });

  it("returns correct shape with all fields", () => {
    asMock(getAllAgentStatuses).mockReturnValue({
      coach: { active: "active", uptime: null, memory: null, pid: null },
      sage: { active: "inactive", uptime: null, memory: null, pid: null },
    });
    asMock(getAllAuthStatuses).mockReturnValue({
      coach: { authenticated: false },
      sage: { authenticated: false },
    });

    const result = handleGetAgents(mockConfig);
    const expectedKeys: (keyof AgentInfo)[] = [
      "name", "active", "uptime", "memory", "extends",
      "topic_name", "topic_emoji", "auth", "primaryAccount", "memoryCollection",
    ];

    for (const agent of result) {
      for (const key of expectedKeys) {
        expect(agent).toHaveProperty(key);
      }
      expect(agent.auth).toHaveProperty("authenticated");
    }
  });
});

describe("handleStartAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls startAgent and returns ok on success", () => {
    asMock(startAgent).mockImplementation(() => {});
    const result = handleStartAgent("coach");
    expect(result).toEqual({ ok: true });
    expect(startAgent).toHaveBeenCalledWith("coach");
  });

  it("returns error when startAgent throws", () => {
    asMock(startAgent).mockImplementation(() => {
      throw new Error("service not found");
    });
    const result = handleStartAgent("missing");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("service not found");
  });
});

describe("handleStopAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls stopAgent and returns ok on success", () => {
    asMock(stopAgent).mockImplementation(() => {});
    const result = handleStopAgent("coach");
    expect(result).toEqual({ ok: true });
    expect(stopAgent).toHaveBeenCalledWith("coach");
  });

  it("returns error when stopAgent throws", () => {
    asMock(stopAgent).mockImplementation(() => {
      throw new Error("cannot stop");
    });
    const result = handleStopAgent("coach");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot stop");
  });
});

describe("handleRestartAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls restartAgent and returns ok on success", () => {
    asMock(restartAgent).mockImplementation(() => {});
    const result = handleRestartAgent("sage");
    expect(result).toEqual({ ok: true });
    expect(restartAgent).toHaveBeenCalledWith("sage");
  });

  it("returns error when restartAgent throws", () => {
    asMock(restartAgent).mockImplementation(() => {
      throw new Error("restart failed");
    });
    const result = handleRestartAgent("sage");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("restart failed");
  });
});

describe("handleGetLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns merged container stdout+stderr from docker logs", () => {
    asMock(spawnSync).mockReturnValue({
      status: 0,
      stdout: "line 1\nline 2\n",
      stderr: "boot warn\n",
    } as any);

    const result = handleGetLogs("coach", 50);
    expect(result.ok).toBe(true);
    expect(result.logs).toContain("line 1");
    // docker logs splits container stdout/stderr; both are surfaced.
    expect(result.logs).toContain("boot warn");
    expect(spawnSync).toHaveBeenCalledWith(
      "docker",
      ["logs", "--tail", "50", "switchroom-coach"],
      expect.objectContaining({ encoding: "utf-8" })
    );
  });

  it("uses default of 50 lines", () => {
    asMock(spawnSync).mockReturnValue({ status: 0, stdout: "output", stderr: "" } as any);

    handleGetLogs("sage");
    expect(spawnSync).toHaveBeenCalledWith(
      "docker",
      ["logs", "--tail", "50", "switchroom-sage"],
      expect.any(Object)
    );
  });

  it("returns error when docker logs exits non-zero (no such container)", () => {
    asMock(spawnSync).mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Error: No such container: switchroom-missing\n",
    } as any);

    const result = handleGetLogs("missing", 10);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No such container");
  });

  it("returns error when docker binary is unavailable", () => {
    asMock(spawnSync).mockReturnValue({
      error: new Error("spawn docker ENOENT"),
    } as any);

    const result = handleGetLogs("coach", 10);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ENOENT");
  });
});

// Helper to build a minimal Request with an optional Origin header.
function makeRequest(origin?: string): Request {
  const headers: Record<string, string> = {};
  if (origin !== undefined) headers["Origin"] = origin;
  return new Request("http://127.0.0.1:8080/api/agents", { headers });
}

describe("isOriginAllowed — localhost-only bind (default)", () => {
  const port = 8080;
  const localhostOnly = true;

  it("allows requests with no Origin header (CLI / curl)", () => {
    expect(isOriginAllowed(makeRequest(), port, localhostOnly)).toBe(true);
  });

  it("allows same-origin requests from localhost", () => {
    expect(isOriginAllowed(makeRequest(`http://localhost:${port}`), port, localhostOnly)).toBe(true);
  });

  it("allows same-origin requests from 127.0.0.1", () => {
    expect(isOriginAllowed(makeRequest(`http://127.0.0.1:${port}`), port, localhostOnly)).toBe(true);
  });

  it("rejects a cross-origin request from a remote host", () => {
    expect(isOriginAllowed(makeRequest("http://evil.example.com"), port, localhostOnly)).toBe(false);
  });

  it("rejects a cross-origin request from a LAN IP", () => {
    expect(isOriginAllowed(makeRequest("http://192.168.1.100:8080"), port, localhostOnly)).toBe(false);
  });

  it("rejects when port in Origin doesn't match server port", () => {
    expect(isOriginAllowed(makeRequest("http://localhost:9999"), port, localhostOnly)).toBe(false);
  });
});

describe("isOriginAllowed — network bind (--bind 0.0.0.0 or Tailscale IP)", () => {
  const port = 8080;
  const localhostOnly = false;

  it("allows requests with no Origin header", () => {
    expect(isOriginAllowed(makeRequest(), port, localhostOnly)).toBe(true);
  });

  it("allows a request from a LAN origin with a valid token (origin check skipped)", () => {
    // When bound to 0.0.0.0 / non-loopback, the origin check is bypassed.
    // The bearer token is the sole auth boundary — tested by checkAuth in the server.
    expect(isOriginAllowed(makeRequest("http://192.168.1.100:8080"), port, localhostOnly)).toBe(true);
  });

  it("allows a request from a Tailscale origin (origin check skipped)", () => {
    expect(isOriginAllowed(makeRequest("http://100.64.0.1:8080"), port, localhostOnly)).toBe(true);
  });

  it("allows even a remote-looking origin (token is the boundary)", () => {
    expect(isOriginAllowed(makeRequest("http://remote.example.com"), port, localhostOnly)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isTailscaleIdentified — Tailscale identity header auth
// ---------------------------------------------------------------------------

/**
 * Build a minimal Request with optional Tailscale identity headers.
 * makeServerStub returns a minimal server stub that reports the given source IP.
 */
function makeTsRequest(login?: string, extraHeaders?: Record<string, string>): Request {
  const headers: Record<string, string> = {};
  if (login !== undefined) headers["Tailscale-User-Login"] = login;
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Request("http://127.0.0.1:8080/api/agents", { headers });
}

function makeServerStub(address: string | null): { requestIP(req: Request): { address: string } | null } {
  return {
    requestIP(_req: Request) {
      return address !== null ? { address } : null;
    },
  };
}

describe("isTailscaleIdentified", () => {
  it("returns true when Tailscale-User-Login is present and source IP is 127.0.0.1", () => {
    const req = makeTsRequest("ken@example.com");
    const server = makeServerStub("127.0.0.1");
    expect(isTailscaleIdentified(req, server)).toBe(true);
  });

  it("returns true when Tailscale-User-Login is present and source IP is ::1 (IPv6 loopback)", () => {
    const req = makeTsRequest("ken@example.com");
    const server = makeServerStub("::1");
    expect(isTailscaleIdentified(req, server)).toBe(true);
  });

  it("returns false when Tailscale-User-Login is present but source IP is non-loopback", () => {
    // Simulates a request from a remote IP with a spoofed identity header.
    const req = makeTsRequest("ken@example.com");
    const server = makeServerStub("100.64.0.5");
    expect(isTailscaleIdentified(req, server)).toBe(false);
  });

  it("returns false when Tailscale-User-Login is absent even from loopback", () => {
    const req = makeTsRequest();
    const server = makeServerStub("127.0.0.1");
    expect(isTailscaleIdentified(req, server)).toBe(false);
  });

  it("returns false when Tailscale-User-Login is empty string", () => {
    const req = makeTsRequest("");
    const server = makeServerStub("127.0.0.1");
    expect(isTailscaleIdentified(req, server)).toBe(false);
  });

  it("returns false when server.requestIP returns null (no source IP info)", () => {
    const req = makeTsRequest("ken@example.com");
    const server = makeServerStub(null);
    expect(isTailscaleIdentified(req, server)).toBe(false);
  });

  it("returns false when no header and no source IP (both conditions fail)", () => {
    const req = makeTsRequest();
    const server = makeServerStub(null);
    expect(isTailscaleIdentified(req, server)).toBe(false);
  });
});

describe("handleGetSystemHealth", () => {
  let home: string;

  beforeEach(() => {
    vi.clearAllMocks();
    brokerImpl.run = null;
    asMock(getHindsightStatus).mockReturnValue(null);
    asMock(isHindsightRunning).mockReturnValue(false);
    home = mkdtempSync(join(tmpdir(), "syshealth-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reports broker reachable with fleet snapshot", async () => {
    brokerImpl.run = async (fn) =>
      (fn as (c: unknown) => Promise<unknown>)({
        listState: async () => ({
          active: "ken@example.com",
          fallback_order: [],
          accounts: [{ label: "a" }, { label: "b" }],
          agents: [{ name: "x" }],
          consumers: [{ name: "hindsight" }],
        }),
      });

    const h = await handleGetSystemHealth(home);
    expect(h.broker.reachable).toBe(true);
    expect(h.broker.active).toBe("ken@example.com");
    expect(h.broker.accounts).toBe(2);
    expect(h.broker.agents).toBe(1);
    expect(h.broker.consumers).toBe(1);
  });

  it("reports broker unreachable without throwing", async () => {
    brokerImpl.run = null; // withAuthBrokerClient throws FakeUnreachable
    const h = await handleGetSystemHealth(home);
    expect(h.broker.reachable).toBe(false);
    expect(h.broker.error).toContain("broker down");
  });

  it("formats an AuthBrokerError as `code: message` (reachable but protocol error)", async () => {
    brokerImpl.run = async () => {
      throw new brokerHoist.FakeBrokerError("EPROTO", "bad frame");
    };
    const h = await handleGetSystemHealth(home);
    expect(h.broker.reachable).toBe(false);
    expect(h.broker.error).toBe("EPROTO: bad frame");
  });

  it("reads live hindsight env from docker inspect when running", async () => {
    asMock(getHindsightStatus).mockReturnValue("Up 3 hours");
    asMock(isHindsightRunning).mockReturnValue(true);
    asMock(spawnSync).mockReturnValue({
      status: 0,
      stdout: JSON.stringify([
        "PATH=/usr/bin",
        "HINDSIGHT_API_LLM_MODEL=claude-sonnet-4-6",
        "HINDSIGHT_API_LLM_PROVIDER=claude-code",
        "HINDSIGHT_API_MCP_STATELESS=true",
      ]),
      stderr: "",
    } as never);

    const h = await handleGetSystemHealth(home);
    expect(h.hindsight.running).toBe(true);
    expect(h.hindsight.containerStatus).toBe("Up 3 hours");
    expect(h.hindsight.model).toBe("claude-sonnet-4-6");
    expect(h.hindsight.provider).toBe("claude-code");
    expect(h.hindsight.mcpStateless).toBe(true);
  });

  it("leaves hindsight env null when the container is absent", async () => {
    asMock(getHindsightStatus).mockReturnValue(null);
    asMock(isHindsightRunning).mockReturnValue(false);
    const h = await handleGetSystemHealth(home);
    expect(h.hindsight.running).toBe(false);
    expect(h.hindsight.model).toBeNull();
    expect(h.hindsight.mcpStateless).toBeNull();
    // docker inspect must NOT be probed when the container isn't running.
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("parses the hostd audit log when present (newest entries, capped)", async () => {
    mkdirSync(join(home, ".switchroom"), { recursive: true });
    const line = (op: string, code: number) =>
      JSON.stringify({
        ts: "2026-05-16T10:00:00.000Z",
        op,
        caller: { kind: "agent", name: "carrie" },
        request_id: "r",
        result: code === 0 ? "ok" : "error",
        exit_code: code,
        duration_ms: 12,
      });
    writeFileSync(
      join(home, ".switchroom", "host-control-audit.log"),
      [line("restart", 0), line("update-apply", 1)].join("\n") + "\n",
    );

    const h = await handleGetSystemHealth(home);
    expect(h.hostd.auditLogPresent).toBe(true);
    expect(h.hostd.recent).toHaveLength(2);
    expect(h.hostd.recent.map((e) => e.op)).toEqual([
      "restart",
      "update-apply",
    ]);
  });

  it("reports hostd audit absent on a fresh install (no crash)", async () => {
    const h = await handleGetSystemHealth(home);
    expect(h.hostd.auditLogPresent).toBe(false);
    expect(h.hostd.recent).toEqual([]);
  });
});

describe("handleGetGoogleAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    brokerImpl.run = null;
  });

  const cfgWith = (ga: Record<string, { enabled_for: string[] }>) =>
    ({ ...mockConfig, google_accounts: ga }) as unknown as SwitchroomConfig;

  it("merges broker live data with the config ACL", async () => {
    brokerImpl.run = async (fn) =>
      (fn as (c: unknown) => Promise<unknown>)({
        listGoogleAccounts: async () => ({
          accounts: [
            { account: "alice@example.com", expiresAt: 123, scope: "drive gmail", clientId: "cid-abc" },
          ],
        }),
      });
    const out = await handleGetGoogleAccounts(
      cfgWith({ "alice@example.com": { enabled_for: ["coach", "sage"] } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      account: "alice@example.com",
      expiresAt: 123,
      scope: "drive gmail",
      clientId: "cid-abc",
      enabledFor: ["coach", "sage"],
      brokerKnown: true,
    });
  });

  it("degrades to config-only when the broker is unreachable", async () => {
    brokerImpl.run = null; // throws FakeUnreachable
    const out = await handleGetGoogleAccounts(
      cfgWith({ "bob@example.com": { enabled_for: ["coach"] } }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      account: "bob@example.com",
      expiresAt: null,
      scope: null,
      clientId: null,
      enabledFor: ["coach"],
      brokerKnown: false,
    });
  });

  it("unions config-declared and broker-only accounts", async () => {
    brokerImpl.run = async (fn) =>
      (fn as (c: unknown) => Promise<unknown>)({
        listGoogleAccounts: async () => ({
          accounts: [
            { account: "ghost@example.com", expiresAt: 9, scope: "s", clientId: "c" },
          ],
        }),
      });
    const out = await handleGetGoogleAccounts(
      cfgWith({ "declared@example.com": { enabled_for: [] } }),
    );
    expect(out.map((a) => a.account).sort()).toEqual([
      "declared@example.com",
      "ghost@example.com",
    ]);
    expect(out.find((a) => a.account === "ghost@example.com")!.brokerKnown).toBe(true);
    expect(out.find((a) => a.account === "declared@example.com")!.brokerKnown).toBe(false);
  });
});

describe("handleGetSchedule", () => {
  let tmp: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tmp = mkdtempSync(join(tmpdir(), "sched-"));
    asMock(resolveAgentsDir).mockReturnValue(tmp);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const cfgWithSchedule = () =>
    ({
      ...mockConfig,
      agents: {
        ...mockConfig.agents,
        coach: {
          ...mockConfig.agents.coach,
          schedule: [
            { cron: "0 9 * * *", prompt: "morning standup" },
            { cron: "0 17 * * *", prompt: "evening recap" },
          ],
        },
      },
    }) as unknown as SwitchroomConfig;

  it("returns cascade-resolved entries with recent fires from scheduler.jsonl", () => {
    mkdirSync(join(tmp, "coach"), { recursive: true });
    const row = (idx: number, code: number) =>
      JSON.stringify({
        agent: "coach",
        scheduleIndex: idx,
        promptKey: "k",
        exitCode: code,
        outputSummary: code === 0 ? "delivered to bridge via gateway" : "no agent client connected",
        startedAt: 1747300000000 + idx,
        finishedAt: 1747300000500 + idx,
      });
    writeFileSync(
      join(tmp, "coach", "scheduler.jsonl"),
      [row(0, 0), row(1, -1)].join("\n") + "\n",
    );

    const d = handleGetSchedule(cfgWithSchedule());
    expect(d.entries.filter((e) => e.agent === "coach")).toHaveLength(2);
    expect(d.entries[0].cron).toBe("0 9 * * *");
    expect(d.recentByAgent.coach).toHaveLength(2);
    expect(d.recentByAgent.coach[1].exitCode).toBe(-1);
  });

  it("skips agents with no scheduler.jsonl without failing", () => {
    const d = handleGetSchedule(cfgWithSchedule());
    expect(d.entries.length).toBeGreaterThan(0);
    expect(d.recentByAgent.coach).toBeUndefined();
  });

  it("tolerates a torn JSONL line", () => {
    mkdirSync(join(tmp, "coach"), { recursive: true });
    writeFileSync(
      join(tmp, "coach", "scheduler.jsonl"),
      '{"agent":"coach","exitCode":0,"outputSummary":"ok","startedAt":1,"finishedAt":2,"scheduleIndex":0,"promptKey":"k"}\n{ broken json\n',
    );
    const d = handleGetSchedule(cfgWithSchedule());
    expect(d.recentByAgent.coach).toHaveLength(1);
  });
});

// Deferred P0-review nit: pin the RFC-H accounts/use wire shapes.
describe("handleGetAccounts / handleUseAccount shape (RFC-H)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    brokerImpl.run = null;
    asMock(getAccountInfos).mockReturnValue([
      { label: "ken@x.com", health: "ok", expiresAt: 111 },
    ] as never);
  });

  // usedBy is derived from the fleet-active binding, so the config
  // must declare auth.active for coach+sage to resolve to this label.
  const cfgActive = () =>
    ({ ...mockConfig, auth: { active: "ken@x.com" } }) as unknown as SwitchroomConfig;

  it("handleGetAccounts attaches broker quota + usedBy to each account", async () => {
    brokerImpl.run = async (fn) =>
      (fn as (c: unknown) => Promise<unknown>)({
        listState: async () => ({
          active: "ken@x.com",
          fallback_order: [],
          accounts: [
            { label: "ken@x.com", exhausted: false, threshold_violations: 2 },
          ],
          agents: [],
          consumers: [],
        }),
      });
    const out = await handleGetAccounts(cfgActive());
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("ken@x.com");
    expect(out[0].quota).toMatchObject({ exhausted: false, threshold_violations: 2 });
    // coach + sage both bind the fleet-active account (no overrides).
    expect(out[0].usedBy.sort()).toEqual(["coach", "sage"]);
  });

  it("handleGetAccounts degrades quota to null when broker unreachable", async () => {
    brokerImpl.run = null;
    const out = await handleGetAccounts(cfgActive());
    expect(out[0].quota).toBeNull();
    expect(out[0].usedBy.sort()).toEqual(["coach", "sage"]);
  });

  it("handleUseAccount returns {ok, active, fanned} on success", async () => {
    brokerImpl.run = async (fn) =>
      (fn as (c: unknown) => Promise<unknown>)({
        setActive: async (label: string) => ({
          active: label,
          fanned: ["coach", "sage"],
        }),
      });
    const r = await handleUseAccount("ken@x.com");
    expect(r).toEqual({ ok: true, active: "ken@x.com", fanned: ["coach", "sage"] });
  });

  it("handleUseAccount maps broker-unreachable to a clean error", async () => {
    brokerImpl.run = null;
    const r = await handleUseAccount("ken@x.com");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("broker down");
  });
});
