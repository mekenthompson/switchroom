import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

// Regression for #883: scaffoldAgent must regenerate .mcp.json whenever
// the rendered content differs from what's on disk. The bug was that
// scaffoldAgent gated `.mcp.json` writes on `if (!existsSync(...))`, so
// the v0.7.6 fix that switched docker-mode plugin paths from the host
// repo to /opt/switchroom/telegram-plugin never reached agents whose
// `.mcp.json` already existed from a pre-v0.7.6 scaffold. Result: 7 of
// 8 agents in the v0.6 → v0.7 cutover had host-path `--cwd` baked into
// .mcp.json — claude couldn't spawn the MCP plugin, no bridge connected,
// every Telegram message got "⏳ Agent is restarting…" forever.

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

function makeSwitchroomConfig(name: string, agentConfig: AgentConfig): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    agents: { [name]: agentConfig },
  };
}

describe("scaffoldAgent: .mcp.json content-aware regeneration (#883)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-regen-mcpjson-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rewrites an existing .mcp.json whose contents drift from the template", () => {
    const name = "drifted-mcp";
    const config = makeAgentConfig();
    const switchroomConfig = makeSwitchroomConfig(name, config);

    const first = scaffoldAgent(name, config, tmpDir, telegramConfig, switchroomConfig);
    const mcpPath = join(first.agentDir, ".mcp.json");
    const fresh = readFileSync(mcpPath, "utf-8");
    expect(first.created).toContain(mcpPath);
    expect(fresh).toContain('"switchroom-telegram"');

    // Simulate a stale .mcp.json from a pre-v0.7.6 scaffold where the
    // plugin path was the host repo path, not the in-image baked path.
    const stale = JSON.stringify({
      mcpServers: {
        "switchroom-telegram": {
          command: "bun",
          args: ["run", "--cwd", "/home/legacy/host/path/telegram-plugin", "--shell=bun", "--silent", "start"],
          env: {},
        },
      },
    }, null, 2) + "\n";
    writeFileSync(mcpPath, stale, "utf-8");
    expect(readFileSync(mcpPath, "utf-8")).toBe(stale);

    // Re-scaffold with same config. Pre-fix this was a no-op (the
    // existsSync guard skipped the existing file). Post-fix it detects
    // content drift and rewrites with the current template output.
    const second = scaffoldAgent(name, config, tmpDir, telegramConfig, switchroomConfig);

    const after = readFileSync(mcpPath, "utf-8");
    expect(after).toBe(fresh);
    expect(after).not.toContain("/home/legacy/host/path");
    expect(second.created).toContain(mcpPath);
  });

  it("does NOT rewrite an existing .mcp.json when content already matches", () => {
    const name = "stable-mcp";
    const config = makeAgentConfig();
    const switchroomConfig = makeSwitchroomConfig(name, config);

    const first = scaffoldAgent(name, config, tmpDir, telegramConfig, switchroomConfig);
    const mcpPath = join(first.agentDir, ".mcp.json");

    const second = scaffoldAgent(name, config, tmpDir, telegramConfig, switchroomConfig);
    expect(second.created).not.toContain(mcpPath);
    expect(second.skipped).toContain(mcpPath);
  });
});

// Regression: the per-agent `gdrive` MCP must land in the written
// .mcp.json — the file Claude Code actually loads for
// switchroom-telegram-plugin agents — NOT only in
// settings.json.mcpServers. PR #1355 wired it solely into the settings
// path, so `resolveGdriveMcpEntry` returned the entry and unit tests
// passed, yet the agent never saw a Drive tool (verified empirically:
// carrie's in-container .mcp.json had no `gdrive`). These tests assert
// the actual .mcp.json output, which is what was missing.
describe("scaffoldAgent: gdrive lands in .mcp.json (not just settings)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-gdrive-mcpjson-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function cfg(
    name: string,
    agentConfig: AgentConfig,
    googleAccounts?: Record<string, { enabled_for?: string[] }>,
  ): SwitchroomConfig {
    return {
      ...makeSwitchroomConfig(name, agentConfig),
      ...(googleAccounts ? { google_accounts: googleAccounts } : {}),
    } as SwitchroomConfig;
  }

  it("broker-authorized agent → .mcp.json contains the gdrive entry", () => {
    const name = "carrie";
    const agentConfig = makeAgentConfig({
      google_workspace: { account: "you@example.com" },
    } as Partial<AgentConfig>);
    const sc = cfg(name, agentConfig, {
      "you@example.com": { enabled_for: ["carrie"] },
    });

    const res = scaffoldAgent(name, agentConfig, tmpDir, telegramConfig, sc);
    const mcp = JSON.parse(
      readFileSync(join(res.agentDir, ".mcp.json"), "utf-8"),
    );
    expect(Object.keys(mcp.mcpServers)).toContain("gdrive");
    expect(mcp.mcpServers.gdrive.command).toBeTruthy();
  });

  it("agent NOT in enabled_for → .mcp.json has NO gdrive entry", () => {
    const name = "carrie";
    const agentConfig = makeAgentConfig({
      google_workspace: { account: "you@example.com" },
    } as Partial<AgentConfig>);
    const sc = cfg(name, agentConfig, {
      "you@example.com": { enabled_for: ["someone-else"] },
    });

    const res = scaffoldAgent(name, agentConfig, tmpDir, telegramConfig, sc);
    const mcp = JSON.parse(
      readFileSync(join(res.agentDir, ".mcp.json"), "utf-8"),
    );
    expect(Object.keys(mcp.mcpServers)).not.toContain("gdrive");
  });

  it("no google_workspace.account → .mcp.json has NO gdrive entry", () => {
    const name = "carrie";
    const agentConfig = makeAgentConfig();
    const sc = cfg(name, agentConfig, {
      "you@example.com": { enabled_for: ["carrie"] },
    });

    const res = scaffoldAgent(name, agentConfig, tmpDir, telegramConfig, sc);
    const mcp = JSON.parse(
      readFileSync(join(res.agentDir, ".mcp.json"), "utf-8"),
    );
    expect(Object.keys(mcp.mcpServers)).not.toContain("gdrive");
  });
});
