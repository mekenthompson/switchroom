/**
 * switchroom-hostd server — listens on per-agent Unix-domain sockets,
 * dispatches a closed set of operator-only switchroom verbs to the
 * host CLI.
 *
 * Phase 1 scope (per RFC C, `docs/rfcs/host-control-daemon.md`):
 *   - `agent_restart`  (mutating; self → any caller, cross-agent →
 *                      admin)
 *   - `upgrade_status` (read-only; any)
 *   - `get_status`     (lookup of prior async mutations; gate matches
 *                      the original verb)
 *
 * Deferred to Phase 2: `update_check`, `update_apply`, `apply`,
 * `agent_start`, `agent_stop`, `reconcile`. Those need
 * operator-passphrase attestation (delegated to the broker) and a
 * non-trivial gateway integration; landing them in this PR would
 * balloon scope past one reviewable unit.
 */

import { createServer, type Server, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { mkdir, chmod, chown, unlink, appendFile } from "node:fs/promises";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  decodeRequest,
  encodeResponse,
  deniedResponse,
  errorResponse,
  IDEMPOTENCY_WINDOW_MS,
  MAX_FRAME_BYTES,
  type HostdRequest,
  type HostdResponse,
  type Result,
} from "./protocol.js";
import { socketPathToIdentity, type SocketIdentity } from "./peercred.js";

/** Subset of switchroom.yaml the daemon reads. */
export interface ServerConfig {
  /** Per-agent admin flag — drives the verb gate. Daemon reads this
   *  once at startup (Phase 1) and reloads on SIGHUP (post-Phase-1
   *  follow-up). */
  agents: Record<string, { admin?: boolean }>;
}

export interface ServerOptions {
  /** Operator HOME — daemon binds sockets under `<homeDir>/.switchroom/hostd/<agent>/sock`. */
  homeDir: string;
  /** Map of agent name → UID for chown. The daemon needs CHOWN/FOWNER
   *  caps (or to run as the operator owning the agent UIDs) to set
   *  ownership; mirrors the broker's pattern at
   *  `src/agents/compose.ts:549-552`. */
  agentUids: Record<string, number>;
  /** Config — admin gating. */
  config: ServerConfig;
  /** Absolute path to the host `switchroom` binary. Default: lookup on
   *  PATH at request time. */
  switchroomBin?: string;
  /** Audit-log path. Default: `<homeDir>/.switchroom/host-control-audit.log`. */
  auditLogPath?: string;
  /** Allow non-Linux dev mode (skips chown). */
  allowNonLinux?: boolean;
}

/**
 * Per-request status snapshot retained for `get_status` lookups.
 * Capped at the most recent N requests per daemon process; entries
 * older than the cap age get evicted lazily.
 */
interface StatusEntry {
  request_id: string;
  caller: SocketIdentity;
  op: string;
  result: Result;
  exit_code: number | null;
  /** ms since epoch */
  started_at: number;
  finished_at: number | null;
  stdout_tail: string;
  stderr_tail: string;
  error?: string;
}

const STATUS_RETENTION_MS = 10 * 60 * 1000; // 10 min
const STATUS_MAX_ENTRIES = 256;

/** Tail length for stdout/stderr in audit + response frames. */
const TAIL_BYTES = 4096;

export class HostdServer {
  // One Server per bound socket path. `node:net.Server.listen` can
  // only be called once per instance — to bind N agent sockets we
  // need N servers. Map: bindPath → Server.
  private servers = new Map<string, Server>();
  private statusByRequestId = new Map<string, StatusEntry>();
  /** idempotency_key → request_id of the canonical (first) call. */
  private idempotencyKeys = new Map<string, { request_id: string; ts: number }>();

  constructor(private opts: ServerOptions) {}

