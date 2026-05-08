/**
 * Phase 2b — approval kernel IPC integration test (socket-path-as-identity).
 *
 * Acceptance criteria (RFC §Phase 2):
 *
 *   1. Three agents — alice / bob / carol — each connect on their own
 *      per-agent kernel socket (/run/switchroom/kernel/<agent>/sock inside
 *      the kernel container; bound by kernel-server at boot). Each agent's
 *      `approval_request` for its own agent_unit is accepted; cross-agent
 *      claims are DENIED.
 *
 *   2. Cross-agent denial matrix: 6 (i,j i!=j) pairs across alice/bob/carol
 *      all return { ok:false, error:"DENIED", message:/mismatch/ }. Identity
 *      comes from the listener's directory; nothing on the wire can override.
 *
 *   3. waitForApproval-style short-poll works end-to-end across the
 *      container boundary: client sends approval_request, server returns
 *      a request_id, client lookups by (agent_unit, scope, action) and
 *      sees `state: pending` while the nonce is unconsumed.
 *
 *   4. Schema-stability invariant: kernel.db PRAGMA schema_version is
 *      identical pre and post the test traffic. NO migration runs as part
 *      of Phase 2b.
 *
 *   5. Production-host safety: every container carries
 *      `switchroom.test=phase2b` + a per-run UUID. Teardown is exclusively
 *      label-filtered. Pre/post sudo-docker-ps snapshots are diffed and any
 *      production drift is logged loudly. The Coolify et al. containers
 *      MUST be untouched.
 *
 * Skip discipline: cleanly skipped when docker is unreachable OR the
 * phase2b-test kernel image isn't built. Build instructions are in the
 * skip-sentinel `it()` body.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { randomUUID } from "node:crypto";

// ─── Phase 2b label helpers ───────────────────────────────────────────────────
//
// _label-helpers.ts hard-codes "phase1c" — same rationale as Phase 2a, we
// override locally rather than churn the shared helper. Per-run UUID still
// flows through. NEVER touches non-phase2b containers.
const RUN_ID = randomUUID();
const PHASE_LABEL = "switchroom.test=phase2b";

function labelArgv(): string[] {
  return [
    "--label", PHASE_LABEL,
    "--label", `switchroom.test.run=${RUN_ID}`,
  ];
}

function safeLabelTeardownPhase2b(): void {
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

// ─── Image presence ───────────────────────────────────────────────────────────

const KERNEL_IMAGE = "switchroom/kernel:phase2b-test";

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
const imageOk = dockerOk && hasImage(KERNEL_IMAGE);

// ─── Fixture ──────────────────────────────────────────────────────────────────

interface Fixture {
  workdir: string;
  socketParent: string; // host path mounted at /run/switchroom/kernel
  stateDir: string; // host path mounted at /state/approvals
  containerName: string;
  initialSchemaVersion: number | null;
  prodSnapshot: string;
}

let fx: Fixture | null = null;

const AGENTS = ["alice", "bob", "carol"];

function snapshotProductionContainers(): string {
  try {
    return execSync(
      "sudo docker ps --no-trunc --format '{{.Names}}|{{.ID}}|{{.Status}}'",
      { stdio: ["ignore", "pipe", "pipe"] },
    ).toString();
  } catch {
    try {
      return execSync(
        "docker ps --no-trunc --format '{{.Names}}|{{.ID}}|{{.Status}}'",
        { stdio: ["ignore", "pipe", "pipe"] },
      ).toString();
    } catch {
      return "";
    }
  }
}

/**
 * Read PRAGMA schema_version from the kernel.db inside the container.
 * Returns null if the DB hasn't been opened yet.
 */
