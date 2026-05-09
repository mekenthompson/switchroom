/**
 * Pure-function tests for the Phase 1a compose generator.
 *
 * Coverage targets (≥15 cases per the dispatch brief):
 *   - empty fleet
 *   - single agent
 *   - multi-agent fleet (sorted output)
 *   - klanker resource defaults
 *   - conversational profile defaults
 *   - lightweight profile defaults
 *   - coding profile defaults
 *   - unknown profile falls through to default
 *   - cap_add stripped + warning emitted
 *   - per-agent socket volume isolation invariant
 *   - byte-determinism for byte-identical input (run twice → identical)
 *   - input order independence (object insertion order doesn't matter)
 *   - allocateAgentUid is in the reserved range
 *   - allocateAgentUid is deterministic across calls
 *   - generated compose contains stop_grace_period: 45s on every agent
 *   - scheduler service emitted with docker.sock mount
 */

import { describe, it, expect } from "vitest";
import {
  generateCompose,
  allocateAgentUid,
  AGENT_UID_MIN,
  AGENT_UID_MAX,
  describeAgents,
} from "../../src/agents/compose.js";
import type { SwitchroomConfig } from "../../src/config/schema.js";

function makeConfig(agents: Record<string, { extends?: string; settings_raw?: Record<string, unknown> }>): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "~/.switchroom/agents", skills_dir: "~/.switchroom/skills" },
    telegram: { bot_token: "x" },
    defaults: undefined,
    profiles: undefined,
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, cfg]) => [
        name,
        {
          extends: cfg.extends,
          settings_raw: cfg.settings_raw,
          schedule: [],
          tools: { allow: [], deny: [] },
          hooks: undefined,
          channels: undefined,
        } as unknown as SwitchroomConfig["agents"][string],
      ]),
    ),
    drive: undefined as unknown as SwitchroomConfig["drive"],
  } as unknown as SwitchroomConfig;
}

describe("allocateAgentUid", () => {
  it("returns UID in the reserved range", () => {
    for (const name of ["klanker", "coach", "finn", "ziggy", "alpha", "z9"]) {
      const uid = allocateAgentUid(name);
      expect(uid).toBeGreaterThanOrEqual(AGENT_UID_MIN);
      expect(uid).toBeLessThanOrEqual(AGENT_UID_MAX);
    }
  });

  it("is deterministic across calls", () => {
    expect(allocateAgentUid("klanker")).toBe(allocateAgentUid("klanker"));
    expect(allocateAgentUid("coach")).toBe(allocateAgentUid("coach"));
  });

  it("differs across distinct names (probabilistically — sanity)", () => {
    const uids = new Set(["a", "b", "c", "d", "e"].map(allocateAgentUid));
    expect(uids.size).toBeGreaterThan(1);
  });
});

