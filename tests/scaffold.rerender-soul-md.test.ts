import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * Regression for v0.8.0 deployment discovery: SOUL.md was seeded via
 * `writeIfMissing` in seedWorkspaceBootstrapFiles, meaning the file
 * was written ONCE on first scaffold and frozen forever even if the
 * profile template `profiles/<profile>/workspace/SOUL.md.hbs` (the
 * canonical voice / persona source) changed in a later release.
 * The v0.8.0 "Never" AI-tells list expansion + bolding rule silently
 * bypassed every running agent — same failure shape as #1122 for
 * CLAUDE.md.
 *
 * Fix: SOUL.md uses the same fingerprint-aware re-render as CLAUDE.md.
 * Operator hand-edits are preserved as `.before-rerender.<ts>` backups.
 * The SOUL.custom.md sidecar (operator-owned additions) remains
 * writeIfMissing and is composed in by the render fn so additions
 * survive.
 *
 * These tests pin the new behaviour.
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

function soulPath(agentDir: string): string {
  return join(agentDir, "workspace", "SOUL.md");
}

describe("scaffoldAgent — SOUL.md rerender-on-template-change (v0.8.0)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scaffold-soul-rerender-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("first scaffold writes SOUL.md + fingerprint sidecar", () => {
    const config = makeAgentConfig();
    const result = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const soul = soulPath(result.agentDir);
    expect(existsSync(soul)).toBe(true);
    expect(existsSync(soul + ".fingerprint")).toBe(true);
    const fp = readFileSync(soul + ".fingerprint", "utf-8").trim();
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("second scaffold with unchanged template is a no-op", () => {
    const config = makeAgentConfig();
    const r1 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const soul = soulPath(r1.agentDir);
    const fp1 = readFileSync(soul + ".fingerprint", "utf-8");
    const content1 = readFileSync(soul, "utf-8");

    const r2 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    expect(r2.skipped).toContain(soul);
    expect(readFileSync(soul, "utf-8")).toBe(content1);
    expect(readFileSync(soul + ".fingerprint", "utf-8")).toBe(fp1);
  });

  it("template drift WITHOUT operator edits → file overwritten + fingerprint updated", () => {
    // First scaffold with one soul.style.
    const config = makeAgentConfig({ soul: { name: "Test", style: "concise" } });
    const r1 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const soul = soulPath(r1.agentDir);
    const original = readFileSync(soul, "utf-8");
    const fp1 = readFileSync(soul + ".fingerprint", "utf-8").trim();
    expect(original).toContain("concise");

    // Second scaffold with drifted persona content (different style).
    // Pre-fix (writeIfMissing) this would have been a no-op — file
    // never rewritten. Post-fix, the rendered drift propagates.
    const drifted = makeAgentConfig({ soul: { name: "Test", style: "verbose, formal, careful" } });
    const r2 = scaffoldAgent("a", drifted, tmpDir, telegramConfig, makeSwitchroomConfig("a", drifted));

    expect(r2.created).toContain(soul);
    const rewritten = readFileSync(soul, "utf-8");
    expect(rewritten).not.toBe(original);
    expect(rewritten).toContain("verbose, formal, careful");
    const fp2 = readFileSync(soul + ".fingerprint", "utf-8").trim();
    expect(fp2).not.toBe(fp1);

    // No backup should exist — operator didn't edit.
    const backups = readdirSync(join(r1.agentDir, "workspace")).filter((f) =>
      f.startsWith("SOUL.md.before-rerender."),
    );
    expect(backups).toHaveLength(0);
  });

  it("operator hand-edit + template drift → backup + overwrite", () => {
    const config = makeAgentConfig({ soul: { name: "Test", style: "concise" } });
    const r1 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const soul = soulPath(r1.agentDir);

    // Operator hand-edits SOUL.md (bypasses fingerprint).
    const handEdited = readFileSync(soul, "utf-8") + "\n\n## Operator note\nKeep this if possible.\n";
    writeFileSync(soul, handEdited, "utf-8");

    // Template drift triggers a rerender attempt.
    const drifted = makeAgentConfig({ soul: { name: "Test", style: "verbose, formal" } });
    const r2 = scaffoldAgent("a", drifted, tmpDir, telegramConfig, makeSwitchroomConfig("a", drifted));

    // File was rewritten with the new template...
    expect(readFileSync(soul, "utf-8")).toContain("verbose, formal");

    // ...AND a backup was created with the operator's edit intact.
    const backups = readdirSync(join(r1.agentDir, "workspace")).filter((f) =>
      f.startsWith("SOUL.md.before-rerender."),
    );
    expect(backups).toHaveLength(1);
    const backupContent = readFileSync(
      join(r1.agentDir, "workspace", backups[0]!),
      "utf-8",
    );
    expect(backupContent).toContain("Operator note");
  });

  it("legacy state (SOUL.md exists, no fingerprint) → backup + overwrite", () => {
    // Simulate pre-fix state: an agent scaffolded under the old
    // writeIfMissing regime — SOUL.md exists but no fingerprint
    // sidecar. The first apply post-upgrade should migrate cleanly:
    // back up the legacy file (operator may have edited), write the
    // new template, install the fingerprint.
    const config = makeAgentConfig();
    const r1 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const soul = soulPath(r1.agentDir);

    // Remove the fingerprint sidecar to simulate the pre-fix state.
    rmSync(soul + ".fingerprint");
    expect(existsSync(soul + ".fingerprint")).toBe(false);

    // Apply the same template again (no drift, but no fingerprint).
    // Test design choice: keep SOUL.md content equal so the rerender
    // logic takes the "refresh fingerprint, skip" path.
    const r2 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));

    // Fingerprint installed.
    expect(existsSync(soul + ".fingerprint")).toBe(true);
  });

  it("SOUL.custom.md sidecar is composed in and survives re-render", () => {
    const config = makeAgentConfig();
    const r1 = scaffoldAgent("a", config, tmpDir, telegramConfig, makeSwitchroomConfig("a", config));
    const soul = soulPath(r1.agentDir);
    const sidecar = join(r1.agentDir, "workspace", "SOUL.custom.md");

    // Operator writes a SOUL.custom.md sidecar with additions.
    writeFileSync(sidecar, "# Operator additions\n\nSpeak in haiku on Tuesdays.\n", "utf-8");

    // Re-apply with template drift to force a rerender.
    const drifted = makeAgentConfig({ soul: { name: "Test", style: "different" } });
    const r2 = scaffoldAgent("a", drifted, tmpDir, telegramConfig, makeSwitchroomConfig("a", drifted));

    // Rendered SOUL.md contains both the (drifted) template content
    // AND the operator sidecar additions.
    const rendered = readFileSync(soul, "utf-8");
    expect(rendered).toContain("different");
    expect(rendered).toContain("Speak in haiku on Tuesdays");

    // Sidecar file itself is untouched.
    expect(readFileSync(sidecar, "utf-8")).toContain("Operator additions");
  });
});
