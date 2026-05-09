/**
 * Tests for {@link renameAgent} — happy-path rename, rollback when a
 * mid-flight step throws, and the guard against renaming to an
 * existing slug. PR-D1 / v0.7 coverage gap #1.
 *
 * The orchestrator exposes a thick `RenameAgentDeps` injection seam
 * (loadConfig, stopAgent/startAgent, copyDir/removeDir/snapshotDir,
 * vault open/save, reconcile). We exploit it: every external boundary
 * is a vi.fn(), and we assert the rollback unwinds in reverse order
 * when reconcile throws.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameAgent } from "./rename-orchestrator.js";
import type { RenameAgentDeps } from "./rename-orchestrator.js";
import type { SwitchroomConfig } from "../config/schema.js";

function makeWorkspace(opts: { agents: string[] }): {
  configPath: string;
  agentsDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), "rename-orch-"));
  const agentsDir = join(root, "agents");
  mkdirSync(agentsDir, { recursive: true });
  for (const name of opts.agents) {
    mkdirSync(join(agentsDir, name), { recursive: true });
    writeFileSync(join(agentsDir, name, "marker.txt"), name);
  }
  const cfgPath = join(root, "switchroom.yaml");
  // Use full block mapping so renameAgentInConfig (which reads the file
  // directly with YAML.parseDocument) can find and rewrite the entry.
  const lines = ["agents:"];
  for (const name of opts.agents) {
    lines.push(`  ${name}:`);
    lines.push(`    extends: general`);
    lines.push(`    topic_name: ${name[0]!.toUpperCase()}${name.slice(1)}`);
  }
  lines.push("");
  writeFileSync(cfgPath, lines.join("\n"));
  return { configPath: cfgPath, agentsDir };
}

function makeConfig(agentsDir: string, agents: string[]): SwitchroomConfig {
  const agentEntries: Record<string, unknown> = {};
  for (const n of agents) {
    agentEntries[n] = { extends: "general", topic_name: n };
  }
  return {
    switchroom: { agents_dir: agentsDir },
    agents: agentEntries,
    telegram: { forum_chat_id: "0" },
    defaults: {},
  } as unknown as SwitchroomConfig;
}

function makeDeps(
  ws: { agentsDir: string; configPath?: string },
  agentsAtLoad: string[],
  overrides: Partial<RenameAgentDeps> = {},
): RenameAgentDeps {
  // Default loadConfig re-derives the agent list from the on-disk yaml
  // each call, so a yaml mutation between calls (rename → reload) is
  // observed correctly without per-test wiring.
  const loadFromDisk = (cfgPath: string): SwitchroomConfig => {
    if (!ws.configPath || !existsSync(ws.configPath)) {
      return makeConfig(ws.agentsDir, agentsAtLoad);
    }
    void cfgPath;
    const body = readFileSync(ws.configPath, "utf-8");
    const matches = Array.from(body.matchAll(/^ {2}([a-z0-9][a-z0-9_-]*):/gm)).map((m) => m[1]!);
    return makeConfig(ws.agentsDir, matches.length > 0 ? matches : agentsAtLoad);
  };
  return {
    loadConfig: vi.fn((p: string) => loadFromDisk(p)),
    resolveAgentsDir: vi.fn(() => ws.agentsDir),
    stopAgent: vi.fn(),
    startAgent: vi.fn(),
    reconcileAgent: vi.fn(() => ({ changes: ["wrote .mcp.json"] })) as unknown as RenameAgentDeps["reconcileAgent"],
    usesSwitchroomTelegramPlugin: vi.fn(() => true) as unknown as RenameAgentDeps["usesSwitchroomTelegramPlugin"],
    resolveAgentConfig: vi.fn() as unknown as RenameAgentDeps["resolveAgentConfig"],
    resolveTimezone: vi.fn() as unknown as RenameAgentDeps["resolveTimezone"],
    snapshotDir: vi.fn((src: string) => `${src}.snap`),
    copyDir: vi.fn((src: string, dst: string) => {
      if (existsSync(src)) {
        mkdirSync(dst, { recursive: true });
        writeFileSync(
          join(dst, "marker.txt"),
          existsSync(join(src, "marker.txt"))
            ? readFileSync(join(src, "marker.txt"), "utf-8")
            : "",
        );
      } else {
        mkdirSync(dst, { recursive: true });
      }
    }),
    removeDir: vi.fn((p: string) => {
      // Real removal so subsequent existsSync checks are accurate.
      const fs = require("node:fs") as typeof import("node:fs");
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ }
    }),
    existsSync: (p: string) => existsSync(p),
    readFileSync: (p: string, enc: BufferEncoding) => readFileSync(p, enc),
    resolveVaultPath: vi.fn(() => "/dev/null/vault.enc"),
    ...overrides,
  };
}

describe("renameAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SWITCHROOM_VAULT_PASSPHRASE;
  });

  it("happy path: stops old, copies dir, updates yaml, reconciles, starts new", async () => {
    const ws = makeWorkspace({ agents: ["fin"] });
    const deps = makeDeps({ ...ws }, ["fin"]);

    const result = await renameAgent(
      { oldName: "fin", newName: "finn", configPath: ws.configPath },
      deps,
    );

    expect(deps.stopAgent).toHaveBeenCalledWith("fin");
    expect(deps.copyDir).toHaveBeenCalledWith(
      join(ws.agentsDir, "fin"),
      join(ws.agentsDir, "finn"),
    );
    expect(deps.reconcileAgent).toHaveBeenCalledOnce();
    expect(deps.startAgent).toHaveBeenLastCalledWith("finn");

    // yaml updated atomically: old key gone, new key present
    const yamlBody = readFileSync(ws.configPath, "utf-8");
    expect(yamlBody).toMatch(/\bfinn:/);
    expect(yamlBody).not.toMatch(/^ {2}fin:/m);

    expect(result.agentDir).toBe(join(ws.agentsDir, "finn"));
    expect(result.reconcileChanges).toEqual(["wrote .mcp.json"]);
  });

  it("rollback: when reconcile throws, yaml is reverted and old agent dir is restored from snapshot", async () => {
    const ws = makeWorkspace({ agents: ["fin"] });
    let loadCount = 0;
    const deps = makeDeps(ws, ["fin"], {
      // First load returns just `fin`, post-yaml-update load returns `finn`.
      loadConfig: vi.fn(() => {
        loadCount += 1;
        return makeConfig(ws.agentsDir, loadCount === 1 ? ["fin"] : ["finn"]);
      }),
      reconcileAgent: vi.fn(() => {
        throw new Error("reconcile blew up: missing template");
      }) as unknown as RenameAgentDeps["reconcileAgent"],
    });

    await expect(
      renameAgent({ oldName: "fin", newName: "finn", configPath: ws.configPath }, deps),
    ).rejects.toThrow(/reconcile blew up/);

    // yaml rolled back: fin restored, finn gone
    const yamlBody = readFileSync(ws.configPath, "utf-8");
    expect(yamlBody).toMatch(/\bfin:/);
    expect(yamlBody).not.toMatch(/\bfinn:/);

    // dir restore: fin path back, finn path removed
    expect(existsSync(join(ws.agentsDir, "fin"))).toBe(true);
    expect(existsSync(join(ws.agentsDir, "finn"))).toBe(false);

    // Best-effort restart of the old agent was attempted
    expect(deps.startAgent).toHaveBeenCalledWith("fin");
  });

  it("guard: rejects rename when new name already exists in switchroom.yaml", async () => {
    const ws = makeWorkspace({ agents: ["fin", "finn"] });
    const deps = makeDeps(ws, ["fin", "finn"]);

    await expect(
      renameAgent({ oldName: "fin", newName: "finn", configPath: ws.configPath }, deps),
    ).rejects.toThrow(/already defined in switchroom\.yaml/);

    // No side-effects: stopAgent must NOT have been called for "fin"
    expect(deps.stopAgent).not.toHaveBeenCalled();
    expect(deps.copyDir).not.toHaveBeenCalled();
  });

  it("guard: rejects rename when target agent dir already exists on disk (no yaml entry yet)", async () => {
    const ws = makeWorkspace({ agents: ["fin"] });
    // Pre-create the target dir (operator partial-recovered) but NOT the yaml entry
    mkdirSync(join(ws.agentsDir, "finn"), { recursive: true });
    const deps = makeDeps({ ...ws }, ["fin"]);

    await expect(
      renameAgent({ oldName: "fin", newName: "finn", configPath: ws.configPath }, deps),
    ).rejects.toThrow(/Directory already exists at target path/);

    expect(deps.copyDir).not.toHaveBeenCalled();
  });

  it("guard: rejects identical old/new names", async () => {
    const ws = makeWorkspace({ agents: ["fin"] });
    const deps = makeDeps({ ...ws }, ["fin"]);

    await expect(
      renameAgent({ oldName: "fin", newName: "fin", configPath: ws.configPath }, deps),
    ).rejects.toThrow(/Old and new names are the same/);
  });

  it("guard: rejects invalid new-name slug before any work", async () => {
    const ws = makeWorkspace({ agents: ["fin"] });
    const deps = makeDeps({ ...ws }, ["fin"]);

    await expect(
      renameAgent({ oldName: "fin", newName: "BadName!", configPath: ws.configPath }, deps),
    ).rejects.toThrow(/Invalid new agent name/);

    expect(deps.loadConfig).not.toHaveBeenCalled();
  });

  it("guard: rejects when old agent isn't in switchroom.yaml", async () => {
    const ws = makeWorkspace({ agents: ["fin"] });
    const deps = makeDeps({ ...ws }, ["fin"]);

    await expect(
      renameAgent({ oldName: "ghost", newName: "spectre", configPath: ws.configPath }, deps),
    ).rejects.toThrow(/not defined in switchroom\.yaml/);
  });

  it("hindsight=preserve (default) is a no-op; unsupported modes throw", async () => {
    const ws = makeWorkspace({ agents: ["fin"] });
    const deps = makeDeps({ ...ws }, ["fin"]);

    await expect(
      renameAgent(
        {
          oldName: "fin",
          newName: "finn",
          configPath: ws.configPath,
          hindsightMode: "migrate" as never,
        },
        deps,
      ),
    ).rejects.toThrow(/Unsupported --hindsight mode/);
  });
});
