import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";

// Mock out every outbound dependency so the reconcile+restart sequencing
// test is deterministic and doesn't shell out to systemctl or touch
// real scaffolded files. vi.hoisted hoists this above the vi.mock
// factories so it's actually defined when they run.
const mocks = vi.hoisted(() => ({
  reconcile: vi.fn(() => ({
    agentDir: "/fake/agent",
    changes: [],
    changesBySemantics: { hot: [], staleTillRestart: [], restartRequired: [] },
  })),
  restart: vi.fn(),
  gracefulRestart: vi.fn(async () => ({
    restartedImmediately: true,
    waitingForTurn: false,
  })),
  regenerateSystemdUnits: vi.fn(() => []),
}));

vi.mock("../src/agents/scaffold.js", () => ({
  scaffoldAgent: vi.fn(),
  reconcileAgent: mocks.reconcile,
}));

vi.mock("../src/agents/lifecycle.js", () => ({
  startAgent: vi.fn(),
  stopAgent: vi.fn(),
  restartAgent: mocks.restart,
  gracefulRestartAgent: mocks.gracefulRestart,
  interruptAgent: vi.fn(),
  getAgentStatus: vi.fn(),
  getAllAgentStatuses: vi.fn(() => ({})),
  attachAgent: vi.fn(),
  getAgentLogs: vi.fn(),
  writeRestartReasonMarker: vi.fn(),
  buildCliRestartReason: vi.fn(() => "cli: restart"),
}));

vi.mock("../src/analytics/posthog.js", () => ({
  captureEvent: vi.fn(),
  installGlobalErrorHandlers: vi.fn(),
}));

import { reconcileAndRestartAgent } from "../src/cli/agent.js";
import type { SwitchroomConfig, AgentConfig } from "../src/config/schema.js";

function makeConfig(agents: Record<string, AgentConfig>): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "/tmp/agents",
      skills_dir: "/tmp/skills",
    },
    telegram: { bot_token: "123:abc" },
    defaults: {},
    agents,
  } as unknown as SwitchroomConfig;
}

