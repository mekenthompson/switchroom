/**
 * Tests for skill_install / skill_remove (#1163 Phase 2).
 *
 * Mirrors agent-config-write.test.ts (schedule_add / schedule_remove)
 * — fakeAgent + tmp overlay root + bundled-skills-pool fixture, no
 * real reconcile, no real filesystem outside the tmp tree.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { skillInstall, skillRemove, MAX_SKILLS_PER_AGENT } from "./agent-config-skill-write.js";

let tmpRoot: string;
let tmpPool: string;
const FAKE_AGENT = "test-agent";

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "skill-write-root-"));
  tmpPool = mkdtempSync(join(tmpdir(), "skill-write-pool-"));
  // Seed a few bundled skills in the pool so install can find them.
  for (const name of ["webapp-testing", "pdf", "skill-creator"]) {
    mkdirSync(join(tmpPool, name), { recursive: true });
    writeFileSync(join(tmpPool, name, "SKILL.md"), "stub", "utf-8");
  }
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(tmpPool, { recursive: true, force: true });
});

function install(args: Partial<Parameters<typeof skillInstall>[0]> = {}) {
  return skillInstall({
    agent: FAKE_AGENT,
    source: "bundled:webapp-testing",
    root: tmpRoot,
    bundledSkillsPoolDir: tmpPool,
    reconcile: null, // tests skip reconcile
    ...args,
  });
}

describe("skillInstall — happy path", () => {
  it("writes an overlay YAML with the expected skill name", () => {
    const r = install();
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    expect(r.resolved_skill_name).toBe("webapp-testing");
    expect(r.slug).toBe("webapp-testing");
    expect(r.source).toBe("bundled:webapp-testing");
    expect(r.path).toMatch(/skills\.d\/webapp-testing\.yaml$/);

    // Verify on-disk content
    const content = readFileSync(r.path, "utf-8");
    expect(content).toContain("skills:");
    expect(content).toContain("webapp-testing");
  });

  it("returns a restart-required readback naming the agent", () => {
    const r = install();
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    expect(r.restart_required).toBe(true);
    expect(r.restart_hint).toContain("test-agent");
    expect(r.restart_hint).toMatch(/restart/i);
  });

  it("uses opts.name as the slug when provided", () => {
    const r = install({ source: "bundled:pdf", name: "my-pdf-skill" });
    if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
    expect(r.slug).toBe("my-pdf-skill");
    expect(r.resolved_skill_name).toBe("pdf");
    expect(r.path).toMatch(/skills\.d\/my-pdf-skill\.yaml$/);
  });

  it("supports multiple installs side-by-side", () => {
    const a = install({ source: "bundled:webapp-testing" });
    const b = install({ source: "bundled:pdf" });
    const c = install({ source: "bundled:skill-creator" });
    expect(a.ok && b.ok && c.ok).toBe(true);
    const files = readdirSync(join(tmpRoot, FAKE_AGENT, "skills.d")).sort();
    expect(files.filter((f) => f.endsWith(".yaml")).sort()).toEqual([
      "pdf.yaml",
      "skill-creator.yaml",
      "webapp-testing.yaml",
    ]);
  });
});

describe("skillInstall — source validation", () => {
  it("rejects file:// sources with E_SKILL_SOURCE_NOT_SUPPORTED", () => {
    const r = install({ source: "file:///opt/skills/sneaky" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_SOURCE_NOT_SUPPORTED");
    expect(r.exit).toBe(9);
    expect(r.message).toContain("file://");
  });

  it("rejects git+https sources in v1 (deferred to follow-up)", () => {
    const r = install({ source: "git+https://github.com/user/repo@abc123" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_SOURCE_NOT_SUPPORTED");
    expect(r.message).toMatch(/deferred|follow-up|git/i);
  });

  it("rejects empty source", () => {
    const r = install({ source: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_SOURCE_NOT_SUPPORTED");
  });

  it("rejects bundled:<name> with invalid skill name characters", () => {
    const r = install({ source: "bundled:has spaces" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_INVALID_SKILL_NAME");
    expect(r.exit).toBe(1);
  });

  it("rejects bundled:<name> when the named skill doesn't exist in pool", () => {
    const r = install({ source: "bundled:nonexistent-skill" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_NOT_FOUND");
    expect(r.exit).toBe(9);
    expect(r.message).toContain("nonexistent-skill");
  });
});

describe("skillInstall — quota", () => {
  it("rejects with E_SKILL_QUOTA_EXCEEDED at MAX_SKILLS_PER_AGENT", () => {
    expect(MAX_SKILLS_PER_AGENT).toBe(20);
    // Seed 20 bundled skills + 20 install attempts to hit the cap.
    const installed: string[] = [];
    for (let i = 0; i < MAX_SKILLS_PER_AGENT; i++) {
      const name = `bulk-${i}`;
      mkdirSync(join(tmpPool, name), { recursive: true });
      writeFileSync(join(tmpPool, name, "SKILL.md"), "stub", "utf-8");
      const r = install({ source: `bundled:${name}`, name });
      expect(r.ok).toBe(true);
      installed.push(name);
    }
    // 21st should fail
    const overflow = "bulk-overflow";
    mkdirSync(join(tmpPool, overflow), { recursive: true });
    writeFileSync(join(tmpPool, overflow, "SKILL.md"), "stub", "utf-8");
    const r = install({ source: `bundled:${overflow}` });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_SKILL_QUOTA_EXCEEDED");
    expect(r.exit).toBe(9);
    expect(r.message).toContain("20");
  });
});

describe("skillRemove", () => {
  it("removes an installed skill by slug", () => {
    const i = install();
    expect(i.ok).toBe(true);
    if (!i.ok) return;
    const r = skillRemove({
      agent: FAKE_AGENT,
      name: i.slug,
      root: tmpRoot,
      reconcile: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slug).toBe(i.slug);
    expect(r.restart_required).toBe(true);
    expect(r.restart_hint).toContain("test-agent");
    const files = readdirSync(join(tmpRoot, FAKE_AGENT, "skills.d")).filter((f) => f.endsWith(".yaml"));
    expect(files).toEqual([]);
  });

  it("returns E_NOT_FOUND when the slug doesn't match an overlay", () => {
    const r = skillRemove({
      agent: FAKE_AGENT,
      name: "never-installed",
      root: tmpRoot,
      reconcile: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_NOT_FOUND");
    expect(r.exit).toBe(1);
  });

  it("rejects invalid slug characters", () => {
    const r = skillRemove({
      agent: FAKE_AGENT,
      name: "has spaces",
      root: tmpRoot,
      reconcile: null,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_INVALID_SKILL_NAME");
  });
});

describe("skillInstall — reconcile rollback (#1197 pattern)", () => {
  it("rolls back the overlay write when reconcile fails", () => {
    const r = install({
      reconcile: () => ({ ok: false, error: "simulated reconcile failure" }),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("E_RECONCILE_FAILED");
    expect(r.exit).toBe(10);
    expect(r.message).toContain("simulated reconcile failure");
    // The overlay file should be gone (rolled back).
    const dir = join(tmpRoot, FAKE_AGENT, "skills.d");
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    expect(files).toEqual([]);
  });

  it("commits the overlay write when reconcile succeeds", () => {
    const r = install({
      // ReconcileFn returns ReconcileBridgeResult | ReconcileBridgeError;
      // the stub just needs the `ok: true` discriminator for our code
      // path. The stub omits the ReconcileBridgeResult fields
      // (changes / cronScripts) — they aren't read by skill_install's
      // success branch. `as never` keeps tsc quiet about the partial
      // shape; this is a test-only test-double, not a contract leak.
      reconcile: (() => ({ ok: true })) as never,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dir = join(tmpRoot, FAKE_AGENT, "skills.d");
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml"));
    expect(files).toEqual(["webapp-testing.yaml"]);
  });
});
