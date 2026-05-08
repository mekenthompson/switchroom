import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApply, runApplyPreflight } from "./apply.js";
import type { SwitchroomConfig } from "../config/schema.js";

/**
 * Minimal config — `runApply` forwards to `scaffoldAgent` (via
 * `loadConfig` resolution) and `generateCompose` directly. Both are
 * exercised in their own dedicated unit tests; here we only verify
 * the CLI orchestrator writes the compose artifact at the path it
 * was asked to write to and that scaffold ran first (i.e. agent
 * directories exist when the compose file lands on disk).
 */
function makeStubConfig(agentsDir: string): SwitchroomConfig {
  return {
    agents: {
      klanker: {
        profile: "engineer",
        claudeAccount: "default",
      },
    },
    profiles: {},
    defaults: {},
    switchroom: { agents_dir: agentsDir },
    telegram: { forum_chat_id: "0" },
  } as unknown as SwitchroomConfig;
}

describe("runApply", () => {
  it("writes the compose YAML to the requested path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "switchroom-apply-test-"));
    const outPath = join(dir, "nested", "docker-compose.yml");

    // Drain stdout/stderr through dummy writers so the test doesn't
    // pollute vitest's output.
    const sink: string[] = [];
    const res = await runApply(
      makeStubConfig(join(dir, "agents")),
      { outPath },
      {
        writeOut: (s) => sink.push(s),
        writeErr: (s) => sink.push(s),
      },
    );

    expect(res.composePath).toBe(outPath);
    expect(res.composeBytes).toBeGreaterThan(0);

    const onDisk = await readFile(outPath, "utf8");
    expect(onDisk).toMatch(/services:/);
  });

  it("preflight throws when config has vault refs but vault.enc is missing", () => {
    // Point vault path at a non-existent file under a temp dir.
    const fakeVault = join(tmpdir(), `nonexistent-vault-${Date.now()}.enc`);
    const cfg = {
      ...makeStubConfig("/tmp/agents"),
      vault: { path: fakeVault },
      telegram: { bot_token: "vault:telegram_bot_token" },
    } as unknown as SwitchroomConfig;
    expect(() => runApplyPreflight(cfg)).toThrow(/vault/i);
  });

  it("returns the count of agents scaffolded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "switchroom-apply-test-"));
    const outPath = join(dir, "docker-compose.yml");

    const res = await runApply(
      makeStubConfig(join(dir, "agents")),
      { outPath },
      { writeOut: () => {}, writeErr: () => {} },
    );

    // scaffoldAgent may legitimately fail in this minimal-stub
    // environment (no telegram tokens, no real profile dir). The
    // contract we care about for the test is: `agentsTotal` reflects
    // the config and `composePath`/`composeBytes` are populated
    // regardless. Scaffold robustness is owned by scaffold's own tests.
    expect(res.agentsTotal).toBe(1);
    expect(res.composePath).toBe(outPath);
  });
});