describe("generateCompose", () => {
  it("handles an empty fleet", () => {
    const out = generateCompose({ config: makeConfig({}) });
    expect(out).toContain("vault-broker:");
    expect(out).toContain("approval-kernel:");
    expect(out).toContain("switchroom-cron:");
    expect(out).not.toContain("agent-");
  });

  it("emits a single agent", () => {
    const out = generateCompose({ config: makeConfig({ coach: {} }) });
    expect(out).toContain("agent-coach:");
    expect(out).toContain("container_name: switchroom-coach");
  });

  it("emits agents in sorted order", () => {
    const out = generateCompose({ config: makeConfig({ zebra: {}, alpha: {}, mango: {} }) });
    const a = out.indexOf("agent-alpha:");
    const m = out.indexOf("agent-mango:");
    const z = out.indexOf("agent-zebra:");
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(m);
    expect(m).toBeLessThan(z);
  });

  it("klanker gets 6g mem_limit + 2.0 cpus", () => {
    const out = generateCompose({ config: makeConfig({ klanker: {} }) });
    expect(out).toMatch(/agent-klanker:[\s\S]*?mem_limit: 6g/);
    expect(out).toMatch(/agent-klanker:[\s\S]*?cpus: 2\.0/);
  });

  it("conversational profile → 1.5g / 1.0", () => {
    const out = generateCompose({ config: makeConfig({ coach: { extends: "conversational" } }) });
    expect(out).toMatch(/agent-coach:[\s\S]*?mem_limit: 1\.5g/);
    expect(out).toMatch(/agent-coach:[\s\S]*?cpus: 1\.0/);
  });

  it("lightweight profile → 1g / 0.5", () => {
    const out = generateCompose({ config: makeConfig({ ziggy: { extends: "lightweight" } }) });
    expect(out).toMatch(/agent-ziggy:[\s\S]*?mem_limit: 1g/);
    expect(out).toMatch(/agent-ziggy:[\s\S]*?cpus: 0\.5/);
  });

  it("coding profile → 2g / 2.0", () => {
    const out = generateCompose({ config: makeConfig({ worker: { extends: "coding" } }) });
    expect(out).toMatch(/agent-worker:[\s\S]*?mem_limit: 2g/);
    expect(out).toMatch(/agent-worker:[\s\S]*?cpus: 2\.0/);
  });

  it("unknown profile → default 1.5g / 1.0", () => {
    const out = generateCompose({ config: makeConfig({ misc: { extends: "made-up" } }) });
    expect(out).toMatch(/agent-misc:[\s\S]*?mem_limit: 1\.5g/);
  });

  it("strips cap_add and emits a warning", () => {
    const warns: string[] = [];
    const out = generateCompose({
      config: makeConfig({ rogue: { settings_raw: { cap_add: ["SYS_ADMIN", "NET_ADMIN"] } } }),
      warn: (m) => warns.push(m),
    });
    // The agent service must not contain cap_add or the smuggled caps.
    const agentBlock = /agent-rogue:[\s\S]*?(?=\n  agent-|\nvolumes:|$)/.exec(out)?.[0] ?? "";
    expect(agentBlock).not.toContain("cap_add");
    expect(agentBlock).not.toContain("SYS_ADMIN");
    expect(out).not.toContain("SYS_ADMIN");
    expect(out).not.toContain("NET_ADMIN");
    expect(warns.some((w) => /cap_add/.test(w) && /rogue/.test(w))).toBe(true);
  });

  it("each agent mounts ONLY its own broker socket volume", () => {
    const out = generateCompose({ config: makeConfig({ a: {}, b: {}, c: {} }) });
    // Pull the volumes block of agent-a; it must only mention broker-a-sock.
    const aBlock = /agent-a:[\s\S]*?(?=\n  agent-|\nvolumes:)/.exec(out)?.[0] ?? "";
    expect(aBlock).toContain("broker-a-sock");
    expect(aBlock).not.toContain("broker-b-sock");
    expect(aBlock).not.toContain("broker-c-sock");
  });

  it("byte-determinism: same input → same output", () => {
    const cfg = makeConfig({ klanker: {}, coach: { extends: "conversational" } });
    const a = generateCompose({ config: cfg });
    const b = generateCompose({ config: cfg });
    expect(a).toBe(b);
  });

  it("input order independence", () => {
    const a = generateCompose({ config: makeConfig({ alpha: {}, zebra: {} }) });
    const b = generateCompose({ config: makeConfig({ zebra: {}, alpha: {} }) });
    expect(a).toBe(b);
  });

  it("emits stop_grace_period 45s on every agent", () => {
    const out = generateCompose({ config: makeConfig({ a: {}, b: {} }) });
    const matches = out.match(/stop_grace_period: 45s/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it("emits scheduler service with docker.sock mount (read-write)", () => {
    const out = generateCompose({ config: makeConfig({}) });
    expect(out).toContain("switchroom-cron:");
    // RW, NOT :ro — `docker exec` is a write op against the daemon
    // API. A :ro bind silently breaks dispatch.
    expect(out).toContain("/var/run/docker.sock:/var/run/docker.sock\n");
    expect(out).not.toContain("/var/run/docker.sock:/var/run/docker.sock:ro");
  });

  it("emits per-agent named volumes for broker AND kernel", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    expect(out).toMatch(/^volumes:\s*$/m);
    expect(out).toContain("broker-a-sock:");
    expect(out).toContain("kernel-a-sock:");
  });

  // ── regression: tilde in volume sources ────────────────────────────
  // Docker Compose does NOT expand ~ in volume sources; it creates a
  // literal "./~/..." directory. We must emit ${HOME}/... so compose's
  // env-var interpolation handles it.
  it("never emits a tilde in any volume source", () => {
    const out = generateCompose({
      config: makeConfig({ klanker: {}, coach: { extends: "conversational" } }),
    });
    // Any line that mentions a host-path volume mount (the source side
    // of a bind mount) must not start the source with "~/".
    for (const line of out.split("\n")) {
      const m = /^\s*-\s+([^:]+):/.exec(line);
      if (!m) continue;
      const source = m[1]!;
      expect(source, `tilde in volume source: ${line}`).not.toMatch(/^~/);
    }
    // And there should be no bare ~ anywhere on a volume line.
    const tildeLines = out.split("\n").filter((l) => /^\s+-\s+~/.test(l));
    expect(tildeLines).toEqual([]);
  });

  it("uses ${HOME} for host-path bind mounts when no homeDir is given", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    // Vault file mounted directly (not as a parent dir) — see compose.ts
    // for the rationale (#v0.7.1 vault file path fix).
    expect(out).toContain("${HOME}/.switchroom/vault.enc:/state/vault.enc:ro");
    expect(out).toContain("${HOME}/.switchroom/approvals:/state/approvals");
    expect(out).toContain("${HOME}/.switchroom:/state/config:ro");
    expect(out).toContain("${HOME}/.switchroom/agents/a:/state/agent");
    // Same-path dual mount for agents — see compose.ts for the rationale
    // (start.sh bakes host paths at scaffold time, so the same paths
    // must resolve inside the container).
    expect(out).toContain("${HOME}/.switchroom/agents/a:${HOME}/.switchroom/agents/a");
  });

  it("bakes the absolute homeDir into bind sources when given (sudo-safe)", () => {
    // Why: under `sudo docker compose`, ${HOME} resolves to /root, not
    // the operator's home. apply.ts passes os.homedir() so the YAML
    // captures the right path independent of who runs compose.
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      homeDir: "/home/op",
    });
    expect(out).toContain("/home/op/.switchroom/vault.enc:/state/vault.enc:ro");
    expect(out).toContain("/home/op/.switchroom/approvals:/state/approvals");
    expect(out).toContain("/home/op/.switchroom:/state/config:ro");
    // Dual mount: canonical /state/agent path AND same-path host path.
    expect(out).toContain("/home/op/.switchroom/agents/a:/state/agent");
    expect(out).toContain("/home/op/.switchroom/agents/a:/home/op/.switchroom/agents/a");
    expect(out).toContain("/home/op/.switchroom/logs/a:/var/log/switchroom");
    expect(out).toContain("/home/op/.switchroom/logs/a:/home/op/.switchroom/logs/a");
    expect(out).toContain("/home/op/.claude/projects/a:/state/.claude");
    expect(out).toContain("/home/op/.claude/projects/a:/home/op/.claude/projects/a");
    expect(out).not.toContain("${HOME}");
  });

  it("emits top-level project name 'switchroom' for collision protection", () => {
    // Belt-and-braces vs Coolify-managed (or other) compose stacks on
    // the same host. Pinning name: at file scope means
    // `docker compose -f <path>` always targets the same project.
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    expect(out).toMatch(/^name: switchroom$/m);
  });

  // ── security hardening defaults ────────────────────────────────────
  it("emits no-new-privileges + cap_drop ALL on every agent service", () => {
    const out = generateCompose({ config: makeConfig({ a: {}, b: {} }) });
    // Each agent block must contain both directives.
    for (const name of ["a", "b"]) {
      const block = new RegExp(
        `agent-${name}:[\\s\\S]*?(?=\\n  [a-z]|\\nvolumes:)`,
      ).exec(out)?.[0] ?? "";
      expect(block, `agent-${name} security_opt`).toContain('no-new-privileges:true');
      expect(block, `agent-${name} cap_drop`).toMatch(/cap_drop:\s*\n\s*-\s*"ALL"/);
      expect(block, `agent-${name} read_only`).toContain("read_only: true");
      expect(block, `agent-${name} tmpfs`).toContain("/tmp:size=256m");
    }
  });

  it("emits no-new-privileges + cap_drop ALL on broker, kernel, scheduler", () => {
    const out = generateCompose({ config: makeConfig({}) });
    // Split into top-level service blocks.
    const blocks: Record<string, string> = {};
    const re = /^  ([a-z][a-z0-9-]*):\n((?:    [^\n]*\n|\n)+)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out)) !== null) {
      blocks[m[1]!] = m[0]!;
    }
    for (const svc of ["vault-broker", "approval-kernel", "switchroom-cron"]) {
      const block = blocks[svc] ?? "";
      expect(block, `${svc} block found`).toContain(`${svc}:`);
      expect(block, `${svc} security_opt`).toContain("no-new-privileges:true");
      expect(block, `${svc} cap_drop`).toMatch(/cap_drop:\s*\n\s*-\s*"ALL"/);
    }
  });

  it("broker keeps CHOWN + FOWNER (needed to chown per-agent sockets)", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /vault-broker:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toContain("CHOWN");
    expect(block).toContain("FOWNER");
  });

  it("kernel keeps CHOWN + FOWNER (mirrors broker socket-ownership flow)", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const block = /approval-kernel:[\s\S]*?(?=\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).toContain("CHOWN");
    expect(block).toContain("FOWNER");
  });

  it("scheduler does NOT re-add any caps", () => {
    const out = generateCompose({ config: makeConfig({}) });
    const block = /switchroom-cron:[\s\S]*?(?=\nvolumes:|\n  [a-z])/.exec(out)?.[0] ?? "";
    expect(block).not.toContain("cap_add");
  });
});

