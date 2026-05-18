import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TOOLS } from "./server.js";

describe("agent-config MCP server — Phase 2a publish tools", () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

  it("registers skill_publish and skill_unpublish", () => {
    expect(byName.skill_publish).toBeDefined();
    expect(byName.skill_unpublish).toBeDefined();
  });

  it("both require only `name` and accept optional `agent` (no scope arg)", () => {
    for (const n of ["skill_publish", "skill_unpublish"]) {
      const t = byName[n]!;
      expect(t.inputSchema.required).toEqual(["name"]);
      expect(Object.keys(t.inputSchema.properties)).toEqual(
        expect.arrayContaining(["name", "agent"]),
      );
      // Publish is inherently agent→global; there is deliberately no
      // scope selector (unlike the deprecated skill_create/edit/delete).
      expect(t.inputSchema.properties).not.toHaveProperty("scope");
    }
  });

  it("descriptions document the marker gate and admin requirement", () => {
    expect(byName.skill_publish!.description).toMatch(/admin/i);
    expect(byName.skill_publish!.description).toMatch(/E_SKILL_OPERATOR_OWNED/);
    expect(byName.skill_publish!.description).toMatch(/replace-by-publish/i);
    expect(byName.skill_unpublish!.description).toMatch(
      /E_SKILL_OPERATOR_OWNED/,
    );
  });

  it("appear after skill_delete (ordering kept stable)", () => {
    const names = TOOLS.map((t) => t.name);
    const del = names.indexOf("skill_delete");
    expect(names.indexOf("skill_publish")).toBeGreaterThan(del);
    expect(names.indexOf("skill_unpublish")).toBeGreaterThan(
      names.indexOf("skill_publish"),
    );
  });

  // #1492-class guard: prove `skill publish` is a real wired CLI verb
  // whose failure path emits a clean JSON error (not the CLI version
  // string, not opaque non-JSON) — the exact shim defect #1492 was.
  it("E2E: `skill publish` is wired and fails cleanly with JSON on stderr", () => {
    const which = spawnSync("which", ["bun"], { encoding: "utf-8" });
    if (which.status !== 0) return;
    const cliEntry = join(process.cwd(), "bin", "switchroom.ts");
    if (!existsSync(cliEntry)) return;
    const tmp = mkdtempSync(join(tmpdir(), "skill-publish-e2e-"));
    try {
      const r = spawnSync(
        "bun",
        [cliEntry, "skill", "publish", "--name", "ghost"],
        {
          encoding: "utf-8",
          env: { ...process.env, HOME: tmp, SWITCHROOM_AGENT_NAME: "alice" },
          timeout: 30000,
        },
      );
      // Non-zero exit (no such skill / not admin), and stderr is a
      // parseable {code,message} — NOT a version string, NOT a JSON
      // parse error.
      expect(r.status).not.toBe(0);
      expect(r.stdout.trim()).toBe("");
      const err = JSON.parse(r.stderr.trim());
      expect(typeof err.code).toBe("string");
      expect(err.code).toMatch(/^E_SKILL_|^E_AGENT_/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