  /** Start listening on every configured agent's socket. */
  async start(): Promise<void> {
    const hostdDir = join(this.opts.homeDir, ".switchroom", "hostd");
    await mkdir(hostdDir, { recursive: true });
    // 0o755 (not 0o700) so the operator's compose generator can
    // existsSync(<hostdDir>/<agentName>) at apply time — the dir
    // listing is needed to emit the per-agent bind mount into the
    // agent service. Confidentiality of incoming connections is
    // enforced by the SOCKET mode (0o660) + chown-to-agent-uid below,
    // not by the dir mode. The dir only ever contains other agent
    // subdirs + sockets, all of which are themselves access-controlled.
    // Pre-fix the daemon bound sockets but compose silently skipped
    // every bind mount because the operator's uid couldn't traverse
    // a root-owned 0700 dir, so no agent could ever reach the daemon.
    await chmod(hostdDir, 0o755).catch(() => undefined);

    const agentNames = Object.keys(this.opts.agentUids).sort();
    if (agentNames.length === 0) {
      // No admin agents declared yet. Phase 1 no-op exit — the
      // compose generator only emits the daemon when there's at
      // least one admin agent, so reaching this branch in production
      // would be a config-generator bug.
      return;
    }

    // Partial-bind safety: if listen() rejects for agent N, the
    // sockets bound for agents 0..N-1 are still live. Without
    // cleanup the daemon would leave half its sockets in service
    // and main.ts would exit with the exception, stranding the
    // bound paths on disk. Wrap each iteration; on first failure,
    // tear down everything we've bound and rethrow.
    try {
      for (const name of agentNames) {
        const dir = join(hostdDir, name);
        const sockPath = join(dir, "sock");
        await mkdir(dir, { recursive: true });
        // Same rationale as the parent dir above: 0o755 so the
        // operator's `existsSync(<dir>)` in compose.ts succeeds;
        // socket-level mode + chown is the security boundary.
        await chmod(dir, 0o755).catch(() => undefined);
        if (existsSync(sockPath)) await unlink(sockPath).catch(() => undefined);

        const server = createServer((socket) =>
          this.onConnection(socket, sockPath),
        );
        server.on("error", (err) => {
          process.stderr.write(`hostd: server error on ${sockPath}: ${err.message}\n`);
        });

        await new Promise<void>((resolve, reject) => {
          server.listen(sockPath, () => resolve());
          server.once("error", reject);
        });
        await chmod(sockPath, 0o660).catch(() => undefined);
        if (process.platform === "linux" && !this.opts.allowNonLinux) {
          await chown(sockPath, this.opts.agentUids[name]!, -1).catch((err) => {
            process.stderr.write(
              `hostd: chown(${sockPath}, uid=${this.opts.agentUids[name]}): ${(err as Error).message}\n`,
            );
          });
        }
        this.servers.set(sockPath, server);
      }
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /** Stop the server and clean up sockets. Idempotent. */
  async stop(): Promise<void> {
    const paths = [...this.servers.keys()];
    for (const [, server] of this.servers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.servers.clear();
    for (const s of paths) {
      await unlink(s).catch(() => undefined);
    }
  }

  /** Test/observation hook — paths the server actually bound to. */
  getBoundPaths(): readonly string[] {
    return [...this.servers.keys()];
  }

  /** Test hook — clear retained status entries. */
  resetForTest(): void {
    this.statusByRequestId.clear();
    this.idempotencyKeys.clear();
  }

  private onConnection(socket: Socket, bindPath: string): void {
    // The bind path is closure-captured at server creation in
    // start() — one Server per agent path. This is the trusted
    // identity source: socketPathToIdentity parses the daemon's
    // OWN bind path, which an agent cannot influence.
    const identity = socketPathToIdentity(bindPath);
    if (!identity) {
      // Path doesn't parse — close. Caller can't be identified.
      // (Should be impossible with our own listen paths, but be
      // defensive.)
      socket.end();
      return;
    }

    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      // DoS guard: a malicious caller can stream bytes without ever
      // sending a newline and OOM the daemon if we just keep
      // appending. Cap the buffer at 2x MAX_FRAME_BYTES (same shape
      // as the client's incoming cap at client.ts) — one valid frame
      // plus a half-frame slack before we hard-close. The cap is
      // checked on every chunk, before the newline-search, so the
      // attacker can't slip past by chunk-aligning.
      if (Buffer.byteLength(buf, "utf8") > MAX_FRAME_BYTES * 2) {
        process.stderr.write(
          `hostd: closing connection — request exceeded ${MAX_FRAME_BYTES * 2} bytes without a newline\n`,
        );
        socket.destroy();
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      this.handleLine(line, identity, socket).catch((err) => {
        process.stderr.write(`hostd: handler error: ${(err as Error).message}\n`);
        socket.end();
      });
    });
    socket.on("error", () => undefined);
  }

  private async handleLine(
    line: string,
    caller: SocketIdentity,
    socket: Socket,
  ): Promise<void> {
    let req: HostdRequest;
    try {
      req = decodeRequest(line);
    } catch (err) {
      // Echo the caller's request_id when we can extract one (helps
      // them correlate the denial to their request); fall back to a
      // literal sentinel when the line wasn't even valid JSON or
      // didn't carry the field.
      let echoId = "malformed-request";
      try {
        const obj = JSON.parse(line) as { request_id?: unknown };
        if (typeof obj.request_id === "string" && obj.request_id.length > 0) {
          echoId = obj.request_id;
        }
      } catch {
        // Non-JSON line — keep the sentinel.
      }
      socket.write(
        encodeResponse(deniedResponse(echoId, `bad request: ${(err as Error).message}`)),
      );
      socket.end();
      return;
    }

    const idempotencyKey = req.idempotency_key ?? req.request_id;
    const now = Date.now();
    this.evictExpiredIdempotency(now);
    const prior = this.idempotencyKeys.get(idempotencyKey);
    if (prior && now - prior.ts < IDEMPOTENCY_WINDOW_MS) {
      // Reuse the prior response if available. Note: only mutating
      // verbs (agent_restart) call recordStatus(), so the lookup
      // only hits a cached status for those. Read-only verbs
      // (upgrade_status, get_status) flow through here and re-run —
      // intentional: idempotency is about *mutation* safety, not
      // bandwidth saving on read-only queries.
      const cached = this.statusByRequestId.get(prior.request_id);
      if (cached) {
        socket.write(encodeResponse(this.statusEntryToResponse(req.request_id, cached)));
        socket.end();
        return;
      }
    }
    this.idempotencyKeys.set(idempotencyKey, { request_id: req.request_id, ts: now });

    const denied = this.checkGate(req, caller);
    if (denied) {
      const resp = deniedResponse(req.request_id, denied);
      await this.writeAudit({ caller, req, resp });
      socket.write(encodeResponse(resp));
      socket.end();
      return;
    }

    const started = Date.now();
    let resp: HostdResponse;
    try {
      switch (req.op) {
        case "agent_restart":
          resp = await this.handleAgentRestart(req, caller, started);
          break;
        case "upgrade_status":
          resp = await this.handleUpgradeStatus(req, started);
          break;
        case "get_status":
          resp = this.handleGetStatus(req, caller, started);
          break;
      }
    } catch (err) {
      resp = errorResponse(
        req.request_id,
        `hostd dispatch failed: ${(err as Error).message}`,
        Date.now() - started,
      );
    }
    await this.writeAudit({ caller, req, resp });
    socket.write(encodeResponse(resp));
    socket.end();
  }

  /**
   * Per-verb gate. Returns null when the call is allowed, or a string
   * describing the denial reason. RFC C §5.4 trust model:
   *
   *   - any   — upgrade_status (and self-targeted agent_restart)
   *   - admin — cross-agent agent_restart
   *   - admin + operator-attest — update_apply / apply (Phase 2)
   */
  private checkGate(req: HostdRequest, caller: SocketIdentity): string | null {
    if (caller.kind === "operator") return null;
    const callerAdmin =
      this.opts.config.agents[caller.name]?.admin === true;
    switch (req.op) {
      case "upgrade_status":
        return null;
      case "agent_restart":
        if (req.args.name === caller.name) return null; // self-target
        return callerAdmin
          ? null
          : `agent_restart cross-agent requires admin: true on caller "${caller.name}"`;
      case "get_status": {
        // The lookup is admin-or-self relative to the *original*
        // request. Phase 1 stores caller on the entry; admins or the
        // original caller can read it. Anything else is denied to
        // avoid information leakage across agents.
        const entry = this.statusByRequestId.get(req.args.target_request_id);
        if (!entry) {
          // No leak: return "denied: not found" the same as the
          // unauthorized case so callers can't probe for the
          // existence of request_ids that aren't theirs.
          return `get_status: request_id not found or not visible to caller "${caller.name}"`;
        }
        const ownCall =
          entry.caller.kind === caller.kind &&
          ("name" in entry.caller && "name" in caller
            ? entry.caller.name === caller.name
            : true);
        if (ownCall || callerAdmin) return null;
        return `get_status: request_id not found or not visible to caller "${caller.name}"`;
      }
    }
  }

  private async handleAgentRestart(
    req: Extract<HostdRequest, { op: "agent_restart" }>,
    caller: SocketIdentity,
    started: number,
  ): Promise<HostdResponse> {
    const args = ["agent", "restart", req.args.name];
    if (req.args.force) args.push("--force");
    const entry: StatusEntry = {
      request_id: req.request_id,
      caller,
      op: req.op,
      result: "started",
      exit_code: null,
      started_at: started,
      finished_at: null,
      stdout_tail: "",
      stderr_tail: "",
    };
    this.recordStatus(entry);

    // Fire-and-forget: return `started` immediately, drive the child
    // detached. The status entry gets updated on completion so a
    // later `get_status` poll can surface the outcome.
    this.runSwitchroom(args)
      .then((res) => {
        entry.result = res.exit_code === 0 ? "completed" : "error";
        entry.exit_code = res.exit_code;
        entry.finished_at = Date.now();
        entry.stdout_tail = tail(res.stdout);
        entry.stderr_tail = tail(res.stderr);
      })
      .catch((err) => {
        entry.result = "error";
        entry.exit_code = null;
        entry.finished_at = Date.now();
        entry.error = (err as Error).message;
      });

    return {
      v: 1,
      request_id: req.request_id,
      result: "started",
      exit_code: null,
      duration_ms: Date.now() - started,
    };
  }

  private async handleUpgradeStatus(
    req: Extract<HostdRequest, { op: "upgrade_status" }>,
    started: number,
  ): Promise<HostdResponse> {
    const res = await this.runSwitchroom(["update", "--status"]);
    const result: Result = res.exit_code === 0 ? "completed" : "error";
    return {
      v: 1,
      request_id: req.request_id,
      result,
      exit_code: res.exit_code,
      duration_ms: Date.now() - started,
      stdout_tail: tail(res.stdout),
      stderr_tail: tail(res.stderr),
    };
  }

  private handleGetStatus(
    req: Extract<HostdRequest, { op: "get_status" }>,
    _caller: SocketIdentity,
    started: number,
  ): HostdResponse {
    const entry = this.statusByRequestId.get(req.args.target_request_id);
    // checkGate already rejected unknown / cross-agent cases above.
    // If we got here `entry` must exist.
    if (!entry) {
      return errorResponse(
        req.request_id,
        `get_status: internal: entry missing despite gate accept`,
        Date.now() - started,
      );
    }
    return this.statusEntryToResponse(req.request_id, entry);
  }

  private statusEntryToResponse(
    request_id: string,
    entry: StatusEntry,
  ): HostdResponse {
    return {
      v: 1,
      request_id,
      result: entry.result,
      exit_code: entry.exit_code,
      duration_ms: (entry.finished_at ?? Date.now()) - entry.started_at,
      stdout_tail: entry.stdout_tail || undefined,
      stderr_tail: entry.stderr_tail || undefined,
      error: entry.error,
    };
  }

  private recordStatus(entry: StatusEntry): void {
    this.statusByRequestId.set(entry.request_id, entry);
    // Evict oldest if over cap.
    if (this.statusByRequestId.size > STATUS_MAX_ENTRIES) {
      const oldest = [...this.statusByRequestId.values()].sort(
        (a, b) => a.started_at - b.started_at,
      )[0];
      if (oldest) this.statusByRequestId.delete(oldest.request_id);
    }
    // Lazy expiration sweep — every insert.
    const cutoff = Date.now() - STATUS_RETENTION_MS;
    for (const [id, e] of this.statusByRequestId) {
      if (e.started_at < cutoff) this.statusByRequestId.delete(id);
    }
  }

  private evictExpiredIdempotency(now: number): void {
    for (const [k, v] of this.idempotencyKeys) {
      if (now - v.ts >= IDEMPOTENCY_WINDOW_MS) this.idempotencyKeys.delete(k);
    }
  }

  private async writeAudit(args: {
    caller: SocketIdentity;
    req: HostdRequest;
    resp: HostdResponse;
  }): Promise<void> {
    const path =
      this.opts.auditLogPath ??
      join(this.opts.homeDir, ".switchroom", "host-control-audit.log");
    await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
    const row = {
      ts: new Date().toISOString(),
      op: args.req.op,
      caller:
        args.caller.kind === "agent"
          ? { kind: "agent", name: args.caller.name }
          : { kind: "operator" },
      request_id: args.req.request_id,
      result: args.resp.result,
      exit_code: args.resp.exit_code,
      duration_ms: args.resp.duration_ms,
      error: args.resp.error,
    };
    await appendFile(path, JSON.stringify(row) + "\n").catch((err) => {
      process.stderr.write(`hostd: audit append failed: ${(err as Error).message}\n`);
    });
  }

  /** Spawn the host switchroom CLI and capture stdout/stderr. */
  private runSwitchroom(
    args: string[],
  ): Promise<{ exit_code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const bin = this.opts.switchroomBin ?? "switchroom";
      const child = spawn(bin, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.on("error", (err) => reject(err));
      child.on("close", (code) =>
        resolve({ exit_code: code ?? -1, stdout, stderr }),
      );
    });
  }
}

function tail(s: string, bytes = TAIL_BYTES): string {
  if (Buffer.byteLength(s, "utf8") <= bytes) return s;
  return s.slice(s.length - bytes);
}

/** Probe whether an agent socket exists at the canonical in-container
 *  path. Used by gateway integration (Phase 2) to decide between
 *  daemon-call vs spawn-detached fallback. */
export function hostdSocketPathForAgent(agentName: string): string {
  return `/run/switchroom/hostd/${agentName}/sock`;
}

/** True iff the daemon's per-agent socket is bound (Linux UDS check). */
export function isHostdReachable(agentName: string): boolean {
  const path = hostdSocketPathForAgent(agentName);
  if (!existsSync(path)) return false;
  try {
    const s = statSync(path);
    return s.isSocket();
  } catch {
    return false;
  }
}

// Exported for symmetry with src/vault/broker — most callers use the
// class methods, but tests + cli wrappers reach in.
export { readdirSync };
export { randomUUID };