describe("agent service env (Phase 2c F2 — IPC wiring)", () => {
  // Phase 2a (broker IPC) and Phase 2b (kernel IPC) both expect agent
  // containers to receive these env vars at boot — without them an agent
  // can't find its broker or kernel socket and silently falls back to
  // legacy / disabled paths. Neither phase included a generator-level
  // assertion, so this test pins the contract.
  //
  // Path shape MUST match the kernel-server / broker-server bind shape
  // (`/run/switchroom/<broker|kernel>/<agent>/sock`) — same as the per-
  // agent volume mount the generator already emits.
  function envBlockFor(yml: string, agent: string): string {
    const re = new RegExp(
      `  agent-${agent}:[\\s\\S]*?    environment:([\\s\\S]*?)\\n    volumes:`,
    );
    return re.exec(yml)?.[1] ?? "";
  }

  it("sets SWITCHROOM_RUNTIME=docker on each agent container", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(/SWITCHROOM_RUNTIME:\s*"docker"/);
    }
  });

  it("sets SWITCHROOM_KERNEL_SOCKET to the per-agent kernel-server bind path", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(
        new RegExp(
          `SWITCHROOM_KERNEL_SOCKET:\\s*"/run/switchroom/kernel/${a}/sock"`,
        ),
      );
    }
  });

  it("sets SWITCHROOM_BROKER_SOCKET to the per-agent broker-server bind path", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(
        new RegExp(
          `SWITCHROOM_BROKER_SOCKET:\\s*"/run/switchroom/broker/${a}/sock"`,
        ),
      );
    }
  });

  it("sets SWITCHROOM_AGENT_NAME identity on each agent container", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {}, bob: {} }),
    });
    for (const a of ["alice", "bob"]) {
      const env = envBlockFor(out, a);
      expect(env).toMatch(
        new RegExp(`SWITCHROOM_AGENT_NAME:\\s*"${a}"`),
      );
    }
  });
});

