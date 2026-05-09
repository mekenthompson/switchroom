import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runApply, runApplyPreflight } from "./apply.js";
import * as scaffoldModule from "../agents/scaffold.js";
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

  describe("UID alignment failure handling", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let scaffoldSpy: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let alignSpy: any;

    beforeEach(() => {
      // Force scaffoldAgent to look like it succeeded so we reach the
      // alignAgentUid call site. The real scaffoldAgent needs a fully
      // wired profile / telegram config which is out of scope here.
      // Note: do NOT mockReset/mockClear these spies between tests —
      // that wipes the implementation and the real function runs again.
      scaffoldSpy = vi
        .spyOn(scaffoldModule, "scaffoldAgent")
        .mockImplementation(
          () => ({ created: ["fake.txt"] }) as never,
        );
      alignSpy = vi
        .spyOn(scaffoldModule, "alignAgentUid")
        .mockImplementation(() => {
          throw new Error("simulated chown EPERM");
        });
    });

    afterEach(() => {
      scaffoldSpy.mockRestore();
      alignSpy.mockRestore();
    });

    it("fails hard by default when chown fails", async () => {
      const dir = await mkdtemp(join(tmpdir(), "switchroom-apply-fail-"));
      const sink: string[] = [];
      await expect(
        runApply(
          makeStubConfig(join(dir, "agents")),
          { outPath: join(dir, "docker-compose.yml") },
          { writeOut: (s) => sink.push(s), writeErr: (s) => sink.push(s) },
        ),
      ).rejects.toThrow(/UID alignment failed|allow-unaligned/i);
      const all = sink.join("");
      expect(all).toMatch(/could not chown/);
      expect(all).toMatch(/--allow-unaligned/);
    });

    it("warns and continues when --allow-unaligned is passed", async () => {
      const dir = await mkdtemp(join(tmpdir(), "switchroom-apply-allow-"));
      const sink: string[] = [];
      const res = await runApply(
        makeStubConfig(join(dir, "agents")),
        {
          outPath: join(dir, "docker-compose.yml"),
          allowUnaligned: true,
        },
        { writeOut: (s) => sink.push(s), writeErr: (s) => sink.push(s) },
      );
      expect(res.scaffolded).toBe(1);
      const all = sink.join("");
      expect(all).toMatch(/could not chown/);
      expect(all).toMatch(/continuing/i);
    });
  });

  describe("compose v2 preflight", () => {
    const realPath = process.env.PATH;

    afterEach(() => {
      process.env.PATH = realPath;
    });

    it("preflight throws with friendly message when `docker compose` v2 is missing", () => {
      // Empty PATH so `docker` is not findable — execFileSync throws,
      // detectComposeV2 returns the friendly error string.
      process.env.PATH = "/nonexistent-switchroom-test-path";
      const cfg = makeStubConfig("/tmp/agents");
      expect(() => runApplyPreflight(cfg)).toThrow(
        /docker compose.*v2|Compose v2 plugin/i,
      );
    });
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

  describe("--only=<agent> (v0.7.7 — one-at-a-time cutover)", () => {
    // The full v0.6 → v0.7 cutover chowns every agent's state dir to a
    // per-agent UID; that breaks the systemd-managed siblings until
    // they're stopped. --only=<name> scopes scaffold + chown to one
    // agent so siblings keep running while operators migrate piecemeal.
    function multiAgentConfig(agentsDir: string): SwitchroomConfig {
      return {
        agents: {
          alice: { profile: "engineer", claudeAccount: "default" },
          bob: { profile: "engineer", claudeAccount: "default" },
          carol: { profile: "engineer", claudeAccount: "default" },
        },
        profiles: {},
        defaults: {},
        switchroom: { agents_dir: agentsDir },
        telegram: { forum_chat_id: "0" },
      } as unknown as SwitchroomConfig;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let scaffoldSpy: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let alignSpy: any;

    beforeEach(() => {
      scaffoldSpy = vi
        .spyOn(scaffoldModule, "scaffoldAgent")
        .mockImplementation(() => ({ created: [] }) as never);
      alignSpy = vi
        .spyOn(scaffoldModule, "alignAgentUid")
        .mockImplementation(() => ({ chowned: true, paths: [] }));
    });

    afterEach(() => {
      scaffoldSpy.mockRestore();
      alignSpy.mockRestore();
    });

    it("scaffolds + aligns only the named agent (siblings untouched)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "switchroom-apply-only-"));
      const outPath = join(dir, "docker-compose.yml");

      await runApply(
        multiAgentConfig(join(dir, "agents")),
        { outPath, only: "bob", nonInteractive: true },
        { writeOut: () => {}, writeErr: () => {} },
      );

      // Only `bob` got scaffolded + aligned — alice and carol are
      // still on whatever state they had before (presumably v0.6 systemd).
      expect(scaffoldSpy).toHaveBeenCalledTimes(1);
      expect(scaffoldSpy.mock.calls[0]![0]).toBe("bob");
      expect(alignSpy).toHaveBeenCalledTimes(1);
      expect(alignSpy.mock.calls[0]![0]).toBe("bob");
    });

    it("regenerates compose for the FULL fleet even with --only", async () => {
      // Compose still needs every agent in YAML for the broker/kernel
      // per-agent socket volumes to be emitted. Otherwise --only=alice
      // would silently strip bob/carol from the compose and break their
      // post-cutover sockets.
      const dir = await mkdtemp(join(tmpdir(), "switchroom-apply-only-"));
      const outPath = join(dir, "docker-compose.yml");

      const res = await runApply(
        multiAgentConfig(join(dir, "agents")),
        { outPath, only: "alice", nonInteractive: true },
        { writeOut: () => {}, writeErr: () => {} },
      );

      const composeYml = await readFile(outPath, "utf-8");
      // All three agent services in the compose, regardless of --only.
      expect(composeYml).toMatch(/agent-alice:/);
      expect(composeYml).toMatch(/agent-bob:/);
      expect(composeYml).toMatch(/agent-carol:/);
      // agentsTotal still reflects the YAML, not the --only narrow.
      expect(res.agentsTotal).toBe(3);
    });

    it("rejects --only=<unknown-name> with an actionable error", async () => {
      const dir = await mkdtemp(join(tmpdir(), "switchroom-apply-only-"));
      const outPath = join(dir, "docker-compose.yml");

      await expect(
        runApply(
          multiAgentConfig(join(dir, "agents")),
          { outPath, only: "frank", nonInteractive: true },
          { writeOut: () => {}, writeErr: () => {} },
        ),
      ).rejects.toThrow(/--only=frank.*no such agent/);
    });
  });
});