describe("reconcileAndRestartAgent — restart always reconciles first", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-restart-"));
    mocks.reconcile.mockReset();
    mocks.restart.mockReset();
    mocks.gracefulRestart.mockReset();
    mocks.regenerateSystemdUnits.mockReset();
    // Reset default return values after reset clears them.
    mocks.reconcile.mockReturnValue({
      agentDir: "/fake/agent",
      changes: [],
      changesBySemantics: { hot: [], staleTillRestart: [], restartRequired: [] },
    });
    mocks.gracefulRestart.mockResolvedValue({
      restartedImmediately: true,
      waitingForTurn: false,
    });
    mocks.regenerateSystemdUnits.mockReturnValue([]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // Core regression: if a future refactor makes restart a pure
  // systemctl restart, this test fails. Reconcile must run first.
  it("calls reconcileAgent before restartAgent", async () => {
    const config = makeConfig({
      clerk: { profile: "default", topic_name: "Clerk" } as AgentConfig,
    });

    const callOrder: string[] = [];
    mocks.reconcile.mockImplementation(() => {
      callOrder.push("reconcile");
      return {
        agentDir: "/fake/agent",
        changes: [],
        changesBySemantics: { hot: [], staleTillRestart: [], restartRequired: [] },
      };
    });
    mocks.restart.mockImplementation(() => {
      callOrder.push("restart");
    });

    await reconcileAndRestartAgent(
      "clerk",
      config,
      "/tmp/agents",
      undefined,
      { silent: true },
      {
        reconcileAgent: mocks.reconcile,
        restartAgent: mocks.restart,
        gracefulRestartAgent: mocks.gracefulRestart,
        regenerateSystemdUnits: mocks.regenerateSystemdUnits,
      },
    );

    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.restart).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["reconcile", "restart"]);
  });

  // Failure safety: a broken config must not be applied on top of a
  // running agent. If reconcile throws, restart is skipped. Without
  // this, a half-reconciled agent could get kicked into an invalid
  // state with no easy recovery.
  it("does NOT call restartAgent when reconcileAgent throws", async () => {
    const config = makeConfig({
      clerk: { profile: "default", topic_name: "Clerk" } as AgentConfig,
    });
    mocks.reconcile.mockImplementation(() => {
      throw new Error("yaml parse error: unexpected token");
    });

    await expect(
      reconcileAndRestartAgent(
        "clerk",
        config,
        "/tmp/agents",
        undefined,
        { silent: true },
        {
          reconcileAgent: mocks.reconcile,
          restartAgent: mocks.restart,
          gracefulRestartAgent: mocks.gracefulRestart,
          regenerateSystemdUnits: mocks.regenerateSystemdUnits,
        },
      ),
    ).rejects.toThrow(/yaml parse error/);

    expect(mocks.reconcile).toHaveBeenCalledTimes(1);
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(mocks.gracefulRestart).not.toHaveBeenCalled();
  });

  it("uses gracefulRestartAgent when graceful=true", async () => {
    const config = makeConfig({
      clerk: { profile: "default", topic_name: "Clerk" } as AgentConfig,
    });

    await reconcileAndRestartAgent(
      "clerk",
      config,
      "/tmp/agents",
      undefined,
      { silent: true, graceful: true },
      {
        reconcileAgent: mocks.reconcile,
        restartAgent: mocks.restart,
        gracefulRestartAgent: mocks.gracefulRestart,
        regenerateSystemdUnits: mocks.regenerateSystemdUnits,
      },
    );

    expect(mocks.gracefulRestart).toHaveBeenCalledTimes(1);
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  // Returned `changes` must include whatever reconcile reported so the
  // caller (and future regressions that rely on exit code / log
  // parsing) can see what actually got rewritten.
  it("surfaces reconcile's changes in the return value", async () => {
    const config = makeConfig({
      clerk: { profile: "default", topic_name: "Clerk" } as AgentConfig,
    });
    mocks.reconcile.mockReturnValue({
      agentDir: "/fake/agent",
      changes: ["/fake/agent/start.sh", "/fake/agent/.claude/settings.json"],
      changesBySemantics: {
        hot: [],
        staleTillRestart: [],
        restartRequired: [
          "/fake/agent/start.sh",
          "/fake/agent/.claude/settings.json",
        ],
      },
    });

    const result = await reconcileAndRestartAgent(
      "clerk",
      config,
      "/tmp/agents",
      undefined,
      { silent: true },
      {
        reconcileAgent: mocks.reconcile,
        restartAgent: mocks.restart,
        gracefulRestartAgent: mocks.gracefulRestart,
        regenerateSystemdUnits: mocks.regenerateSystemdUnits,
      },
    );

    expect(result.reconciled).toBe(true);
    expect(result.restarted).toBe(true);
    expect(result.changes).toContain("/fake/agent/start.sh");
    expect(result.changes).toContain("/fake/agent/.claude/settings.json");
  });

  // Systemd units live outside the agentDir, so reconcileAgent
  // doesn't touch them. The wrapper must regenerate them — this is
  // what makes template updates (like the new `EnvironmentFile=-`)
  // self-heal on the next restart.
  it("regenerates systemd units as part of reconcile", async () => {
    const config = makeConfig({
      clerk: { profile: "default", topic_name: "Clerk" } as AgentConfig,
    });
    mocks.regenerateSystemdUnits.mockReturnValue([
      "/fake/home/.config/systemd/user/switchroom-clerk.service",
    ]);

    const result = await reconcileAndRestartAgent(
      "clerk",
      config,
      "/tmp/agents",
      undefined,
      { silent: true },
      {
        reconcileAgent: mocks.reconcile,
        restartAgent: mocks.restart,
        gracefulRestartAgent: mocks.gracefulRestart,
        regenerateSystemdUnits: mocks.regenerateSystemdUnits,
      },
    );

    expect(mocks.regenerateSystemdUnits).toHaveBeenCalledTimes(1);
    expect(result.changes).toContain(
      "/fake/home/.config/systemd/user/switchroom-clerk.service",
    );
  });

  // If the agent isn't defined in the config the wrapper must fail
  // loudly rather than calling restart on a stray name — prevents
  // silent no-ops on typos.
  it("throws when the agent is not in switchroom.yaml", async () => {
    const config = makeConfig({});

    await expect(
      reconcileAndRestartAgent(
        "missing",
        config,
        "/tmp/agents",
        undefined,
        { silent: true },
        {
          reconcileAgent: mocks.reconcile,
          restartAgent: mocks.restart,
          gracefulRestartAgent: mocks.gracefulRestart,
          regenerateSystemdUnits: mocks.regenerateSystemdUnits,
        },
      ),
    ).rejects.toThrow(/not defined in switchroom\.yaml/);

    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });
});

// Also make sure we can re-hydrate a config from disk and drive the
// same entry point end-to-end (minus the real systemctl/fs side
// effects). Catches regressions where the CLI-level wiring drifts
// from the helper signature.
describe("reconcileAndRestartAgent — from disk config", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-restart-disk-"));
    configPath = join(tmpDir, "switchroom.yaml");
    writeFileSync(
      configPath,
      YAML.stringify({
        switchroom: { version: 1, agents_dir: join(tmpDir, "agents") },
        telegram: { bot_token: "123:abc" },
        agents: {
          clerk: { extends: "default", topic_name: "Clerk" },
        },
      }),
      "utf-8",
    );
    mocks.reconcile.mockReset();
    mocks.restart.mockReset();
    mocks.regenerateSystemdUnits.mockReset();
    mocks.reconcile.mockReturnValue({
      agentDir: join(tmpDir, "agents", "clerk"),
      changes: [],
      changesBySemantics: { hot: [], staleTillRestart: [], restartRequired: [] },
    });
    mocks.regenerateSystemdUnits.mockReturnValue([]);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("drives reconcile + restart for an agent defined on disk", async () => {
    const config = YAML.parse(readFileSync(configPath, "utf-8")) as SwitchroomConfig;

    await reconcileAndRestartAgent(
      "clerk",
      config,
      join(tmpDir, "agents"),
      configPath,
      { silent: true },
      {
        reconcileAgent: mocks.reconcile,
        restartAgent: mocks.restart,
        gracefulRestartAgent: mocks.gracefulRestart,
        regenerateSystemdUnits: mocks.regenerateSystemdUnits,
      },
    );

    expect(mocks.reconcile).toHaveBeenCalledWith(
      "clerk",
      expect.objectContaining({ extends: "default" }),
      join(tmpDir, "agents"),
      expect.anything(),
      expect.anything(),
      configPath,
    );
    expect(mocks.restart).toHaveBeenCalledWith("clerk");
  });
});