describe("generateCompose — switchroomConfigPath bind-mount (v0.7 P0 fix)", () => {
  // Regression: without the config bind-mount, the broker container boots
  // with `ConfigError: No switchroom.yaml found` and restart-loops. The
  // fix bind-mounts the resolved switchroom.yaml into broker, kernel, and
  // scheduler at /state/config/switchroom.yaml, with SWITCHROOM_CONFIG
  // pointing at it so the in-container loader skips its cwd auto-detect.
  const CONFIG = "/home/op/switchroom.yaml";

  function blockFor(yml: string, service: string): string {
    const re = new RegExp(`  ${service}:[\\s\\S]*?(?=\\n  [a-z]|\\nvolumes:)`);
    return re.exec(yml)?.[0] ?? "";
  }

  it("bind-mounts switchroom.yaml + sets SWITCHROOM_CONFIG on the broker", () => {
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      switchroomConfigPath: CONFIG,
    });
    const block = blockFor(out, "vault-broker");
    expect(block).toContain(`${CONFIG}:/state/config/switchroom.yaml:ro`);
    expect(block).toMatch(/SWITCHROOM_CONFIG:\s*\/state\/config\/switchroom\.yaml/);
  });

  it("bind-mounts switchroom.yaml + sets SWITCHROOM_CONFIG on the approval-kernel", () => {
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      switchroomConfigPath: CONFIG,
    });
    const block = blockFor(out, "approval-kernel");
    expect(block).toContain(`${CONFIG}:/state/config/switchroom.yaml:ro`);
    expect(block).toMatch(/SWITCHROOM_CONFIG:\s*\/state\/config\/switchroom\.yaml/);
  });

  it("bind-mounts switchroom.yaml as a file on the scheduler (not the dir)", () => {
    const out = generateCompose({
      config: makeConfig({ a: {} }),
      switchroomConfigPath: CONFIG,
    });
    const block = blockFor(out, "switchroom-cron");
    expect(block).toContain(`${CONFIG}:/state/config/switchroom.yaml:ro`);
    // The legacy directory mount must be replaced when the explicit
    // file path is provided, otherwise both compete for /state/config.
    expect(block).not.toMatch(/\.switchroom:\/state\/config:ro/);
    expect(block).toMatch(/SWITCHROOM_CONFIG:\s*\/state\/config\/switchroom\.yaml/);
  });

  it("back-compat: omitting switchroomConfigPath leaves broker/kernel without the mount", () => {
    const out = generateCompose({ config: makeConfig({ a: {} }) });
    const broker = blockFor(out, "vault-broker");
    expect(broker).not.toContain(":/state/config/switchroom.yaml");
    const kernel = blockFor(out, "approval-kernel");
    expect(kernel).not.toContain(":/state/config/switchroom.yaml");
    // Scheduler keeps its legacy directory mount in back-compat mode.
    const sched = blockFor(out, "switchroom-cron");
    expect(sched).toMatch(/\.switchroom:\/state\/config:ro/);
  });
});

