/**
 * Tests for {@link createAgent} — happy-path, rollback-on-failure, and
 * idempotent re-run behaviour. PR-D1 / v0.7 coverage gap #1.
 *
 * createAgent is heavily I/O-coupled (yaml writes, scaffold-on-disk,
 * Telegram getMe network round-trip, OAuth tmux session). We mock every
 * external boundary so the tests exercise the orchestrator's sequencing
 * + rollback bookkeeping without touching the real filesystem, network,
 * or systemd. The yaml + agent-dir mutations are tracked in tmpdirs so
 * we can assert the rollback actually unwound them.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

vi.mock("./scaffold.js", () => ({
  scaffoldAgent: vi.fn(),
  reconcileAgent: vi.fn(),
}));

vi.mock("./profiles.js", () => ({
  listAvailableProfiles: vi.fn(() => ["default", "general", "health-coach"]),
}));

vi.mock("./lifecycle.js", () => ({
  startAgent: vi.fn(),
  stopAgent: vi.fn(),
}));

vi.mock("../auth/manager.js", () => ({
  startAuthSession: vi.fn(),
  submitAuthCode: vi.fn(),
}));

vi.mock("../setup/telegram-api.js", () => ({
  validateBotToken: vi.fn().mockResolvedValue({ id: 1, is_bot: true, username: "ken_bot" }),
  validateBotTokenMatchesAgent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../setup/onboarding.js", () => ({
  writeAgentEnv: vi.fn(),
}));

import { createAgent } from "./create-orchestrator.js";
import { scaffoldAgent } from "./scaffold.js";
import { startAuthSession } from "../auth/manager.js";
import { writeAgentEnv } from "../setup/onboarding.js";
import { validateBotTokenMatchesAgent } from "../setup/telegram-api.js";

function makeWorkspace(): { configPath: string; agentsDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "create-orch-"));
  const agentsDir = join(root, "agents");
  mkdirSync(agentsDir, { recursive: true });
  const configPath = join(root, "switchroom.yaml");
  writeFileSync(
    configPath,
    [
      "switchroom:",
      "  version: 1",
      `  agents_dir: ${agentsDir}`,
      "telegram:",
      "  bot_token: \"vault:telegram-bot-token\"",
      "  forum_chat_id: \"-1001234567890\"",
      "agents: {}",
      "",
    ].join("\n"),
  );
  return {
    configPath,
    agentsDir,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("createAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (validateBotTokenMatchesAgent as any).mockResolvedValue(undefined);
    (startAuthSession as any).mockReturnValue({
      loginUrl: "https://login.example/code",
      sessionName: "auth-bot-1",
    });
    // scaffoldAgent must create the agentDir on disk so the rollback can
    // remove it (tests assert dir-exists before/after rollback).
    (scaffoldAgent as any).mockImplementation(
      (_name: string, _cfg: unknown, agentsDir: string, _tg: unknown, _config: unknown, _slot: unknown, _configPath?: string) => {
        const name = _name as string;
        mkdirSync(join(agentsDir, name), { recursive: true });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: validates token, writes yaml entry, scaffolds, writes env, starts auth", async () => {
    const ws = makeWorkspace();
    try {
      const result = await createAgent({
        name: "bot",
        profile: "general",
        telegramBotToken: "fake:token",
        configPath: ws.configPath,
      });

      expect(validateBotTokenMatchesAgent).toHaveBeenCalledWith("fake:token", "bot");
      expect(scaffoldAgent).toHaveBeenCalledOnce();
      expect(writeAgentEnv).toHaveBeenCalledWith(
        join(ws.agentsDir, "bot"),
        "fake:token",
      );
      expect(startAuthSession).toHaveBeenCalledOnce();
      expect(result.loginUrl).toBe("https://login.example/code");
      expect(result.sessionName).toBe("auth-bot-1");
      expect(result.agentDir).toBe(resolve(ws.agentsDir, "bot"));

      // yaml entry written
      const yamlBody = readFileSync(ws.configPath, "utf-8");
      expect(yamlBody).toMatch(/\bbot:/);
      // agent dir from scaffoldAgent mock is on disk
      expect(existsSync(join(ws.agentsDir, "bot"))).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("rollback-on-failure: when startAuthSession throws and rollbackOnFail=true, yaml entry + agent dir are reverted", async () => {
    const ws = makeWorkspace();
    try {
      (startAuthSession as any).mockImplementation(() => {
        throw new Error("auth tmux failed");
      });

      await expect(
        createAgent({
          name: "bot",
          profile: "general",
          telegramBotToken: "fake:token",
          configPath: ws.configPath,
          rollbackOnFail: true,
        }),
      ).rejects.toThrow(/auth tmux failed/);

      // yaml rolled back: bot entry removed
      const yamlBody = readFileSync(ws.configPath, "utf-8");
      expect(yamlBody).not.toMatch(/\bbot:/);
      // agent dir cleaned up
      expect(existsSync(join(ws.agentsDir, "bot"))).toBe(false);
    } finally {
      ws.cleanup();
    }
  });

  it("rollback-on-failure: when rollbackOnFail=false, side-effects remain for retry", async () => {
    const ws = makeWorkspace();
    try {
      (startAuthSession as any).mockImplementation(() => {
        throw new Error("auth tmux failed");
      });

      await expect(
        createAgent({
          name: "bot",
          profile: "general",
          telegramBotToken: "fake:token",
          configPath: ws.configPath,
          rollbackOnFail: false,
        }),
      ).rejects.toThrow(/auth tmux failed/);

      // yaml entry is preserved so the operator can retry
      const yamlBody = readFileSync(ws.configPath, "utf-8");
      expect(yamlBody).toMatch(/\bbot:/);
      expect(existsSync(join(ws.agentsDir, "bot"))).toBe(true);
    } finally {
      ws.cleanup();
    }
  });

  it("idempotent re-run: invoking with the same profile when the agent is already in yaml succeeds without throwing", async () => {
    const ws = makeWorkspace();
    try {
      // First run — populates yaml + scaffolds
      await createAgent({
        name: "bot",
        profile: "general",
        telegramBotToken: "fake:token",
        configPath: ws.configPath,
      });
      const callsAfterFirst = (scaffoldAgent as any).mock.calls.length;

      // Second run with same profile must not throw and must reuse the existing entry
      await expect(
        createAgent({
          name: "bot",
          profile: "general",
          telegramBotToken: "fake:token",
          configPath: ws.configPath,
        }),
      ).resolves.toMatchObject({ sessionName: "auth-bot-1" });

      expect((scaffoldAgent as any).mock.calls.length).toBeGreaterThan(callsAfterFirst);
    } finally {
      ws.cleanup();
    }
  });

  it("rejects re-run with a different profile (would mutate extends silently)", async () => {
    const ws = makeWorkspace();
    try {
      await createAgent({
        name: "bot",
        profile: "general",
        telegramBotToken: "fake:token",
        configPath: ws.configPath,
      });

      await expect(
        createAgent({
          name: "bot",
          profile: "health-coach",
          telegramBotToken: "fake:token",
          configPath: ws.configPath,
        }),
      ).rejects.toThrow(/already configured with profile "general"/);
    } finally {
      ws.cleanup();
    }
  });

  it("rejects invalid agent name slugs before any disk writes", async () => {
    const ws = makeWorkspace();
    try {
      await expect(
        createAgent({
          name: "BadName!",
          profile: "general",
          telegramBotToken: "fake:token",
          configPath: ws.configPath,
        }),
      ).rejects.toThrow(/Invalid agent name/);
      expect(scaffoldAgent).not.toHaveBeenCalled();
      expect(validateBotTokenMatchesAgent).not.toHaveBeenCalled();
    } finally {
      ws.cleanup();
    }
  });

  it("rejects unknown profile before token validation or disk writes", async () => {
    const ws = makeWorkspace();
    try {
      await expect(
        createAgent({
          name: "bot",
          profile: "no-such-profile",
          telegramBotToken: "fake:token",
          configPath: ws.configPath,
        }),
      ).rejects.toThrow(/Unknown profile/);
      expect(validateBotTokenMatchesAgent).not.toHaveBeenCalled();
      expect(scaffoldAgent).not.toHaveBeenCalled();
    } finally {
      ws.cleanup();
    }
  });

  it("bot-token validation failure aborts before any yaml/scaffold work", async () => {
    const ws = makeWorkspace();
    try {
      (validateBotTokenMatchesAgent as any).mockRejectedValueOnce(
        new Error("Telegram getMe rejected"),
      );

      await expect(
        createAgent({
          name: "bot",
          profile: "general",
          telegramBotToken: "broken:token",
          configPath: ws.configPath,
        }),
      ).rejects.toThrow(/Bot token validation failed/);

      expect(scaffoldAgent).not.toHaveBeenCalled();
      const yamlBody = readFileSync(ws.configPath, "utf-8");
      expect(yamlBody).not.toMatch(/\bbot:/);
    } finally {
      ws.cleanup();
    }
  });
});
