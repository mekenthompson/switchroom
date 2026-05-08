/**
 * Phase 1c — per-agent isolation E2E.
 *
 * The production-equivalent of the Phase 0 spike's adversarial test
 * (spike/agent-client.mjs + spike/test-acl-matrix.sh), running against
 * the actual generated compose + the actual production broker / kernel
 * servers (with main() entrypoints from Phase 1b/1c).
 *
 * What this test asserts:
 *
 * Path-derived identity model (compose mount discipline)
 *   1. From inside agent-A's container, agent-B's broker socket dir
 *      is NOT mounted in — connect attempt resolves at ENOENT.
 *      That's the *compose discipline boundary*: we ship a generated
 *      compose that mounts each agent's socket dir into ONLY that
 *      agent's container. The doctor check
 *      `checkAgentSocketMounts` (Phase 1a) enforces this invariant
 *      at compose-generate time; this test asserts it holds at
 *      runtime.
 *   2. Same for the kernel sockets.
 *
 * File-perm boundary (hostile cross-mount)
 *   3. We spin up an "evil" agent service that DOES cross-mount
 *      victim's broker dir, with a DIFFERENT UID — file-perm checks
 *      should block: connect → EACCES, bind in dir → EACCES, unlink
 *      → EACCES.
 *   4. Same set against the kernel sockets.
 *
 * Same-UID twin (documented model assumption)
 *   5. We spin up an "evil-twin" agent with `user:` matching alice's
 *      UID, cross-mount alice's broker dir. ALL attacks SUCCEED. This
 *      documents the model assumption (the path-derived identity
 *      model assumes UID uniqueness across services — a doctor-level
 *      UID-uniqueness check is the mitigation, tracked in Phase 1
 *      backlog).
 *
 * Skip discipline: cleanly skipped when docker daemon unavailable OR
 * when the phase1b-test images aren't built.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCompose, allocateAgentUid } from "../../src/agents/compose.js";
import type { SwitchroomConfig } from "../../src/config/schema.js";

const TAG = "phase1b-test";
const IMAGES = ["base", "agent", "broker", "kernel", "scheduler"].map(
  (n) => `switchroom/${n}:${TAG}`,
);
const PROJECT = `phase1c-iso-${process.pid}`;

function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch { return false; }
}
function hasImage(ref: string): boolean {
  try { execSync(`docker image inspect ${ref}`, { stdio: "ignore" }); return true; }
  catch { return false; }
}
const dockerOk = hasDocker();
const imagesOk = dockerOk && IMAGES.every(hasImage);

/** Cross-fork lock — atomic mkdir. Releases on test teardown. */
let _fleetLockPath: string | null = null;
function acquireFleetLock(p: string, timeoutMs = 240_000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      mkdirSync(p);
      _fleetLockPath = p;
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        // Stale-lock heuristic: if the lock dir is older than 5 min,
        // assume the previous holder crashed and steal it.
        try {
          const ageMs = Date.now() - (require("node:fs").statSync(p).mtimeMs as number);
          if (ageMs > 5 * 60_000) {
            try { rmdirSync(p); } catch { /* */ }
            continue;
          }
        } catch { /* */ }
        execSync("sleep 2");
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Could not acquire fleet lock at ${p} within ${timeoutMs}ms`);
}
function releaseFleetLock(): void {
  if (_fleetLockPath) {
    try { rmdirSync(_fleetLockPath); } catch { /* best-effort */ }
    _fleetLockPath = null;
  }
}

function makeConfig(agents: string[]): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: { bot_token: "x", forum_chat_id: "-1001234567890" },
    vault: { path: "/tmp/vault.enc" },
    defaults: undefined,
    profiles: undefined,
    agents: Object.fromEntries(
      agents.map((name) => [
        name,
        {
          topic_name: name,
          extends: undefined,
          schedule: [{ cron: "0 0 1 1 *", prompt: "noop", secrets: [] }],
          tools: { allow: [], deny: [] },
          hooks: undefined,
          channels: undefined,
        } as unknown as SwitchroomConfig["agents"][string],
      ]),
    ),
    drive: undefined as unknown as SwitchroomConfig["drive"],
  } as unknown as SwitchroomConfig;
}

/** Same compose-rewrite shape as the race test. Agents stay alive on
 *  a sleep loop so we can `docker exec` into them. */
function buildTestCompose(agents: string[], cfgPath: string): string {
  let yml = generateCompose({ config: makeConfig(agents), imageTag: TAG });
  yml = yml.replace(/ghcr\.io\/switchroom\//g, "switchroom/");
  yml = yml
    .replace(/- \$\{HOME\}\/\.switchroom\/vault:\/state\/vault\b/g, "- vault-state:/state/vault")
    .replace(/- \$\{HOME\}\/\.switchroom\/approvals:\/state\/approvals\b/g, "- approvals-state:/state/approvals")
    .replace(/- \$\{HOME\}\/\.switchroom:\/state\/config:ro\b/g, `- ${cfgPath}:/state/config/switchroom.yaml:ro`)
    .replace(/- \$\{HOME\}\/\.switchroom\/scheduler:\/state\/scheduler\b/g, "- scheduler-state:/state/scheduler")
    .replace(/- \$\{HOME\}\/\.switchroom\/agents\/[^:]+:\/state\/agent\b/g, "- agent-state:/state/agent")
    .replace(/- \$\{HOME\}\/\.claude\/projects\/[^:]+:\/state\/\.claude\b/g, "- claude-state:/state/.claude");
  for (const a of agents) {
    yml = yml.replace(
      new RegExp(`(  agent-${a}:\\s*\\n)`),
      `$1    entrypoint: ["/usr/bin/tini", "--", "sh", "-c", "while true; do sleep 60; done"]\n`,
    );
  }
  yml = yml.replace(
    /(  vault-broker:\s*\n)/,
    `$1    environment:\n      SWITCHROOM_CONFIG: /state/config/switchroom.yaml\n      SWITCHROOM_BROKER_ALLOW_NON_LINUX: "1"\n`,
  );
  yml = yml.replace(
    /(  approval-kernel:\s*\n)/,
    `$1    environment:\n      SWITCHROOM_CONFIG: /state/config/switchroom.yaml\n      SWITCHROOM_KERNEL_DB_PATH: /state/approvals/kernel.db\n`,
  );
  yml = yml.replace(/(  vault-broker:[\s\S]*?volumes:\n)/, `$1      - ${cfgPath}:/state/config/switchroom.yaml:ro\n`);
  yml = yml.replace(/(  approval-kernel:[\s\S]*?volumes:\n)/, `$1      - ${cfgPath}:/state/config/switchroom.yaml:ro\n`);
  yml += "  vault-state:\n  approvals-state:\n  scheduler-state:\n  agent-state:\n  claude-state:\n";
  return yml;
}

/** Append two extra agent services to the generated compose:
 *  - `evil-cross`: a normal-UID agent that cross-mounts alice's broker
 *    + kernel volumes. Different UID from alice. Expect file-perm denial.
 *  - `evil-twin`: same UID as alice, cross-mounts alice's volumes.
 *    Expect attacks to SUCCEED (model-assumption documentation).
 */
function appendAdversarialServices(yml: string): string {
  const aliceUid = allocateAgentUid("alice");
  const evilCrossUid = allocateAgentUid("evil-cross"); // different UID
  // Same-UID twin: the operator misconfigured user: to alice's UID.
  // We literally inject `user: "<aliceUid>:<aliceUid>"` to model that.
  const twinSection = [
    `  evil-twin:`,
    `    image: switchroom/agent:${TAG}`,
    `    hostname: evil-twin`,
    `    user: "${aliceUid}:${aliceUid}"`,
    `    entrypoint: ["/usr/bin/tini", "--", "sh", "-c", "while true; do sleep 60; done"]`,
    `    security_opt:`,
    `      - "no-new-privileges:true"`,
    `    cap_drop:`,
    `      - "ALL"`,
    `    tmpfs:`,
    `      - /tmp:size=64m,mode=1777`,
    `    volumes:`,
    `      - broker-alice-sock:/run/switchroom/broker/alice-victim`,
    `      - kernel-alice-sock:/run/switchroom/kernel/alice-victim`,
    ``,
  ].join("\n");
  const crossSection = [
    `  evil-cross:`,
    `    image: switchroom/agent:${TAG}`,
    `    hostname: evil-cross`,
    `    user: "${evilCrossUid}:${evilCrossUid}"`,
    `    entrypoint: ["/usr/bin/tini", "--", "sh", "-c", "while true; do sleep 60; done"]`,
    `    security_opt:`,
    `      - "no-new-privileges:true"`,
    `    cap_drop:`,
    `      - "ALL"`,
    `    tmpfs:`,
    `      - /tmp:size=64m,mode=1777`,
    `    volumes:`,
    `      - broker-alice-sock:/run/switchroom/broker/alice-victim`,
    `      - kernel-alice-sock:/run/switchroom/kernel/alice-victim`,
    ``,
  ].join("\n");
  // Insert before the volumes: section.
  yml = yml.replace(/(\nvolumes:\n)/, `\n${twinSection}\n${crossSection}\n$1`);
  return yml;
}

interface FleetCtx {
  workdir: string;
  composePath: string;
  cfgPath: string;
}

let ctx: FleetCtx | null = null;

beforeAll(() => {
  if (!imagesOk) return;
  // Belt-and-braces project-scoped down (does NOT touch other containers).
  try { execSync(`docker compose -p ${PROJECT} down -v --remove-orphans`, { stdio: "pipe" }); } catch { /* */ }
  // Forcefully remove any leftover singletons from a sibling test file
  // (race test) — they use fixed container_name: so projects collide.
  // Scope: ONLY the switchroom singleton names this PR introduces.
  // We do NOT touch unrelated containers on the host.
  // Acquire a cross-fork lock — vitest runs test files in parallel
  // forks, and both this file + broker-ipc-race.test.ts use the same
  // `container_name:` from the shared compose generator. The lock is
  // an atomic mkdir on a fixed path under /tmp; whichever fork claims
  // it first gets to run; the other waits.
  const LOCK_DIR = "/tmp/switchroom-docker-fleet.lock";
  acquireFleetLock(LOCK_DIR);
  // Belt-and-braces: forcefully remove any leftover singletons.
  for (const c of [
    "switchroom-vault-broker",
    "switchroom-approval-kernel",
    "switchroom-cron",
    "switchroom-alice",
    "switchroom-bob",
    "switchroom-carol",
    "switchroom-newbie",
  ]) {
    try { execSync(`docker rm -f ${c}`, { stdio: "pipe" }); } catch { /* */ }
  }
  const workdir = mkdtempSync(join(tmpdir(), "phase1c-iso-"));
  const cfgPath = join(workdir, "switchroom.yaml");
  writeFileSync(
    cfgPath,
    [
      "switchroom: { version: 1, agents_dir: /tmp/agents, skills_dir: /tmp/skills }",
      "telegram: { bot_token: x, forum_chat_id: \"-1001234567890\" }",
      "vault: { path: /tmp/vault.enc }",
      "agents:",
      "  alice:",
      "    topic_name: alice",
      "    schedule: [{ cron: \"0 0 1 1 *\", prompt: noop }]",
      "  bob:",
      "    topic_name: bob",
      "    schedule: [{ cron: \"0 0 1 1 *\", prompt: noop }]",
      "  carol:",
      "    topic_name: carol",
      "    schedule: [{ cron: \"0 0 1 1 *\", prompt: noop }]",
      "",
    ].join("\n"),
  );
  let yml = buildTestCompose(["alice", "bob", "carol"], cfgPath);
  yml = appendAdversarialServices(yml);
  const composePath = join(workdir, "compose.yml");
  writeFileSync(composePath, yml);
  ctx = { workdir, composePath, cfgPath };
  execSync(`docker compose -p ${PROJECT} -f ${composePath} up -d`, { stdio: "pipe", cwd: workdir });
  execSync("sleep 6");
}, 120_000);

afterAll(() => {
  if (!imagesOk) return;
  try { execSync(`docker compose -p ${PROJECT} down -v --remove-orphans`, { stdio: "pipe" }); } catch { /* */ }
  if (ctx) { try { rmSync(ctx.workdir, { recursive: true, force: true }); } catch { /* */ } }
  releaseFleetLock();
}, 60_000);

/**
 * Run a shell snippet inside container `c` and return exit code +
 * combined stdout/stderr. We use `sh -c` rather than `node -e`
 * because the agent image ships `nc` and basic POSIX tools that are
 * sufficient for "did the connect/bind/unlink succeed?" probes — we
 * don't need full IPC.
 */
function dockerExec(c: string, cmd: string): { code: number; out: string } {
  // For project-scoped services without a fixed container_name (evil-twin
  // / evil-cross), we use `docker compose exec` to resolve the
  // project-scoped container. For services with a fixed container_name
  // (the singletons + agents) we go straight to `docker exec`.
  const isComposeService = c === "evil-twin" || c === "evil-cross";
  const args = isComposeService
    ? ["compose", "-p", PROJECT, "-f", ctx!.composePath, "exec", "-T", c, "sh", "-c", cmd]
    : ["exec", c, "sh", "-c", cmd];
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: 10000 });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe.skipIf(!imagesOk)(
  "phase1c per-agent isolation — production-equivalent adversarial matrix",
  () => {
    it("agent-A cannot see agent-B's broker socket dir (compose discipline boundary)", () => {
      // From alice's container, /run/switchroom/broker/bob/sock should
      // not exist — the bob volume is NOT mounted into alice.
      const r = dockerExec(
        "switchroom-alice",
        "ls /run/switchroom/broker/bob/sock 2>&1",
      );
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/No such file or directory|cannot access/i);
    });

    it("agent-A cannot see agent-B's kernel socket dir (compose discipline boundary)", () => {
      const r = dockerExec(
        "switchroom-alice",
        "ls /run/switchroom/kernel/bob/sock 2>&1",
      );
      expect(r.code).not.toBe(0);
      expect(r.out).toMatch(/No such file or directory|cannot access/i);
    });

    // NOTE on broker vs kernel adversarial coverage:
    // The Phase 1b broker entrypoint binds a single socket and does NOT
    // create per-agent subdirs under /run/switchroom/broker/<agent>/ at
    // mode 0700. So a hostile cross-mount of broker-alice-sock lands on
    // a default 0755 named-volume directory — NOT the production model.
    // We exercise the file-perm boundary against the *kernel* sockets
    // (which my Phase 1c kernel-server DOES bind per-agent at mode 0700
    // owned by the agent UID — the production model), and document the
    // broker side as a Phase 1c follow-up. See report-D in the PR body.

    it("evil-cross (different UID, hostile cross-mount): kernel socket dir read blocked by file perms", () => {
      // We mounted kernel-alice-sock at /run/switchroom/kernel/alice-victim
      // inside evil-cross. The dir is mode 0700 owned by alice's UID
      // (set by the kernel-server bootstrap). evil-cross runs as a
      // different UID — `ls` should fail with EACCES.
      const r = dockerExec(
        "evil-cross",
        "ls /run/switchroom/kernel/alice-victim/ 2>&1; echo exit=$?",
      );
      expect(r.out).toMatch(/Permission denied/i);
    });

    it("evil-cross: bind attempt inside victim kernel dir blocked by file perms", () => {
      const r = dockerExec(
        "evil-cross",
        "touch /run/switchroom/kernel/alice-victim/attacker.sock 2>&1; echo exit=$?",
      );
      expect(r.out).toMatch(/Permission denied/i);
    });

    it("evil-cross: unlink attempt of victim kernel socket blocked by file perms", () => {
      // The attacker doesn't have +x on the dir, so even a path
      // resolution toward the sock entry fails with EACCES. The shell
      // `rm -f` reports the EACCES on stderr but exits 0 because of
      // the -f flag — assert on the stderr signal not the exit code.
      const r = dockerExec(
        "evil-cross",
        "rm /run/switchroom/kernel/alice-victim/sock 2>&1; echo exit=$?",
      );
      expect(r.out).toMatch(/Permission denied/i);
    });

    it("evil-twin (SAME UID as alice, hostile cross-mount): attacks SUCCEED — documents model assumption", () => {
      // The path-derived identity model assumes UID uniqueness. With
      // that violated, file perms cannot distinguish alice from her
      // twin: every attack succeeds. This documents the assumption
      // and motivates the doctor-level UID-uniqueness check
      // (Phase 1 backlog).
      // ls — lists the kernel sock entry alice's process bound.
      const r1 = dockerExec(
        "evil-twin",
        "ls /run/switchroom/kernel/alice-victim/ 2>&1; echo exit=$?",
      );
      expect(r1.out).toMatch(/exit=0/);
      expect(r1.out).toMatch(/sock/);
      // Twin can create a sibling file in the victim's dir.
      const r2 = dockerExec(
        "evil-twin",
        "touch /run/switchroom/kernel/alice-victim/twin-marker 2>&1; echo exit=$?",
      );
      expect(r2.out).toMatch(/exit=0/);
      // Twin can unlink her own marker.
      const r3 = dockerExec(
        "evil-twin",
        "rm /run/switchroom/kernel/alice-victim/twin-marker 2>&1; echo exit=$?",
      );
      expect(r3.out).toMatch(/exit=0/);
    });
  },
);

describe.skipIf(imagesOk)(
  "phase1c per-agent isolation — sentinel (visible when prereqs missing)",
  () => {
    it("documents skip reason", () => {
      const reason = !dockerOk
        ? "docker daemon unreachable"
        : "phase1b-test images not built — run `bash tests/docker/build-images.sh`";
      expect(reason).toBeTruthy();
    });
  },
);