function readKernelSchemaVersion(containerName: string): number | null {
  const dbPath = "/state/approvals/kernel.db";
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

beforeAll(() => {
  if (!imageOk) return;

  const prodSnapshot = snapshotProductionContainers();

  const workdir = mkdtempSync(join(tmpdir(), "phase2b-kernel-"));
  const socketParent = join(workdir, "kernel-sockets");
  const stateDir = join(workdir, "approvals-state");
  mkdirSync(socketParent, { recursive: true, mode: 0o755 });
  mkdirSync(stateDir, { recursive: true, mode: 0o755 });

  // Pre-create per-agent subdirs at the socket parent. The kernel-server's
  // boot-time agent enumeration walks readdirSync(socketParent) and binds
  // one listener per subdirectory. Without these the server falls through
  // to single-socket fallback mode (not what we want to test).
  for (const a of AGENTS) {
    mkdirSync(join(socketParent, a), { recursive: true, mode: 0o755 });
  }

  const containerName = `switchroom-phase2b-kernel-${process.pid}-${RUN_ID.slice(0, 8)}`;
  // Idempotent best-effort cleanup.
  try {
    execSync(`docker rm -f ${containerName}`, { stdio: "ignore" });
  } catch {
    /* */
  }

  const runArgs = [
    "run",
    "-d",
    "--name", containerName,
    ...labelArgv(),
    "--user", "0:0",
    "-v", `${socketParent}:/run/switchroom/kernel`,
    "-v", `${stateDir}:/state/approvals`,
    "-e", "SWITCHROOM_KERNEL_DB_PATH=/state/approvals/kernel.db",
    "-e", "SWITCHROOM_KERNEL_SOCKET=/run/switchroom/kernel/approval-kernel.sock",
    KERNEL_IMAGE,
  ];
  const r = spawnSync("docker", runArgs, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(
      `docker run failed (status=${r.status}): ${r.stderr}\n` +
      `args: ${runArgs.join(" ")}`,
    );
  }

  // Wait for per-agent sockets to bind.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const allBound = AGENTS.every((a) => {
      try {
        const out = execSync(
          `docker exec ${containerName} stat -c '%F' /run/switchroom/kernel/${a}/sock`,
          { stdio: ["ignore", "pipe", "ignore"] },
        ).toString();
        return out.includes("socket");
      } catch {
        return false;
      }
    });
    if (allBound) break;
    execSync("sleep 0.5");
  }

  // Open up modes for host-side connections (test-only). In production each
  // socket is 0660 owned by the agent UID; the host uid here (1000) needs
  // 0666 to connect via the bind-mount. Production identity is enforced by
  // the listener's bound directory name, NOT the file mode.
  try {
    execSync(
      `docker exec ${containerName} sh -c 'chmod 0666 /run/switchroom/kernel/*/sock && chmod 0755 /run/switchroom/kernel/*'`,
      { stdio: "ignore" },
    );
  } catch {
    /* */
  }

  fx = {
    workdir,
    socketParent,
    stateDir,
    containerName,
    initialSchemaVersion: readKernelSchemaVersion(containerName),
    prodSnapshot,
  };
}, 90_000);