describe("generateCompose — buildMode (pull vs local)", () => {
  it("default mode emits ghcr.io image refs and no build: blocks", () => {
    const out = generateCompose({ config: makeConfig({ alice: {} }) });
    expect(out).toContain("image: ghcr.io/switchroom/switchroom-broker:latest");
    expect(out).toContain("image: ghcr.io/switchroom/switchroom-kernel:latest");
    expect(out).toContain("image: ghcr.io/switchroom/switchroom-scheduler:latest");
    expect(out).toContain("image: ghcr.io/switchroom/switchroom-agent:latest");
    expect(out).not.toContain("build:");
    expect(out).not.toMatch(/dockerfile: docker\/Dockerfile/);
  });

  it("buildMode=local emits build: blocks pointing at the supplied context", () => {
    const ctx = "/abs/path/to/switchroom";
    const out = generateCompose({
      config: makeConfig({ alice: {} }),
      buildMode: "local",
      buildContext: ctx,
    });
    expect(out).not.toMatch(/image: ghcr\.io\//);
    for (const df of ["agent", "broker", "kernel", "scheduler"]) {
      expect(out).toContain(`dockerfile: docker/Dockerfile.${df}`);
    }
    expect(out).toContain(`context: ${ctx}`);
    expect(out.match(/dockerfile: docker\/Dockerfile\.agent/g)?.length).toBe(1);
  });

  it("buildMode=local without buildContext throws", () => {
    expect(() =>
      generateCompose({
        config: makeConfig({ alice: {} }),
        buildMode: "local",
      }),
    ).toThrow(/buildContext/);
  });

  it("imageTag flows through in pull mode", () => {
    const out = generateCompose({
      config: makeConfig({ alice: {} }),
      imageTag: "v0.7.3",
    });
    expect(out).toContain("image: ghcr.io/switchroom/switchroom-broker:v0.7.3");
    expect(out).toContain("image: ghcr.io/switchroom/switchroom-agent:v0.7.3");
  });
});

describe("describeAgents", () => {
  it("returns sorted agents with allocated UIDs", () => {
    const agents = describeAgents(makeConfig({ zebra: {}, alpha: {} }));
    expect(agents.map((a) => a.name)).toEqual(["alpha", "zebra"]);
    for (const a of agents) {
      expect(a.uid).toBeGreaterThanOrEqual(AGENT_UID_MIN);
      expect(a.uid).toBeLessThanOrEqual(AGENT_UID_MAX);
    }
  });
});
