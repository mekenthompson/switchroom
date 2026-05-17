import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scaffoldAgent,
  reconcileAgent,
  renderSoulMd,
} from "../src/agents/scaffold.js";
import { getProfilePath } from "../src/agents/profiles.js";
import type {
  AgentConfig,
  SwitchroomConfig,
  TelegramConfig,
} from "../src/config/schema.js";

/**
 * SOUL.md is user-owned: seeded ONCE from the profile template +
 * `soul:` config (or the setup wizard), then never overwritten by
 * scaffold / reconcile / update. This is the deliberate inverse of the
 * root CLAUDE.md (switchroom-managed, fingerprint re-render). The
 * `soul:` config + profile SOUL.md.hbs are seed-time inputs only.
 *
 * `switchroom soul reset` is the explicit re-seed path (covered by the
 * CLI test). These tests pin the seed-once contract at the scaffold /
 * reconcile layer.
 */

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    soul: {
      name: "Test",
      style: "concise",
    },
    ...overrides,
  } as AgentConfig;
}

function makeSwitchroomConfig(
  name: string,
  agentConfig: AgentConfig,
): SwitchroomConfig {
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

function soulPath(agentDir: string): string {
  return join(agentDir, "workspace", "SOUL.md");
}

function backups(agentDir: string): string[] {
  return readdirSync(join(agentDir, "workspace")).filter((f) =>
    f.startsWith("SOUL.md.before-rerender."),
  );
}

describe("SOUL.md is user-owned (seed-once)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "soul-user-owned-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("first scaffold seeds SOUL.md from soul config", () => {
    const config = makeAgentConfig({
      soul: { name: "Test", style: "concise" },
    });
    const r = scaffoldAgent(
      "a",
      config,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", config),
    );
    const soul = soulPath(r.agentDir);
    expect(existsSync(soul)).toBe(true);
    expect(readFileSync(soul, "utf-8")).toContain("concise");
  });

  it("does NOT write a fingerprint sidecar for SOUL.md (writeIfMissing, not managed)", () => {
    const config = makeAgentConfig();
    const r = scaffoldAgent(
      "a",
      config,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", config),
    );
    expect(existsSync(soulPath(r.agentDir) + ".fingerprint")).toBe(false);
  });

  it("config drift on re-scaffold does NOT change an existing SOUL.md", () => {
    const config = makeAgentConfig({
      soul: { name: "Test", style: "concise" },
    });
    const r1 = scaffoldAgent(
      "a",
      config,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", config),
    );
    const soul = soulPath(r1.agentDir);
    const original = readFileSync(soul, "utf-8");
    expect(original).toContain("concise");

    // Change the persona config and re-scaffold. Seed-once means the
    // already-seeded SOUL.md is left exactly as-is.
    const drifted = makeAgentConfig({
      soul: { name: "Test", style: "verbose, formal, careful" },
    });
    const r2 = scaffoldAgent(
      "a",
      drifted,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", drifted),
    );

    expect(r2.skipped).toContain(soul);
    expect(readFileSync(soul, "utf-8")).toBe(original);
    expect(readFileSync(soul, "utf-8")).not.toContain("verbose, formal");
    expect(backups(r1.agentDir)).toHaveLength(0);
  });

  it("operator hand-edits survive re-scaffold (no clobber, no backup)", () => {
    const config = makeAgentConfig();
    const r1 = scaffoldAgent(
      "a",
      config,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", config),
    );
    const soul = soulPath(r1.agentDir);
    const handEdited =
      readFileSync(soul, "utf-8") +
      "\n\n## Operator note\nKeep this verbatim.\n";
    writeFileSync(soul, handEdited, "utf-8");

    const drifted = makeAgentConfig({
      soul: { name: "Test", style: "totally different" },
    });
    scaffoldAgent(
      "a",
      drifted,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", drifted),
    );

    expect(readFileSync(soul, "utf-8")).toBe(handEdited);
    expect(backups(r1.agentDir)).toHaveLength(0);
  });

  it("reconcile preserves a hand-edited SOUL.md even when soul config changes", () => {
    const config = makeAgentConfig({
      soul: { name: "Coach", style: "motivational" },
    });
    const r1 = scaffoldAgent(
      "a",
      config,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", config),
    );
    const soul = soulPath(r1.agentDir);
    const edited = readFileSync(soul, "utf-8") + "\n\n## Mine\nDon't touch.\n";
    writeFileSync(soul, edited, "utf-8");

    const changed = makeAgentConfig({
      soul: { name: "Assistant", style: "concise, technical" },
    });
    reconcileAgent(
      "a",
      changed,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", changed),
    );

    const after = readFileSync(soul, "utf-8");
    expect(after).toBe(edited);
    expect(after).toContain("## Mine");
    expect(after).not.toContain("concise, technical");
  });

  it("reconcile re-seeds SOUL.md if it is missing (recovery / first-create-on-reconcile)", () => {
    const config = makeAgentConfig({
      soul: { name: "Test", style: "concise" },
    });
    const r1 = scaffoldAgent(
      "a",
      config,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", config),
    );
    const soul = soulPath(r1.agentDir);
    rmSync(soul);
    expect(existsSync(soul)).toBe(false);

    reconcileAgent(
      "a",
      config,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", config),
    );

    expect(existsSync(soul)).toBe(true);
    expect(readFileSync(soul, "utf-8")).toContain("concise");
  });

  it("SOUL.custom.md present BEFORE first scaffold is folded into the seed", () => {
    const config = makeAgentConfig();
    // Pre-create the agent workspace + sidecar so the first seed folds
    // it in (mirrors an operator dropping a sidecar before setup).
    const agentDir = join(tmpDir, "a");
    const wsDir = join(agentDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      join(wsDir, "SOUL.custom.md"),
      "# Operator additions\n\nSpeak in haiku on Tuesdays.\n",
      "utf-8",
    );

    const r = scaffoldAgent(
      "a",
      config,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", config),
    );
    const rendered = readFileSync(soulPath(r.agentDir), "utf-8");
    expect(rendered).toContain("Speak in haiku on Tuesdays");
    expect(rendered).toContain("---");
  });

  it("renderSoulMd composes the profile template with the SOUL.custom.md sidecar", () => {
    const config = makeAgentConfig({
      soul: { name: "Test", style: "punchy" },
    });
    const r = scaffoldAgent(
      "a",
      config,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig("a", config),
    );
    const wsDir = join(r.agentDir, "workspace");
    writeFileSync(
      join(wsDir, "SOUL.custom.md"),
      "## Extra\nReset folds this in.\n",
      "utf-8",
    );

    const out = renderSoulMd(getProfilePath("default"), wsDir, {
      name: "Test",
      style: "punchy",
    });
    expect(out).not.toBeNull();
    expect(out!).toContain("punchy");
    expect(out!).toContain("Reset folds this in.");
  });
});