afterAll(() => {
  if (fx) {
    try {
      execSync(`docker rm -f ${fx.containerName}`, { stdio: "ignore" });
    } catch {
      /* */
    }
    safeLabelTeardownPhase2b();
    try {
      rmSync(fx.workdir, { recursive: true, force: true });
    } catch {
      /* */
    }

    // Production-host safety check.
    const after = snapshotProductionContainers();
    // Filter out ALL switchroom phase-test containers (any phase), not just
    // phase2b's — sibling-phase ephemerals running concurrently are normal
    // cross-phase noise, not production drift. See phase2a for rationale.
    const filterPhase = (s: string): string =>
      s.split("\n")
        .filter((l) => l && !/switchroom-phase\d/.test(l))
        .sort()
        .join("\n");
    const beforeFiltered = filterPhase(fx.prodSnapshot);
    const afterFiltered = filterPhase(after);
    // HARD assertion (F1, post-cohesion-review): a console.error here let
    // production drift slip past CI silently. Now we fail the suite if any
    // non-phase2b container appeared, disappeared, or changed status during
    // the run.
    expect(afterFiltered).toBe(beforeFiltered);
  }
}, 60_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ndjsonOnce(socketPath: string, payload: object, timeoutMs = 4000): Promise<unknown> {
  return new Promise((resolveP, rejectP) => {
    const c = connect(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      c.destroy();
      rejectP(new Error(`timeout after ${timeoutMs}ms on ${socketPath}`));
    }, timeoutMs);
    c.on("connect", () => {
      c.write(JSON.stringify(payload) + "\n");
    });
    c.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        const line = buf.slice(0, nl);
        c.destroy();
        try {
          resolveP(JSON.parse(line));
        } catch (e) {
          rejectP(new Error(`parse error: ${(e as Error).message} for line: ${line}`));
        }
      }
    });
    c.on("error", (err) => {
      clearTimeout(timer);
      rejectP(err);
    });
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe.skipIf(!imageOk)(
  "phase2b — kernel IPC with socket-path-as-identity",
  () => {
    it(
      "each agent's per-agent kernel socket accepts only its own agent_unit; cross-agent denied",
      async () => {
        if (!fx) throw new Error("fixture not initialized");

        // Step 1: each agent CAN open an approval_request for itself.
        const requestIds = new Map<string, string>();
        for (const a of AGENTS) {
          const sock = join(fx.socketParent, a, "sock");
          const resp = (await ndjsonOnce(sock, {
            v: 1,
            op: "approval_request",
            agent_unit: a,
            scope: `secret:${a.toUpperCase()}_KEY`,
            action: "read",
            approver_set: ["operator"],
            why: `phase2b smoke test for ${a}`,
            ttl_ms: 60_000,
          })) as {
            ok: boolean;
            kind?: string;
            state?: string;
            request_id?: string;
            expires_at?: number;
          };
          expect(resp.ok).toBe(true);
          expect(resp.kind).toBe("approval_request");
          expect(resp.state).toBe("pending");
          expect(typeof resp.request_id).toBe("string");
          expect((resp.request_id ?? "").length).toBeGreaterThan(0);
          requestIds.set(a, resp.request_id ?? "");
        }

        // Step 2: cross-agent denial matrix — all 6 (i,j i!=j) pairs.
        const denials: Array<{ requester: string; target: string; ok: boolean; code: string | undefined; msg: string | undefined }> = [];
        for (const requester of AGENTS) {
          for (const target of AGENTS) {
            if (requester === target) continue;
            const sock = join(fx.socketParent, requester, "sock");
            const resp = (await ndjsonOnce(sock, {
              v: 1,
              op: "approval_request",
              agent_unit: target, // claim target's identity over requester's socket
              scope: `secret:${target.toUpperCase()}_KEY`,
              action: "read",
              approver_set: ["operator"],
            })) as { ok: boolean; code?: string; msg?: string };
            denials.push({
              requester,
              target,
              ok: resp.ok,
              code: resp.code,
              msg: resp.msg,
            });
            expect(resp.ok).toBe(false);
            expect(resp.code).toBe("DENIED");
            expect(resp.msg ?? "").toMatch(/mismatch/i);
          }
        }
        // Sanity — exactly 6 denials with the right shape.
        expect(denials).toHaveLength(6);

        // Step 3: short-poll lookup works end-to-end. After step 1, each
        // agent has a pending nonce; lookup with a matching scope+action
        // should NOT yet return granted (no consume + record happened).
        for (const a of AGENTS) {
          const sock = join(fx.socketParent, a, "sock");
          const resp = (await ndjsonOnce(sock, {
            v: 1,
            op: "approval_lookup",
            agent_unit: a,
            scope: `secret:${a.toUpperCase()}_KEY`,
            action: "read",
            current_approver_set: ["operator"],
          })) as { ok: boolean; state?: string };
          expect(resp.ok).toBe(true);
          // Without a recorded decision the kernel returns no_decision.
          // (`pending` only surfaces when callers query a by-id path; this
          // op queries by (agent, scope, action) and reports decision
          // state, not nonce state.)
          expect(["no_decision", "pending"]).toContain(resp.state);
        }
      },
      90_000,
    );

    it(
      "schema-stability invariant — kernel.db PRAGMA schema_version unchanged",
      () => {
        if (!fx) throw new Error("fixture not initialized");
        const after = readKernelSchemaVersion(fx.containerName);
        if (fx.initialSchemaVersion !== null && after !== null) {
          expect(after).toBe(fx.initialSchemaVersion);
        } else {
          expect(fx.initialSchemaVersion).toBe(after);
        }
      },
      30_000,
    );

    it(
      "non-approval ops are rejected — kernel does not serve broker ops",
      async () => {
        if (!fx) throw new Error("fixture not initialized");
        const sock = join(fx.socketParent, "alice", "sock");
        const resp = (await ndjsonOnce(sock, {
          v: 1,
          op: "get",
          key: "alice_key",
        })) as { ok: boolean; code?: string; msg?: string };
        expect(resp.ok).toBe(false);
        // The kernel-server returns BAD_REQUEST for non-approval ops.
        // (Decoder may also reject upstream — accept either shape.)
        expect(["BAD_REQUEST", "DENIED"]).toContain(resp.code);
      },
      30_000,
    );
  },
);

describe.skipIf(imageOk)(
  "phase2b — sentinel (image not built)",
  () => {
    it("documents the build instruction visible to operators", () => {
      const reason = !dockerOk
        ? "docker daemon unreachable"
        : `image ${KERNEL_IMAGE} not built — build with:\n` +
          `  npm run build\n` +
          `  docker buildx build --build-arg BASE_IMAGE=switchroom/base:phase1b-test \\\n` +
          `    -t ${KERNEL_IMAGE} -f docker/Dockerfile.kernel --load .`;
      expect(reason).toBeTruthy();
    });
  },
);
