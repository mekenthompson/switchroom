import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

import {
  handleGetAccounts,
  handlePromoteAccount,
} from "../src/web/api.js";
import {
  writeAccountCredentials,
  writeAccountMeta,
} from "../src/auth/account-store.js";
import { writeAccountQuota } from "../src/auth/account-quota-store.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

let home: string;
let yamlPath: string;

const FAR_FUTURE = Date.now() + 24 * 60 * 60 * 1000;

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  home = resolve(tmpdir(), `switchroom-web-promote-${stamp}`);
  mkdirSync(home, { recursive: true });
  yamlPath = join(home, "switchroom.yaml");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function seedAccount(label: string) {
  writeAccountCredentials(
    label,
    {
      claudeAiOauth: {
        accessToken: "tok",
        refreshToken: "refresh",
        expiresAt: FAR_FUTURE,
        subscriptionType: "max",
      },
    },
    home,
  );
  writeAccountMeta(
    label,
    { createdAt: Date.now(), subscriptionType: "max" },
    home,
  );
}

function configWithAgents(
  agents: Record<string, string[]>,
): SwitchroomConfig {
  const out: Record<string, unknown> = {};
  for (const [name, accounts] of Object.entries(agents)) {
    out[name] = {
      topic_name: name,
      schedule: [],
      auth: { accounts },
    };
  }
  // Override the default `agents_dir` to point inside our tmp home so
  // resolveAgentsDir doesn't try to write under the real ~/.switchroom.
  return {
    switchroom: { agents_dir: join(home, "agents") },
    agents: out,
  } as unknown as SwitchroomConfig;
}

function writeYaml(agents: Record<string, string[]>): void {
  // Minimal YAML mirroring the structure auth-accounts-yaml expects.
  const lines: string[] = ["agents:"];
  for (const [name, accounts] of Object.entries(agents)) {
    lines.push(`  ${name}:`);
    lines.push(`    topic_name: ${name}`);
    lines.push(`    auth:`);
    lines.push(`      accounts:`);
    for (const a of accounts) lines.push(`        - ${a}`);
  }
  writeFileSync(yamlPath, lines.join("\n") + "\n");
}

describe("handleGetAccounts (with config) — primary/fallback split", () => {
  it("splits agents into primaryFor / fallbackFor based on slot 0", () => {
    seedAccount("alpha");
    seedAccount("beta");
    const cfg = configWithAgents({
      clerk: ["alpha", "beta"],
      finn: ["beta", "alpha"],
      gymbro: ["alpha"],
    });
    const out = handleGetAccounts(cfg, home);
    const alpha = out.find((a) => a.label === "alpha");
    const beta = out.find((a) => a.label === "beta");
    expect(alpha?.primaryFor.sort()).toEqual(["clerk", "gymbro"]);
    expect(alpha?.fallbackFor).toEqual(["finn"]);
    expect(beta?.primaryFor).toEqual(["finn"]);
    expect(beta?.fallbackFor).toEqual(["clerk"]);
  });

  it("attaches quota snapshot when present, null otherwise", () => {
    seedAccount("alpha");
    seedAccount("beta");
    writeAccountQuota(
      "alpha",
      {
        capturedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        fiveHourPct: 42,
        sevenDayPct: 7,
        fiveHourResetAt: null,
        sevenDayResetAt: null,
      },
      home,
    );
    const cfg = configWithAgents({ clerk: ["alpha"], finn: ["beta"] });
    const out = handleGetAccounts(cfg, home);
    const alpha = out.find((a) => a.label === "alpha");
    const beta = out.find((a) => a.label === "beta");
    expect(alpha?.quota?.fiveHourPct).toBe(42);
    expect(beta?.quota).toBeNull();
  });
});

describe("handlePromoteAccount", () => {
  it("returns ok with promoted agent on happy path", () => {
    seedAccount("alpha");
    seedAccount("beta");
    writeYaml({ clerk: ["alpha", "beta"] });
    const cfg = configWithAgents({ clerk: ["alpha", "beta"] });
    // Must create the agent dir so fanout doesn't 'no-agent-dir' (still ok,
    // but we want a "fanned" outcome to verify the wiring).
    mkdirSync(join(home, "agents", "clerk"), { recursive: true });
    const result = handlePromoteAccount(cfg, yamlPath, "beta", ["clerk"], home);
    expect(result.ok).toBe(true);
    expect(result.promoted).toEqual(["clerk"]);
    // YAML actually rewritten with beta first.
    const after = readFileSync(yamlPath, "utf-8");
    const clerkBlock = after.split("clerk:")[1];
    expect(clerkBlock.indexOf("- beta")).toBeLessThan(clerkBlock.indexOf("- alpha"));
  });

  it("returns ok with alreadyPrimary when label is already at slot 0", () => {
    seedAccount("alpha");
    writeYaml({ clerk: ["alpha"] });
    const cfg = configWithAgents({ clerk: ["alpha"] });
    const result = handlePromoteAccount(cfg, yamlPath, "alpha", ["clerk"], home);
    expect(result.ok).toBe(true);
    expect(result.promoted).toEqual([]);
    expect(result.alreadyPrimary).toEqual(["clerk"]);
  });

  it("returns ok=false when account is not enabled on the agent", () => {
    seedAccount("alpha");
    seedAccount("beta");
    writeYaml({ clerk: ["alpha"] });
    const cfg = configWithAgents({ clerk: ["alpha"] });
    const result = handlePromoteAccount(cfg, yamlPath, "beta", ["clerk"], home);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not enabled on agent 'clerk'/);
  });

  it("returns ok=false when the account does not exist on disk", () => {
    writeYaml({ clerk: ["ghost"] });
    const cfg = configWithAgents({ clerk: ["ghost"] });
    const result = handlePromoteAccount(cfg, yamlPath, "ghost", ["clerk"], home);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not exist/);
  });
});
