/**
 * Phase 2c — vault + approval integration suite.
 *
 * This is the first end-to-end test that exercises the broker (Phase 2a)
 * AND the approval kernel (Phase 2b) AND a real agent container together.
 * The earlier per-IPC tests verified each socket path in isolation; this
 * one verifies the full stack works across the container boundary, with
 * each agent making BOTH a broker `get` and a kernel `approval_request`
 * (plus a `waitForApproval`-style short-poll cycle) from inside its own
 * agent container.
 *
 * Acceptance criteria:
 *
 *   1. Each agent (alice / bob / carol) successfully resolves its own
 *      scoped secret via the broker AND opens + short-polls a pending
 *      approval via the kernel — same flow, same agent process.
 *
 *   2. Cross-agent denial holds at BOTH layers:
 *      - alice's process talking on bob's broker socket → DENIED.
 *      - alice's process talking on bob's kernel socket → DENIED.
 *
 *   3. Concurrent flows: 3 agents × 5 iterations each, mixed broker
 *      + kernel calls in flight simultaneously. No lock contention,
 *      no wire deadlock.
 *
 *   4. Schema-stability invariant on BOTH dbs — broker.db (vault grants)
 *      AND kernel.db PRAGMA schema_version unchanged pre/post.
 *
 *   5. Production-host safety: every container labelled
 *      `switchroom.test=phase2c` + per-run UUID. Teardown is exclusively
 *      label-filtered (safeLabelTeardownPhase2c) plus per-name
 *      `docker rm -f`. Pre/post sudo-docker-ps snapshot is HARD-asserted
 *      via `expect(...).toBe(...)` — drift fails the suite.
 *
 * Skip discipline: cleanly skipped when docker daemon unreachable OR any
 * of {broker:phase2a-test, kernel:phase2b-test, agent:phase1b-test} is
 * not built. Build instructions are in the skip-sentinel `it()` body.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import {
  captureProdSnapshot,
  expectNoProdDrift,
  type ProdSnapshot,
} from "./_prod-snapshot";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  closeSync,
  openSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  createVault,
  setStringSecret,
} from "../../src/vault/vault.js";

// ─── Phase 2c label discipline ────────────────────────────────────────────────
const RUN_ID = randomUUID();
const PHASE_LABEL = "switchroom.test=phase2c";

function labelArgv(): string[] {
  return [
    "--label", PHASE_LABEL,
    "--label", `switchroom.test.run=${RUN_ID}`,
  ];
}

/** Sanctioned bulk teardown — filtered by label only. NEVER touches non-phase2c. */
function safeLabelTeardownPhase2c(): void {
  for (const filter of [
    `label=switchroom.test.run=${RUN_ID}`,
    PHASE_LABEL,
  ]) {
    try {
      const ids = execSync(`docker ps -aq --filter ${filter}`, {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (ids.length === 0) continue;
      execSync(`docker rm -f ${ids.split(/\s+/).join(" ")}`, { stdio: "ignore" });
    } catch {
      /* best-effort */
    }
  }
}

// ─── Image presence guards ────────────────────────────────────────────────────

const BROKER_IMAGE = "switchroom/broker:phase2a-test";
const KERNEL_IMAGE = "switchroom/kernel:phase2b-test";
const AGENT_IMAGE = "switchroom/agent:phase1b-test";

function hasDocker(): boolean {
  try {
    execSync("docker version --format '{{.Server.Version}}'", {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}
function hasImage(ref: string): boolean {
  try {
    execSync(`docker image inspect ${ref}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const dockerOk = hasDocker();
const imagesOk =
  dockerOk &&
  hasImage(BROKER_IMAGE) &&
  hasImage(KERNEL_IMAGE) &&
  hasImage(AGENT_IMAGE);

// ─── Fixture state ────────────────────────────────────────────────────────────

interface Fixture {
  workdir: string;
  brokerSocketDir: string; // host path mounted at /run/switchroom/broker (broker view)
  kernelSocketParent: string; // host path mounted at /run/switchroom/kernel (kernel view)
  brokerName: string;
  kernelName: string;
  agentNames: Map<string, string>; // agent label → container name
  initialBrokerSchemaVersion: number | null;
  initialKernelSchemaVersion: number | null;
  prodSnapshot: ProdSnapshot;
}

let fx: Fixture | null = null;

const PASSPHRASE = "phase2c-test-passphrase-do-not-use-in-prod";
const AGENTS = ["alice", "bob", "carol"];

// ─── Schema helpers (snapshot helper lives in ./_prod-snapshot.ts) ───────────

function readSchemaVersion(containerName: string, dbPath: string): number | null {
  try {
    const out = execSync(
      `docker exec ${containerName} bun -e ` +
        `'const{Database}=require("bun:sqlite");` +
        `const db=new Database("${dbPath}",{readonly:true});` +
        `const row=db.query("PRAGMA schema_version").get();` +
        `console.log(row.schema_version);'`,
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    ).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ─── Agent-side script: connect to a unix socket and round-trip one ndjson op.
//
// We package this as a string we splat into `docker exec ... bun -e` so the
// network call originates from inside the AGENT container — not the host.
// That matters because Phase 2c claims to verify cross-container behaviour,
// not just side-by-side host-to-socket.
//
// The script writes the response JSON to stdout (one line) and exits 0 on
// any successful round-trip (including DENIED responses — those are valid
// protocol replies). Hard errors (timeout, parse fail) exit 1.
const AGENT_NDJSON_SCRIPT = `
const net = require('node:net');
// bun -e: process.argv = ["/usr/local/bin/bun", arg1, arg2, ...]
// (no "[eval]" placeholder like Node, so user args start at index 1).
const sock = process.argv[1];
const payload = process.argv[2];
const timeoutMs = Number.parseInt(process.argv[3] || '4000', 10);
const c = net.createConnection(sock);
let buf = '';
const t = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, timeoutMs);
c.on('connect', () => c.write(payload + '\\n'));
c.on('data', d => {
  buf += d.toString('utf8');
  const nl = buf.indexOf('\\n');
  if (nl !== -1) {
    clearTimeout(t);
    process.stdout.write(buf.slice(0, nl) + '\\n');
    c.destroy();
    process.exit(0);
  }
});
c.on('error', e => { clearTimeout(t); console.error('ERR:'+e.message); process.exit(1); });
`;

interface NdjsonResult {
  ok: boolean;
  raw: string;
  parsed: unknown;
}

/** Run the ndjson client INSIDE the named agent container against `socketPath`. */
function agentNdjson(
  containerName: string,
  socketPath: string,
  payload: object,
  timeoutMs = 5000,
): NdjsonResult {
  const r = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "bun",
      "-e",
      AGENT_NDJSON_SCRIPT,
      "--",
      socketPath,
      JSON.stringify(payload),
      String(timeoutMs),
    ],
    { encoding: "utf8", timeout: timeoutMs + 4000 },
  );
  if (r.status !== 0) {
    return {
      ok: false,
      raw: `${r.stdout}\n${r.stderr}`,
      parsed: null,
    };
  }
  const line = r.stdout.split("\n").find((l) => l.trim().length > 0) ?? "";
  try {
    return { ok: true, raw: line, parsed: JSON.parse(line) };
  } catch {
    return { ok: false, raw: line, parsed: null };
  }
}

// ─── Container lifecycle ──────────────────────────────────────────────────────

beforeAll(() => {
  if (!imagesOk) return;

  const prodSnapshot = captureProdSnapshot();

  const workdir = mkdtempSync(join(tmpdir(), "phase2c-integration-"));
  const brokerSocketDir = join(workdir, "broker-sockets");
  const brokerStateDir = join(workdir, "broker-state");
  const kernelSocketParent = join(workdir, "kernel-sockets");
  const kernelStateDir = join(workdir, "kernel-state");
  for (const d of [brokerSocketDir, brokerStateDir, kernelSocketParent, kernelStateDir]) {
    mkdirSync(d, { recursive: true, mode: 0o755 });
  }

  // ── Broker boot prep ──────────────────────────────────────────────
  // Phase 2a expects placeholder <agent>.sock files in the broker socket
  // dir; broker enumerates them at boot, unlinks, then binds real sockets.
  for (const a of AGENTS) {
    const placeholder = join(brokerSocketDir, `${a}.sock`);
    closeSync(openSync(placeholder, "w"));
    chmodSync(placeholder, 0o660);
  }
  // Vault seeded with one scoped secret per agent.
  const vaultPath = join(brokerStateDir, "vault.enc");
  createVault(PASSPHRASE, vaultPath);
  for (const a of AGENTS) {
    setStringSecret(PASSPHRASE, vaultPath, `${a}_key`, `secret-for-${a}`);
  }
  // switchroom.yaml declaring per-agent grants.
  const configPath = join(brokerStateDir, "switchroom.yaml");
  writeFileSync(
    configPath,
    [
      "switchroom:",
      "  version: 1",
      "  agents_dir: /tmp/agents",
      "  skills_dir: /tmp/skills",
      "telegram:",
      "  bot_token: x",
      '  forum_chat_id: "-1001234567890"',
      "vault:",
      "  path: /state/vault/vault.enc",
      "agents:",
      ...AGENTS.flatMap((a) => [
        `  ${a}:`,
        `    topic_name: ${a}`,
        `    schedule:`,
        `      - cron: "0 0 1 1 *"`,
        `        prompt: "noop"`,
        `        secrets: ["${a}_key"]`,
      ]),
      "",
    ].join("\n"),
  );

  // ── Kernel boot prep ──────────────────────────────────────────────
  // Phase 2b expects per-agent subdirectories in the kernel socket
  // parent; kernel binds /run/switchroom/kernel/<agent>/sock at boot.
  for (const a of AGENTS) {
    mkdirSync(join(kernelSocketParent, a), { recursive: true, mode: 0o755 });
  }

  // ── Launch broker ─────────────────────────────────────────────────
  const brokerName = `switchroom-phase2c-broker-${process.pid}-${RUN_ID.slice(0, 8)}`;
  try { execSync(`docker rm -f ${brokerName}`, { stdio: "ignore" }); } catch { /* */ }
  const brokerArgs = [
    "run",
    "-d",
    "--name", brokerName,
    ...labelArgv(),
    "--user", "0:0",
    "-v", `${brokerSocketDir}:/run/switchroom/broker`,
    "-v", `${brokerStateDir}:/state/vault`,
    "-v", `${configPath}:/state/config/switchroom.yaml:ro`,
    "-e", "SWITCHROOM_CONFIG=/state/config/switchroom.yaml",
    "-e", "SWITCHROOM_VAULT_PATH=/state/vault/vault.enc",
    "-e", "SWITCHROOM_BROKER_PER_AGENT_DIR=/run/switchroom/broker",
    "-e", "SWITCHROOM_BROKER_SOCKET=/run/switchroom/broker/vault-broker.sock",
    "-e", "SWITCHROOM_BROKER_ALLOW_NON_LINUX=1",
    BROKER_IMAGE,
  ];
  let r = spawnSync("docker", brokerArgs, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`broker run failed (status=${r.status}): ${r.stderr}`);
  }

  // ── Launch kernel ─────────────────────────────────────────────────
  const kernelName = `switchroom-phase2c-kernel-${process.pid}-${RUN_ID.slice(0, 8)}`;
  try { execSync(`docker rm -f ${kernelName}`, { stdio: "ignore" }); } catch { /* */ }
  const kernelArgs = [
    "run",
    "-d",
    "--name", kernelName,
    ...labelArgv(),
    "--user", "0:0",
    "-v", `${kernelSocketParent}:/run/switchroom/kernel`,
    "-v", `${kernelStateDir}:/state/approvals`,
    "-e", "SWITCHROOM_KERNEL_DB_PATH=/state/approvals/kernel.db",
    "-e", "SWITCHROOM_KERNEL_SOCKET=/run/switchroom/kernel/approval-kernel.sock",
    KERNEL_IMAGE,
  ];
  r = spawnSync("docker", kernelArgs, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`kernel run failed (status=${r.status}): ${r.stderr}`);
  }

  // ── Wait for sockets to bind ──────────────────────────────────────
  const deadline = Date.now() + 20_000;
  const sleep = (): void => { execSync("sleep 0.5"); };
  while (Date.now() < deadline) {
    const brokerOk = AGENTS.every((a) => {
      try {
        const out = execSync(
          `docker exec ${brokerName} stat -c '%F' /run/switchroom/broker/${a}.sock`,
          { stdio: ["ignore", "pipe", "ignore"] },
        ).toString();
        return out.includes("socket");
      } catch { return false; }
    });
    const kernelOk = AGENTS.every((a) => {
      try {
        const out = execSync(
          `docker exec ${kernelName} stat -c '%F' /run/switchroom/kernel/${a}/sock`,
          { stdio: ["ignore", "pipe", "ignore"] },
        ).toString();
        return out.includes("socket");
      } catch { return false; }
    });
    if (brokerOk && kernelOk) break;
    sleep();
  }

  // Open up modes for cross-container connections through the bind mount.
  // Production identity = listener path, NOT file mode (per RFC).
  try {
    execSync(
      `docker exec ${brokerName} sh -c 'chmod 0666 /run/switchroom/broker/*.sock'`,
      { stdio: "ignore" },
    );
  } catch { /* */ }
  try {
    execSync(
      `docker exec ${kernelName} sh -c 'chmod 0666 /run/switchroom/kernel/*/sock && chmod 0755 /run/switchroom/kernel/*'`,
      { stdio: "ignore" },
    );
  } catch { /* */ }

  // ── Unlock the broker (in-container so peercred is satisfied) ─────
  const unlockResult = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      brokerName,
      "bun",
      "-e",
      `const net = require('node:net');
       const c = net.createConnection('/run/switchroom/broker/vault-broker.unlock.sock');
       let buf = '';
       c.on('connect', () => c.write(${JSON.stringify(PASSPHRASE)} + '\\n'));
       c.on('data', d => { buf += d; if (buf.includes('\\n')) { console.log(buf.split('\\n')[0]); c.destroy(); } });
       c.on('error', e => { console.log('ERR:'+e.message); process.exit(1); });
       setTimeout(() => process.exit(0), 1500);`,
    ],
    { encoding: "utf8" },
  );
  if (unlockResult.stdout.trim() !== "OK") {
    throw new Error(`broker unlock failed: ${unlockResult.stdout} / ${unlockResult.stderr}`);
  }

  // ── Launch one agent container per agent ──────────────────────────
  // Each agent container mounts ONLY its own socket dirs:
  //   /run/switchroom/broker  ← broker dir read-only-ish from host (the
  //                             dir is shared, but agent connects only to
  //                             its own <agent>.sock + cross-test attempts
  //                             to others)
  //   /run/switchroom/kernel  ← per-agent kernel subdir contents
  //
  // We override the agent image's CMD with `tail -f /dev/null` so the
  // container stays alive for `docker exec` driving. The agent image
  // ships bun in PATH, so AGENT_NDJSON_SCRIPT works.
  const agentNames = new Map<string, string>();
  for (const a of AGENTS) {
    const containerName = `switchroom-phase2c-agent-${a}-${process.pid}-${RUN_ID.slice(0, 8)}`;
    try { execSync(`docker rm -f ${containerName}`, { stdio: "ignore" }); } catch { /* */ }
    const args = [
      "run",
      "-d",
      "--name", containerName,
      ...labelArgv(),
      "--user", "0:0", // run as root for simplicity; identity is enforced
                       // by the listener's bound path, not the caller UID
      "--entrypoint", "/usr/bin/tini",
      // Mount the broker dir (whole) so the agent can attempt cross-agent
      // sockets too — that's the negative-path test on the broker side.
      "-v", `${brokerSocketDir}:/run/switchroom/broker`,
      // Mount the kernel dir (whole) so the agent can attempt cross-agent
      // dirs too — same rationale, negative-path on kernel side.
      "-v", `${kernelSocketParent}:/run/switchroom/kernel`,
      "-e", `SWITCHROOM_AGENT_NAME=${a}`,
      "-e", `SWITCHROOM_BROKER_SOCKET=/run/switchroom/broker/${a}.sock`,
      "-e", `SWITCHROOM_KERNEL_SOCKET=/run/switchroom/kernel/${a}/sock`,
      "-e", `SWITCHROOM_RUNTIME=docker`,
      AGENT_IMAGE,
      "--",
      "tail",
      "-f",
      "/dev/null",
    ];
    const ar = spawnSync("docker", args, { encoding: "utf8" });
    if (ar.status !== 0) {
      throw new Error(`agent run failed (${a}): ${ar.stderr}`);
    }
    agentNames.set(a, containerName);
  }

  // Sanity — bun is reachable in each agent container.
  for (const [, cn] of agentNames) {
    const probe = spawnSync("docker", ["exec", cn, "bun", "--version"], {
      encoding: "utf8",
    });
    if (probe.status !== 0) {
      throw new Error(`agent container ${cn} missing bun: ${probe.stderr}`);
    }
  }

  fx = {
    workdir,
    brokerSocketDir,
    kernelSocketParent,
    brokerName,
    kernelName,
    agentNames,
    initialBrokerSchemaVersion: readSchemaVersion(brokerName, "/root/.switchroom/vault-grants.db"),
    initialKernelSchemaVersion: readSchemaVersion(kernelName, "/state/approvals/kernel.db"),
    prodSnapshot,
  };
}, 120_000);

afterAll(() => {
  if (fx) {
    for (const cn of [
      fx.brokerName,
      fx.kernelName,
      ...fx.agentNames.values(),
    ]) {
      try { execSync(`docker rm -f ${cn}`, { stdio: "ignore" }); } catch { /* */ }
    }
    safeLabelTeardownPhase2c();
    try { rmSync(fx.workdir, { recursive: true, force: true }); } catch { /* */ }

    // Production-host safety — HARD assertion. See ./_prod-snapshot.ts
    // for the cross-phase filter rationale.
    expectNoProdDrift(fx.prodSnapshot, captureProdSnapshot());
  }
}, 90_000);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!imagesOk)(
  "phase2c — broker + kernel + agent integration",
  () => {
    it(
      "each agent's full flow: broker get + kernel approval_request + lookup, all from inside its own container",
      () => {
        if (!fx) throw new Error("fixture not initialized");

        for (const a of AGENTS) {
          const cn = fx.agentNames.get(a)!;

          // Broker: each agent reads its own scoped secret.
          const brokerResp = agentNdjson(
            cn,
            `/run/switchroom/broker/${a}.sock`,
            { v: 1, op: "get", key: `${a}_key` },
          ) as NdjsonResult;
          expect(brokerResp.ok).toBe(true);
          const brokerJson = brokerResp.parsed as { ok: boolean; entry?: { value: string } };
          expect(brokerJson.ok).toBe(true);
          expect(brokerJson.entry?.value).toBe(`secret-for-${a}`);

          // Kernel: open an approval_request for self.
          const reqResp = agentNdjson(
            cn,
            `/run/switchroom/kernel/${a}/sock`,
            {
              v: 1,
              op: "approval_request",
              agent_unit: a,
              scope: `secret:${a.toUpperCase()}_KEY`,
              action: "read",
              approver_set: ["operator"],
              why: `phase2c integration smoke test for ${a}`,
              ttl_ms: 60_000,
            },
          ) as NdjsonResult;
          expect(reqResp.ok).toBe(true);
          const reqJson = reqResp.parsed as {
            ok: boolean;
            kind?: string;
            state?: string;
            request_id?: string;
          };
          expect(reqJson.ok).toBe(true);
          expect(reqJson.kind).toBe("approval_request");
          expect(reqJson.state).toBe("pending");
          expect(typeof reqJson.request_id).toBe("string");

          // Kernel: short-poll lookup — emulates waitForApproval's poll
          // step. Without a recorded decision the kernel reports
          // no_decision (or pending) for this (agent, scope, action) tuple.
          const lookResp = agentNdjson(
            cn,
            `/run/switchroom/kernel/${a}/sock`,
            {
              v: 1,
              op: "approval_lookup",
              agent_unit: a,
              scope: `secret:${a.toUpperCase()}_KEY`,
              action: "read",
              current_approver_set: ["operator"],
            },
          ) as NdjsonResult;
          expect(lookResp.ok).toBe(true);
          const lookJson = lookResp.parsed as { ok: boolean; state?: string };
          expect(lookJson.ok).toBe(true);
          expect(["no_decision", "pending"]).toContain(lookJson.state);
        }
      },
      120_000,
    );

    it(
      "cross-agent denial holds at BOTH layers (broker socket-path ACL + kernel agent-name ACL)",
      () => {
        if (!fx) throw new Error("fixture not initialized");

        // 6 (i,j i!=j) pairs across alice/bob/carol — denial expected at
        // BOTH the broker (socket-path identity) AND the kernel (path-based
        // agent_unit assertion).
        const brokerDenials: string[] = [];
        const kernelDenials: string[] = [];
        for (const requester of AGENTS) {
          for (const target of AGENTS) {
            if (requester === target) continue;
            const cn = fx.agentNames.get(requester)!;

            // Broker: requester connects to its own socket and asks for
            // target's key. Identity comes from the listener path, not
            // the payload, so this MUST be DENIED.
            const bResp = agentNdjson(
              cn,
              `/run/switchroom/broker/${requester}.sock`,
              { v: 1, op: "get", key: `${target}_key` },
            ) as NdjsonResult;
            expect(bResp.ok).toBe(true);
            const bJson = bResp.parsed as { ok: boolean; code?: string; msg?: string };
            expect(bJson.ok).toBe(false);
            expect(bJson.code).toBe("DENIED");
            brokerDenials.push(`${requester}->${target}:${bJson.code}`);

            // Kernel: requester's agent connects on its own kernel socket
            // but claims target's agent_unit on the wire. Path-based
            // ACL MUST DENY.
            const kResp = agentNdjson(
              cn,
              `/run/switchroom/kernel/${requester}/sock`,
              {
                v: 1,
                op: "approval_request",
                agent_unit: target,
                scope: `secret:${target.toUpperCase()}_KEY`,
                action: "read",
                approver_set: ["operator"],
              },
            ) as NdjsonResult;
            expect(kResp.ok).toBe(true);
            const kJson = kResp.parsed as { ok: boolean; code?: string; msg?: string };
            expect(kJson.ok).toBe(false);
            expect(kJson.code).toBe("DENIED");
            expect(kJson.msg ?? "").toMatch(/mismatch/i);
            kernelDenials.push(`${requester}->${target}:${kJson.code}`);
          }
        }
        expect(brokerDenials).toHaveLength(6);
        expect(kernelDenials).toHaveLength(6);
      },
      180_000,
    );

    it(
      "concurrent flows: 3 agents × 5 iterations of mixed broker+kernel calls in flight without deadlock",
      async () => {
        if (!fx) throw new Error("fixture not initialized");

        // Five iterations per agent. Each iteration fires a broker `get`
        // AND a kernel `approval_request` in parallel; then waits both.
        // Mixed across all 3 agents simultaneously → 30 in-flight ops at
        // peak. Timeout budget per call is 5s; total wall budget is
        // generous so a slow CI host doesn't false-fail.
        const ITERATIONS = 5;
        const tasks: Promise<{ kind: string; ok: boolean }>[] = [];
        for (let i = 0; i < ITERATIONS; i++) {
          for (const a of AGENTS) {
            const cn = fx.agentNames.get(a)!;
            tasks.push(
              new Promise((res) => {
                const r = agentNdjson(cn, `/run/switchroom/broker/${a}.sock`, {
                  v: 1, op: "get", key: `${a}_key`,
                });
                const j = r.parsed as { ok: boolean } | null;
                res({ kind: `broker:${a}:${i}`, ok: r.ok && j?.ok === true });
              }),
            );
            tasks.push(
              new Promise((res) => {
                const r = agentNdjson(cn, `/run/switchroom/kernel/${a}/sock`, {
                  v: 1,
                  op: "approval_request",
                  agent_unit: a,
                  scope: `secret:${a.toUpperCase()}_KEY`,
                  action: "read",
                  approver_set: ["operator"],
                  why: `phase2c concurrent ${a} iter=${i}`,
                  ttl_ms: 60_000,
                });
                const j = r.parsed as { ok: boolean } | null;
                res({ kind: `kernel:${a}:${i}`, ok: r.ok && j?.ok === true });
              }),
            );
          }
        }
        const results = await Promise.all(tasks);
        const failed = results.filter((r) => !r.ok);
        expect(failed).toEqual([]);
        expect(results).toHaveLength(ITERATIONS * AGENTS.length * 2);
      },
      240_000,
    );

    it(
      "schema-stability invariant — broker.db AND kernel.db PRAGMA schema_version unchanged",
      () => {
        if (!fx) throw new Error("fixture not initialized");
        // Broker grants DB.
        const afterBroker = readSchemaVersion(
          fx.brokerName,
          "/root/.switchroom/vault-grants.db",
        );
        if (fx.initialBrokerSchemaVersion !== null && afterBroker !== null) {
          expect(afterBroker).toBe(fx.initialBrokerSchemaVersion);
        } else {
          expect(fx.initialBrokerSchemaVersion).toBe(afterBroker);
        }
        // Kernel approvals DB.
        const afterKernel = readSchemaVersion(
          fx.kernelName,
          "/state/approvals/kernel.db",
        );
        if (fx.initialKernelSchemaVersion !== null && afterKernel !== null) {
          expect(afterKernel).toBe(fx.initialKernelSchemaVersion);
        } else {
          expect(fx.initialKernelSchemaVersion).toBe(afterKernel);
        }
      },
      30_000,
    );
  },
);

describe.skipIf(imagesOk)(
  "phase2c — sentinel (images not built)",
  () => {
    it("documents the build instructions visible to operators", () => {
      const reason = !dockerOk
        ? "docker daemon unreachable"
        : `one or more required images missing.\nBuild with:\n` +
          `  npm run build\n` +
          `  docker buildx build --build-arg BASE_IMAGE=switchroom/base:phase1b-test \\\n` +
          `    -t ${BROKER_IMAGE} -f docker/Dockerfile.broker --load .\n` +
          `  docker buildx build --build-arg BASE_IMAGE=switchroom/base:phase1b-test \\\n` +
          `    -t ${KERNEL_IMAGE} -f docker/Dockerfile.kernel --load .\n` +
          `  docker buildx build --build-arg BASE_IMAGE=switchroom/base:phase1b-test \\\n` +
          `    -t ${AGENT_IMAGE} -f docker/Dockerfile.agent --load .`;
      expect(reason).toBeTruthy();
    });
  },
);
