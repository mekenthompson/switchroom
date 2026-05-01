/**
 * WS5 of #543 / closes #84: plugin install on-ramp.
 *
 * The switchroom Claude Code plugin advertises four slash commands —
 * /switchroom:setup, /switchroom:start, /switchroom:stop, /switchroom:status —
 * via `commands/*.md` at the plugin root. These tests pin the manifest +
 * command file shape so a future edit can't silently break the on-ramp
 * surface a fresh user sees after `/plugin install switchroom@switchroom`.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

const REPO_ROOT = resolve(__dirname, "..");

function readCommand(name: string): { frontmatter: string; body: string } {
  const path = join(REPO_ROOT, "commands", `${name}.md`);
  expect(existsSync(path)).toBe(true);
  const text = readFileSync(path, "utf-8");
  // Frontmatter is bounded by --- on the first line and --- on a later line.
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  expect(m, `commands/${name}.md must have YAML frontmatter`).not.toBeNull();
  return { frontmatter: m![1], body: m![2] };
}

describe("switchroom plugin on-ramp (#84, #543 WS5)", () => {
  it("plugin.json bumped to advertise commands surface", () => {
    const path = join(REPO_ROOT, ".claude-plugin", "plugin.json");
    const m = JSON.parse(readFileSync(path, "utf-8"));
    expect(m.name).toBe("switchroom");
    // Version must be ≥ 0.2.0 — the cut that introduces /switchroom:* commands.
    const [maj, min] = String(m.version).split(".").map((n) => parseInt(n, 10));
    expect(Number.isFinite(maj) && Number.isFinite(min)).toBe(true);
    expect(maj > 0 || (maj === 0 && min >= 2)).toBe(true);
  });

  it("ships the four /switchroom:* slash commands", () => {
    for (const name of ["setup", "start", "stop", "status"]) {
      const { frontmatter, body } = readCommand(name);
      // Every command must declare a description so /help renders cleanly.
      expect(frontmatter).toMatch(/^description:\s*\S/m);
      // Body must be non-trivial — these are operator-facing playbooks, not stubs.
      expect(body.trim().length).toBeGreaterThan(200);
    }
  });

  it("setup command covers the Phase 0 on-ramp shape", () => {
    const { body } = readCommand("setup");
    // Must reference the canonical wizard verbs the user lands on after install.
    expect(body).toMatch(/switchroom\s+setup/);
    expect(body).toMatch(/switchroom\s+agent\s+(start|list)/);
    // Must mention BotFather — the unavoidable human-in-the-loop step.
    expect(body.toLowerCase()).toContain("botfather");
  });

  it("start, stop, status commands route through the canonical CLI", () => {
    expect(readCommand("start").body).toMatch(/switchroom\s+agent\s+start/);
    expect(readCommand("stop").body).toMatch(/switchroom\s+agent\s+stop/);
    expect(readCommand("status").body).toMatch(/switchroom\s+agent\s+list/);
  });

  it("marketplace.json source path still resolves and lists switchroom plugin", () => {
    const path = join(REPO_ROOT, ".claude-plugin", "marketplace.json");
    const m = JSON.parse(readFileSync(path, "utf-8")) as {
      plugins: Array<{ name: string; source: string }>;
    };
    const sw = m.plugins.find((p) => p.name === "switchroom");
    expect(sw).toBeDefined();
    expect(existsSync(resolve(REPO_ROOT, sw!.source))).toBe(true);
    // The plugin root is the repo root, so commands/ must live there.
    expect(existsSync(resolve(REPO_ROOT, sw!.source, "commands"))).toBe(true);
  });
});
