/**
 * vault-broker server — Unix socket daemon that holds the decrypted vault
 * in memory and serves secrets to authorized cron scripts.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SECURITY DESIGN                                                         │
 * │                                                                         │
 * │ Data socket   ~/.switchroom/vault-broker.sock     mode 0600             │
 * │   Serves get / list / status / lock requests.                           │
 * │   Caller is identified via peercred (Linux: ss + /proc).               │
 * │   Each get request goes through ACL before returning any secret.        │
 * │                                                                         │
 * │ Unlock socket ~/.switchroom/vault-broker.unlock.sock  mode 0600         │
 * │   Accepts ONE plaintext line per connection: the vault passphrase.      │
 * │   This is NOT JSON-framed and NOT part of the data protocol.            │
 * │   Only the same UID may connect (enforced by socket file mode 0600 and  │
 * │   confirmed by peercred when available).                                │
 * │   Responds with "OK\n" on success, "ERR <message>\n" on failure.        │
 * │   The passphrase NEVER crosses the data socket.                         │
 * │                                                                         │
 * │ sd_notify     NOTIFY_SOCKET env var (abstract unix socket)              │
 * │   When set, sends "READY=1\n" after both sockets are listening.         │
 * │   No external dependency — implemented inline.                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import * as net from "node:net";
import { mkdirSync, chmodSync, chownSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { allocateAgentUid } from "../../agents/compose.js";
import { dirname, resolve, join, basename } from "node:path";
import * as os from "node:os";
import * as path from "node:path";
import type { SwitchroomConfig } from "../../config/schema.js";
import { openVault, saveVault, type VaultEntry } from "../vault.js";
import { resolvePath } from "../../config/loader.js";
import {
  AutoUnlockDecryptError,
  DEFAULT_AUTO_UNLOCK_PATH,
  MachineIdUnavailableError,
  readAutoUnlockFile,
} from "../auto-unlock.js";
import { identify, socketPathToAgent, type PeerInfo } from "./peercred.js";
import { checkAcl, checkAclByAgent, checkEntryScope, agentSlugFromPeer, parseCronUnit } from "./acl.js";
import {
  decodeRequest,
  encodeResponse,
  errorResponse,
  entryResponse,
  MAX_FRAME_BYTES,
  type BrokerStatus,
} from "./protocol.js";
import { createAuditLogger, callerFromPeer, type AuditLogger } from "./audit-log.js";
import { Database } from "bun:sqlite";
import { mintGrant, validateGrant, revokeGrant, listGrants, migrateGrantsSchema } from "../grants.js";
import { openGrantsDb } from "../grants-db.js";
import {
  requestApproval as kernelRequestApproval,
  lookupDecision as kernelLookupDecision,
  consumeNonce as kernelConsumeNonce,
  revokeDecision as kernelRevokeDecision,
  listDecisions as kernelListDecisions,
  recordDecision as kernelRecordDecision,
  getNonce as kernelGetNonce,
  countPendingNonces,
  computeRetryAfterMs,
  MAX_PENDING_PER_AGENT,
  MAX_PENDING_GLOBAL,
} from "../approvals/kernel.js";

const PID_FILE_DEFAULT = "~/.switchroom/vault-broker.pid";

/** Options accepted by the test-only constructor path. */
export interface BrokerTestOpts {
  /**
   * If provided, the broker starts with these pre-loaded secrets instead of
   * reading from a vault file. Bypasses the passphrase/KDF entirely.
   * DO NOT use outside tests.
   */
  _testSecrets?: Record<string, VaultEntry>;
  /**
   * If provided, use this config instead of loading from configPath.
   */
  _testConfig?: SwitchroomConfig;
  /**
   * If provided, replaces the real `identify()` call on every connection.
   * Returns the PeerInfo the broker should treat as the caller's identity,
   * or null to simulate "unidentified" (broker denies).
   *
   * Without this hook, Linux unit tests can only ever exercise the deny
   * path — the test process isn't a switchroom-…-cron-… cgroup, so the
   * real identify() correctly returns null. Stubbing here lets us cover
   * the happy path (allowed cron unit) without spinning up systemd-run.
   *
   * Production codepath is unchanged: when this is undefined the broker
   * calls the real `identify()`. DO NOT set outside tests.
   */
  _testIdentify?: (socketPath: string, socket: net.Socket) => PeerInfo | null;
  /**
   * If provided, replaces the real audit logger. Use in tests to inject a
   * logger that writes to a tmp file instead of ~/.switchroom/vault-audit.log.
   * DO NOT set outside tests.
   */
  _testAuditLogger?: AuditLogger;
  /**
   * If provided, use this Database handle for the grants DB instead of
   * opening ~/.switchroom/vault-grants.db. Use an in-memory SQLite DB in tests.
   * DO NOT set outside tests.
   */
  _testGrantsDb?: Database;
}

export class VaultBroker {
  private secrets: Record<string, VaultEntry> | null = null;
  /**
   * The vault passphrase, retained in memory for the broker's lifetime
   * to support `op:put` (agent-driven key rotation). Without retention,
   * the broker can decrypt the vault at unlock time and serve reads from
   * the in-memory `secrets` dict, but it cannot re-encrypt to write a
   * new entry — write requires the passphrase to re-derive the AES key.
   *
   * Trade-off: a pwn of the broker process now exposes the passphrase
   * in addition to the already-exposed decrypted secrets. The marginal
   * expansion is small — an attacker who can read process memory can
   * already exfiltrate every secret; retaining the passphrase
   * additionally lets them re-encrypt the on-disk vault. We accept this
   * to enable agent-driven key rotation (e.g. OAuth refresh tokens),
   * which is the only practical way for skills like clerk's calendar
   * skill to keep their refresh-token rotation self-healing without
   * operator hand-holding.
   *
   * Zeroed on lock(); set on unlockFromPassphrase().
   */
  private passphrase: string | null = null;
  private config: SwitchroomConfig | null = null;
  private startedAt: number = Date.now();
  private server: net.Server | null = null;
  private unlockServer: net.Server | null = null;
  /**
   * Phase 2a — per-agent listeners keyed by absolute socket path. Populated
   * by bindAgentSocket(); empty when the broker is in legacy single-socket
   * mode. Each listener carries the trusted agentName established at bind.
   */
  private agentServers: Map<string, { server: net.Server; agentName: string }> =
    new Map();
  private socketPath: string = "";
  private unlockSocketPath: string = "";
  private vaultPath: string = "";
  private auditLogger: AuditLogger;
  private grantsDb: Database;

  constructor(private readonly testOpts: BrokerTestOpts = {}) {
    // Defence-in-depth: BrokerTestOpts is exported (so vitest can construct
    // brokers with seeded state and a stubbed identify()), but each field
    // bypasses a security boundary — secrets pre-load, config injection,
    // and forged peer identity. None of the production callers set these
    // (see src/cli/vault-broker.ts), so we hard-fail outside test runners.
    // vitest sets NODE_ENV=test by default; production builds do not.
    const usingTestOpt =
      testOpts._testSecrets !== undefined ||
      testOpts._testConfig !== undefined ||
      testOpts._testIdentify !== undefined ||
      testOpts._testAuditLogger !== undefined ||
      testOpts._testGrantsDb !== undefined;
    if (usingTestOpt && process.env.NODE_ENV !== "test") {
      throw new Error(
        "VaultBroker: BrokerTestOpts (_testSecrets/_testConfig/_testIdentify/_testAuditLogger/_testGrantsDb) " +
          "must not be set outside tests. Set NODE_ENV=test if you really mean it.",
      );
    }

    // Use the injected logger for tests; create the real one for production.
    // The real logger's path defaults to ~/.switchroom/vault-audit.log.
    this.auditLogger = testOpts._testAuditLogger ?? createAuditLogger();

    // Open (or inject) the grants database. In tests we use :memory: via the
    // _testGrantsDb knob. In production we open the canonical disk path at
    // construction time so the DB handle is ready before the first request.
    if (testOpts._testGrantsDb !== undefined) {
      this.grantsDb = testOpts._testGrantsDb;
    } else {
      this.grantsDb = openGrantsDb();
    }
  }

  /**
   * Start the broker — bind both sockets, write PID file, notify systemd.
   *
   * @param socketPath   Path for the data socket. Created mode 0600.
   * @param configPath   Path to switchroom.yaml (or undefined to auto-detect).
   * @param vaultPath    Path to the encrypted vault file.
   */
  async start(
    socketPath: string,
    configPath: string | undefined,
    vaultPath?: string,
  ): Promise<void> {
    // Linux-only by design (issue #129). The broker's ACL is a cgroup-based
    // identity check on the calling cron systemd unit; that primitive only
    // exists on Linux. On macOS / WSL the only access control would be the
    // socket's file mode (0600), which we don't consider sufficient for
    // multi-cron secret routing. Fail-fast with an actionable message
    // instead of silently degrading.
    //
    // Opt-out for dev / tests: SWITCHROOM_BROKER_ALLOW_NON_LINUX=1.
    if (
      process.platform !== "linux" &&
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX !== "1"
    ) {
      throw new Error(
        `vault-broker is Linux-only (running on ${process.platform}). ` +
        `The broker's ACL relies on cgroup-based systemd unit identification, ` +
        `which is not available on this platform. ` +
        `Use 'switchroom vault get --no-broker' for direct vault access. ` +
        `If you need to run the broker for development on this platform, ` +
        `set SWITCHROOM_BROKER_ALLOW_NON_LINUX=1 — but understand that the ` +
        `broker will accept any same-user caller without per-cron ACL enforcement.`,
      );
    }

    this.socketPath = resolve(socketPath);
    this.unlockSocketPath = this.socketPath.replace(/\.sock$/, ".unlock.sock");
    this.startedAt = Date.now();

    // Load config
    if (this.testOpts._testConfig) {
      this.config = this.testOpts._testConfig;
    } else {
      const { loadConfig } = await import("../../config/loader.js");
      this.config = loadConfig(configPath);
    }

    // Resolve vault path from config or override
    if (vaultPath) {
      this.vaultPath = resolve(vaultPath);
    } else {
      this.vaultPath = resolvePath(this.config.vault?.path ?? "~/.switchroom/vault.enc");
    }

    // Pre-load secrets if test opts provided
    if (this.testOpts._testSecrets !== undefined) {
      this.secrets = { ...this.testOpts._testSecrets };
    }

    // Ensure parent directory exists and is mode 0700.
    //
    // Race-safe construction: we set a strict umask BEFORE mkdir and pass
    // mode:0o700 in the same syscall. mkdir(2) applies (mode & ~umask),
    // so combining umask=0o077 + mode=0o700 yields 0o700 atomically — no
    // mkdir-then-chmod window where the dir is briefly group/world-readable.
    // The trailing chmod is defence-in-depth (idempotent re-assertion if
    // the dir pre-existed with looser perms); we do NOT rely on it to
    // close the race.
    process.umask(0o077);
    const parentDir = dirname(this.socketPath);
    mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(parentDir, 0o700);
    } catch {
      // May fail if directory already has correct perms from another process
    }

    // Remove stale sockets
    for (const p of [this.socketPath, this.unlockSocketPath]) {
      if (existsSync(p)) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }

    // Bind data socket
    await this._bindDataSocket();

    // Bind unlock socket
    await this._bindUnlockSocket();

    // Write PID file
    this._writePidFile();

    // Notify systemd if NOTIFY_SOCKET is set
    this._sdNotify("READY=1\n");

    // Auto-unlock if configured. Tries the machine-bound blob first (the
    // default mechanism, opt-in via vault.broker.autoUnlock=true), then
    // falls back to $CREDENTIALS_DIRECTORY for power users running the
    // broker as a system unit with systemd LoadCredentialEncrypted=.
    this._tryAutoUnlock();

    if (process.platform !== "linux") {
      // Reachable only when SWITCHROOM_BROKER_ALLOW_NON_LINUX=1 was set
      // (the start() guard above would have thrown otherwise). Log a loud
      // warning so dev runs can't be confused with production semantics.
      process.stderr.write(
        `[vault-broker] WARNING: running on ${process.platform} with ` +
        `SWITCHROOM_BROKER_ALLOW_NON_LINUX=1 — peercred ACL is disabled. ` +
        `Access control is socket file mode 0600 ONLY. Do not use this ` +
        `configuration for production secrets.\n`,
      );
    }
  }

  /**
   * Unlock the vault using the given passphrase.
   * Throws VaultError on bad passphrase or unreadable vault.
   *
   * Defends against state-E layout divergence (plan v3 §5 companion):
   * if the broker's resolved vault path is a symlink target inside a
   * dir that ALSO contains a sibling regular `vault.enc` with
   * different content, the broker refuses to unlock with a fatal
   * error pointing at `switchroom apply`. Catches the case where an
   * older switchroom CLI wrote to the legacy path AFTER migration ran
   * (rename-replaces-symlink), leaving broker and CLI writing to
   * different files. Without this check the broker would happily
   * serve stale data until the next `apply`.
   */
  unlockFromPassphrase(passphrase: string): void {
    detectVaultLayoutDrift(this.vaultPath);
    const secrets = openVault(passphrase, this.vaultPath);
    this.secrets = secrets;
    // Retain the passphrase to enable op:put (agent-driven rotation).
    // See the doc-comment on `passphrase` above for the trade-off. The
    // caller should still zero their own copy to minimise overall
    // lifetime; the broker's retained reference is the only authorised
    // long-lived store.
    this.passphrase = passphrase;
  }

  /**
   * Lock the broker — wipe in-memory secrets and null the reference.
   */
  lock(): void {
    if (this.secrets !== null) {
      // Best-effort overwrite of string values before GC
      for (const [, entry] of Object.entries(this.secrets)) {
        try {
          if (entry.kind === "string" || entry.kind === "binary") {
            // Strings are immutable in JS — we can't zero the underlying bytes.
            // We drop the reference and rely on GC. This is a known limitation
            // documented in the security design notes.
            (entry as { value: string }).value = "";
          }
        } catch { /* best-effort */ }
      }
      this.secrets = null;
    }
    // Drop the retained passphrase reference too. Same JS-string-immutability
    // caveat as the secret values above — the underlying bytes survive in the
    // string-pool until GC, but the broker's only reference is gone.
    this.passphrase = null;
  }

  /**
   * Stop the broker — lock, close both sockets, exit.
   */
  stop(): void {
    this.lock();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.unlockServer) {
      this.unlockServer.close();
      this.unlockServer = null;
    }
    // Phase 2a — close per-agent listeners and unlink their socket files.
    for (const [sockPath, entry] of this.agentServers) {
      try { entry.server.close(); } catch { /* ignore */ }
      if (existsSync(sockPath)) {
        try { unlinkSync(sockPath); } catch { /* ignore */ }
      }
    }
    this.agentServers.clear();
    // Clean up socket files
    for (const p of [this.socketPath, this.unlockSocketPath]) {
      if (p && existsSync(p)) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }
    // Remove PID file
    try {
      const pidPath = resolvePath(PID_FILE_DEFAULT);
      if (existsSync(pidPath)) unlinkSync(pidPath);
    } catch { /* ignore */ }
  }

  /**
   * Get the current status (for testing / status RPC).
   */
  getStatus(): BrokerStatus {
    return {
      unlocked: this.secrets !== null,
      keyCount: this.secrets !== null ? Object.keys(this.secrets).length : 0,
      uptimeSec: (Date.now() - this.startedAt) / 1000,
    };
  }

  /**
   * Test-only: return direct reference to the internal secrets map.
   * Used by server tests to verify lock() zeroes state.
   */
  _getSecretsRef(): Record<string, VaultEntry> | null {
    return this.secrets;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Phase 2a — bind a per-agent data listener at a canonical path.
   *
   * The agent name is derived from the socket path (NOT from any caller-
   * supplied argument or wire payload) via socketPathToAgent(). If the path
   * doesn't match the canonical /run/switchroom/broker/<agent>.sock shape,
   * we refuse to bind — fail loud rather than silently fall back to "no
   * agent identity" which would weaken the ACL boundary.
   *
   * The listener stores the agentName inside the broker's agentServers map
   * and threads it through every connection's request handler. A connection
   * accepted on alice.sock can never be served bob's keys, regardless of
   * any wire-payload agent claim.
   */
  bindAgentSocket(socketPath: string): Promise<string> {
    const abs = resolve(socketPath);
    const agentName = socketPathToAgent(abs);
    if (agentName === null) {
      return Promise.reject(
        new Error(
          `bindAgentSocket: socket path '${abs}' does not match the canonical ` +
          `/run/switchroom/broker/<agent>.sock shape — refusing to bind without ` +
          `a verifiable agent identity`,
        ),
      );
    }

    return new Promise((resolveP, rejectP) => {
      // Reset the parent dir back to root:root 0700 BEFORE binding (#881).
      // Subdir-shape paths like /run/switchroom/broker/<agent>/sock have
      // a parent dir backed by a docker named volume; on a previous
      // successful bind we chowned that dir to the agent UID 10xxx 0700
      // (see post-listen chown below). On a fresh broker container — a
      // common path during v0.6 → v0.7 cutover and on any compose-config
      // change — root with cap_drop=ALL + cap_add=[CHOWN,FOWNER,
      // DAC_READ_SEARCH] does NOT hold CAP_DAC_OVERRIDE and cannot
      // unlink stale sockets or create new ones inside a 10xxx-owned
      // 0700 dir. CAP_CHOWN succeeds regardless, so chown'ing the dir
      // back to root recovers from the stale state.
      if (abs.endsWith("/sock")) {
        const dir = abs.slice(0, -"/sock".length);
        if (existsSync(dir)) {
          try { chownSync(dir, 0, 0); } catch { /* outside docker / no CAP_CHOWN */ }
          try { chmodSync(dir, 0o700); } catch { /* idempotent */ }
        }
      }
      // Remove stale socket if present.
      if (existsSync(abs)) {
        try {
          unlinkSync(abs);
        } catch (err) {
          // Don't swallow silently (#881). Surface the path + errno so
          // an operator chasing a "Failed to listen" can see *why* the
          // stale socket couldn't be cleaned up. Continue to listen()
          // either way: it will fail with the same root cause but the
          // diagnostic breadcrumb is now in the log.
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[vault-broker] could not unlink stale socket agent=${agentName} sock=${abs}: ${msg}\n`,
          );
        }
      }
      const server = net.createServer((sock) => {
        this._handleDataConnection(sock, abs, agentName);
      });
      server.on("error", (err) => rejectP(err));
      server.listen(abs, () => {
        try { chmodSync(abs, 0o660); } catch { /* ignore */ }
        // Chown the socket (and, for subdir-shape paths, the parent dir
        // mount point) to the agent UID so a non-root agent container
        // — running as `user: <uid>:<uid>` per compose — can connect.
        // The broker runs root-in-container with cap_drop=ALL +
        // cap_add=[CHOWN, FOWNER, DAC_READ_SEARCH], so chown succeeds
        // here. Mirrors `kernel-server.ts:bindAgentSocket`. Order
        // matters: chown AFTER listen() so root could write into the
        // (still-root-owned) parent dir to create the socket node.
        // Errors swallowed for non-docker dev/test runs where CAP_CHOWN
        // isn't held (callers run as the same UID as agents).
        try {
          const uid = allocateAgentUid(agentName);
          try { chownSync(abs, uid, uid); } catch { /* see above */ }
          if (abs.endsWith("/sock")) {
            const dir = abs.slice(0, -"/sock".length);
            try { chownSync(dir, uid, uid); } catch { /* see above */ }
          }
        } catch {
          // allocateAgentUid is deterministic and pure; swallow only to
          // protect the listen() callback from any unexpected throw.
        }
        this.agentServers.set(abs, { server, agentName });
        resolveP(agentName);
      });
    });
  }

  private _bindDataSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this._handleDataConnection(socket);
      });

      server.on("error", (err) => {
        reject(err);
      });

      server.listen(this.socketPath, () => {
        try {
          chmodSync(this.socketPath, 0o600);
        } catch { /* ignore */ }
        this.server = server;
        resolve();
      });
    });
  }

  private _bindUnlockSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this._handleUnlockConnection(socket);
      });

      server.on("error", (err) => {
        reject(err);
      });

      server.listen(this.unlockSocketPath, () => {
        try {
          chmodSync(this.unlockSocketPath, 0o600);
        } catch { /* ignore */ }
        this.unlockServer = server;
        resolve();
      });
    });
  }

  private _handleDataConnection(
    socket: net.Socket,
    listenerSocketPath: string = this.socketPath,
    agentName: string | null = null,
  ): void {
    // Identify peer immediately on accept (Linux only). Pass the accepted
    // socket so identify() can use SO_PEERCRED via bun:ffi (bun runtime) or
    // pin its ss-output lookup to the server-side fd's inode (node runtime).
    // Without the socket, identify() falls back to the legacy first-row-wins
    // ss lookup which has a documented concurrency hazard. See issue #129.
    //
    // Phase 2a (agent-bound listener): peercred is INFORMATIONAL. The
    // trusted agent identity came from the listener's bind-time socket
    // path; peercred only gives us a peer_uid for the audit row. ACL does
    // not consult `peer` on the agent-bound path.
    let peer: PeerInfo | null = null;
    if (process.platform === "linux") {
      peer = this.testOpts._testIdentify
        ? this.testOpts._testIdentify(listenerSocketPath, socket)
        : identify(listenerSocketPath, socket);
    }

    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");

      // Guard against oversized buffers (>64 KiB without a newline)
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        const resp = encodeResponse(
          errorResponse("BAD_REQUEST", "Frame exceeds 64 KiB limit"),
        );
        socket.write(resp);
        socket.destroy();
        return;
      }

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trimEnd();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        this._handleRequest(socket, peer, line, agentName);
      }
    });

    socket.on("error", () => {
      socket.destroy();
    });
  }

  private async _handleRequest(
    socket: net.Socket,
    peer: import("./peercred.js").PeerInfo | null,
    line: string,
    agentName: string | null = null,
  ): Promise<void> {
    let req: ReturnType<typeof import("./protocol.js").decodeRequest>;
    try {
      req = decodeRequest(line);
    } catch (err) {
      const resp = encodeResponse(
        errorResponse(
          "BAD_REQUEST",
          err instanceof Error ? err.message : "Malformed request",
        ),
      );
      socket.write(resp);
      return;
    }

    // Derive audit identity fields from peer (already computed by peercred at
    // connection accept time — do NOT re-derive here).
    //
    // Phase 2a: when agentName is set (the listener was bound on a per-agent
    // socket), the trusted identity is the agent slug — caller becomes
    // "agent:<name>" and peercred uid + cgroup ride along as informational
    // fields so audit reviewers can correlate against the host UID table.
    const auditPid = peer?.pid ?? process.pid;
    const auditCaller =
      agentName !== null
        ? `agent:${agentName}`
        : peer !== null
          ? callerFromPeer(peer)
          : `pid:${process.pid}`;
    const auditCgroup = peer?.systemdUnit ?? undefined;
    const auditPeerUid = peer?.uid;
    const auditAgentName = agentName ?? undefined;

    // Inject the Phase 2a fields onto every audit row from this connection
    // without rewriting every call site. The base logger ignores unknown
    // fields under JSON.stringify, so this is purely additive on the wire.
    const writeAudit = (
      entry: import("./audit-log.js").AuditEntry,
    ): void => {
      this.auditLogger.write({
        ...entry,
        peer_uid: entry.peer_uid ?? auditPeerUid,
        agent_name: entry.agent_name ?? auditAgentName,
      });
    };

    // Handle each op
    if (req.op === "status") {
      // status is an informational op — not audited (no secret access, no ACL decision)
      const status = this.getStatus();
      socket.write(
        encodeResponse({ ok: true, status }),
      );
      return;
    }

    if (req.op === "lock") {
      this.lock();
      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "lock",
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: "allowed",
      });
      socket.write(encodeResponse({ ok: true, locked: true }));
      return;
    }

    if (req.op === "list") {
      if (this.secrets === null) {
        socket.write(encodeResponse(errorResponse("LOCKED", "Vault is locked")));
        return;
      }

      // ── Token-based list (capability grant) ────────────────────────────
      // When a token is provided, return only keys the grant covers (those
      // that exist in the vault). Bypasses peercred ACL — token IS the auth.
      if (req.token !== undefined) {
        // For list, we validate against a sentinel key ("*") to just check
        // the token signature/expiry/revocation status, then filter by
        // key_allow. We validate directly by checking any allowed key.
        const dotIdx = req.token.indexOf(".");
        const grantId = dotIdx !== -1 ? req.token.slice(0, dotIdx) : undefined;

        // Look up the grant row to get key_allow without checking a specific key
        // We validate the token against a non-existent key to get the grant row,
        // but we need to handle "grant-key-not-allowed" specially for list.
        // Instead, validate against the first known vault key (or a dummy check).
        // Simplest: attempt validateGrant with a placeholder, accept ok or key-not-allowed
        // (both mean token itself is valid). Only reject expired/revoked/invalid.
        const sentinelKey = Object.keys(this.secrets)[0] ?? "__list_check__";
        const tokenCheck = await validateGrant(this.grantsDb, req.token, sentinelKey);

        // If the token is invalid/expired/revoked, deny
        if (!tokenCheck.ok && tokenCheck.reason !== "grant-key-not-allowed") {
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: "list",
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: `denied:${tokenCheck.reason}`,
            method: "grant",
            grant_id: grantId,
          });
          socket.write(encodeResponse(errorResponse("DENIED", tokenCheck.reason)));
          return;
        }

        // Token is valid (ok or key-not-allowed means auth is fine).
        // Get the key_allow list from the grant row.
        const grantRow = tokenCheck.ok
          ? tokenCheck.grant
          : this.grantsDb
              .query<{ key_allow: string }, [string]>(
                "SELECT key_allow FROM vault_grants WHERE id = ?",
              )
              .get(grantId ?? "");

        const allowedKeys: string[] = grantRow
          ? (typeof (grantRow as { key_allow: string[] | string }).key_allow === "string"
              ? JSON.parse((grantRow as { key_allow: string }).key_allow)
              : (grantRow as { key_allow: string[] }).key_allow)
          : [];

        // Filter to keys that exist in the vault AND are allowed by the grant
        const visibleKeys = allowedKeys.filter((k) => k in this.secrets!);

        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "list",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `allowed:${visibleKeys.length}`,
          method: "grant",
          grant_id: grantId,
        });
        socket.write(encodeResponse({ ok: true, keys: visibleKeys }));
        return;
      }

      // ── Peercred path (no token) ────────────────────────────────────────
      // Issue #129 review: `list` previously skipped peercred entirely, so
      // any same-UID caller could enumerate vault key names without proving
      // identity. Inconsistent with `get`, which requires peer != null on
      // Linux. Apply the same Linux peercred gate here so cron units can
      // still list (for diagnostics) but a non-cron same-UID caller can't.
      // On non-Linux the socket-file mode 0600 remains the only gate.
      //
      // Phase 2a — when agentName is set, the listener's per-agent socket
      // path is the trusted identity; we don't need peercred to gate.
      if (agentName === null && process.platform === "linux" && peer === null) {
        const reason = "Unable to identify caller (peercred unavailable); denying on Linux";
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "list",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `denied:${reason}`,
        });
        socket.write(
          encodeResponse(
            errorResponse(
              "DENIED",
              reason,
            ),
          ),
        );
        return;
      }

      // Two gates apply to `list`, BOTH must pass for a key to be visible:
      //   1. Per-key ACL (#207): the caller's cron unit must be allowed to
      //      read the key under its `schedule.secrets` allowlist.
      //   2. Per-entry scope (#8): the entry's allow/deny lists must permit
      //      the caller's agent slug.
      //
      // Reviewer-flagged bypass for #8: this PR's worker REPLACED gate 1
      // with gate 2 (rather than adding gate 2 ON TOP of gate 1). That
      // allowed an agent without an ACL claim on key X to still enumerate
      // X's name as long as X had no scope set. Now both gates fire.
      //
      // Interactive sessions (peer===null on non-Linux, or no config) skip
      // gate 1 (no identity to gate on) but still apply gate 2 with a null
      // slug — a deny list with literal-null entries would still take
      // effect; an allow list of named agents would block (null is not in
      // any named list). The socket file mode 0600 is the outer gate for
      // that case.
      const listAgentSlug =
        agentName ?? (peer !== null ? agentSlugFromPeer(peer) : null);
      let visibleKeys: string[];
      if (agentName !== null && this.config !== null) {
        // Phase 2a — agent identity is the listener's socket path. Gate
        // both visibility (per-agent secrets[]) and scope on that name.
        visibleKeys = Object.entries(this.secrets)
          .filter(
            ([key, entry]) =>
              checkAclByAgent(this.config!, agentName, key).allow &&
              checkEntryScope(entry.scope, agentName).allow,
          )
          .map(([k]) => k);
      } else if (peer !== null && this.config !== null) {
        visibleKeys = Object.entries(this.secrets)
          .filter(
            ([key, entry]) =>
              checkAcl(peer, this.config!, key).allow &&
              checkEntryScope(entry.scope, listAgentSlug).allow,
          )
          .map(([k]) => k);
      } else {
        visibleKeys = Object.entries(this.secrets)
          .filter(([, entry]) => checkEntryScope(entry.scope, listAgentSlug).allow)
          .map(([k]) => k);
      }

      // Audit the visible key count (#207). A bare "allowed" hides the case
      // where an identified cron unit's filter narrows to zero keys — almost
      // certainly a misconfiguration, but invisible in the log without the
      // count. `allowed:N` lets an operator grep for `result: "allowed:0"`.
      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "list",
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: `allowed:${visibleKeys.length}`,
      });
      socket.write(encodeResponse({ ok: true, keys: visibleKeys }));
      return;
    }

    if (req.op === "get") {
      if (this.secrets === null) {
        socket.write(encodeResponse(errorResponse("LOCKED", "Vault is locked")));
        return;
      }

      // ── Token-based access (capability grant) ────────────────────────────
      // When the request includes a token field, validate via the grants module
      // and bypass the peercred ACL entirely. Token IS the auth.
      if (req.token !== undefined) {
        const grantResult = await validateGrant(this.grantsDb, req.token, req.key);
        if (grantResult.ok) {
          const grantId = grantResult.grant.id;
          const entry = this.secrets[req.key];
          if (entry === undefined) {
            this.auditLogger.write({
              ts: new Date().toISOString(),
              op: "get",
              key: req.key,
              caller: auditCaller,
              pid: auditPid,
              cgroup: auditCgroup,
              result: "error:UNKNOWN_KEY",
              method: "grant",
              grant_id: grantId,
            });
            socket.write(
              encodeResponse(errorResponse("UNKNOWN_KEY", `Key not found: ${req.key}`)),
            );
            return;
          }
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: "get",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "allowed",
            method: "grant",
            grant_id: grantId,
          });
          socket.write(encodeResponse(entryResponse(entry)));
          return;
        } else {
          // Token present but invalid — extract grant_id for audit (ID portion only)
          const dotIdx = req.token.indexOf(".");
          const grantId = dotIdx !== -1 ? req.token.slice(0, dotIdx) : undefined;
          const denyReason = grantResult.reason; // e.g. "grant-expired"
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: "get",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: `denied:${denyReason}`,
            method: "grant",
            grant_id: grantId,
          });
          socket.write(
            encodeResponse(errorResponse("DENIED", denyReason)),
          );
          return;
        }
      }

      // ── ACL path (no token) ─────────────────────────────────────────────
      // Phase 2a: when agentName is set, the listener's per-agent socket
      // path established the identity at bind time. peercred uid is captured
      // for audit but does not gate.
      if (agentName !== null && this.config !== null) {
        const aclResult = checkAclByAgent(this.config, agentName, req.key);
        if (!aclResult.allow) {
          writeAudit({
            ts: new Date().toISOString(),
            op: "get",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: `denied:${aclResult.reason}`,
          });
          socket.write(
            encodeResponse(errorResponse("DENIED", aclResult.reason)),
          );
          return;
        }
      } else if (peer !== null && this.config !== null) {
        const aclResult = checkAcl(peer, this.config, req.key);
        if (!aclResult.allow) {
          writeAudit({
            ts: new Date().toISOString(),
            op: "get",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: `denied:${aclResult.reason}`,
          });
          socket.write(
            encodeResponse(
              errorResponse("DENIED", aclResult.reason),
            ),
          );
          return;
        }
      } else if (process.platform === "linux" && peer === null) {
        // On Linux, peercred unavailable → fail-closed
        const reason = "Unable to identify caller (peercred unavailable); denying on Linux";
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "get",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `denied:${reason}`,
        });
        socket.write(
          encodeResponse(
            errorResponse(
              "DENIED",
              reason,
            ),
          ),
        );
        return;
      }
      // On non-Linux: ACL is skipped (socket file mode 0600 is the guard)

      const entry = this.secrets[req.key];
      if (entry === undefined) {
        // Key not found — still audited (caller was allowed but key doesn't exist)
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "get",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "error:UNKNOWN_KEY",
        });
        socket.write(
          encodeResponse(errorResponse("UNKNOWN_KEY", `Key not found: ${req.key}`)),
        );
        return;
      }

      // Per-entry scope check (issue #8) — runs AFTER cron-unit ACL passes.
      const getAgentSlug =
        agentName ?? (peer !== null ? agentSlugFromPeer(peer) : null);
      const scopeResult = checkEntryScope(entry.scope, getAgentSlug);
      if (!scopeResult.allow) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "get",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `denied:${scopeResult.reason}`,
        });
        socket.write(
          encodeResponse(
            errorResponse("DENIED", scopeResult.reason),
          ),
        );
        return;
      }

      // Successful get — log only the key name, NEVER the value
      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "get",
        key: req.key,
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: "allowed",
      });
      socket.write(encodeResponse(entryResponse(entry)));
      return;
    }

    // ── Put — agent-driven key rotation ─────────────────────────────────────
    //
    // Same ACL as get: an agent that can read a key via schedule.secrets[]
    // can also rotate (write) it. Refuses to introduce new keys (operator-
    // only); refuses to change an entry's `kind` (string ↔ binary). The
    // motivating use case is OAuth refresh-token rotation in skills like
    // clerk's calendar skill — the skill reads its token via broker,
    // exchanges with the IDP for a fresh access_token + possibly-new
    // refresh_token, and now needs to persist the rotation. Pre-fix the
    // skill's `_vault_set` step failed every time because vault writes
    // required the operator passphrase that agents don't have. Post-fix
    // the skill's `switchroom vault set` routes through the broker and
    // the rotation is self-healing.
    if (req.op === "put") {
      // Vault must be unlocked to encrypt the new value.
      if (this.secrets === null || this.passphrase === null) {
        socket.write(encodeResponse(errorResponse("LOCKED", "Vault is locked")));
        return;
      }
      // Identity required — agentName from path-as-identity is the canonical
      // signal for per-agent ACL. Token-based grants don't yet support put
      // (deliberate — grant tokens are read-only by design; introducing
      // write-grants is a separate design discussion).
      if (agentName === null) {
        socket.write(
          encodeResponse(errorResponse("DENIED", "put requires path-as-identity (token-based grants are read-only)")),
        );
        return;
      }
      // Same ACL as get — schedule.secrets[] gates write too.
      if (this.config === null) {
        socket.write(
          encodeResponse(errorResponse("INTERNAL", "Broker config not loaded")),
        );
        return;
      }
      const aclResult = checkAclByAgent(this.config, agentName, req.key);
      if (!aclResult.allow) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "put",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `denied:${aclResult.reason}`,
        });
        socket.write(encodeResponse(errorResponse("DENIED", aclResult.reason)));
        return;
      }
      // Refuse to introduce new keys — operator-only territory. Agents can
      // only update entries that already exist, preserving the "operator
      // decides what goes in vault" boundary.
      const existing = this.secrets[req.key];
      if (existing === undefined) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "put",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "denied:unknown_key",
        });
        socket.write(
          encodeResponse(
            errorResponse(
              "UNKNOWN_KEY",
              `Key not found: ${req.key} (broker put cannot introduce new keys; ask operator to set it once via 'switchroom vault set' from the host)`,
            ),
          ),
        );
        return;
      }
      // Refuse to change the kind (string ↔ binary). The protocol union
      // already excludes 'files' from put. Agents rotating values must keep
      // the same shape.
      if (existing.kind !== req.entry.kind) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "put",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `denied:kind_mismatch ${existing.kind}→${req.entry.kind}`,
        });
        socket.write(
          encodeResponse(
            errorResponse(
              "BAD_REQUEST",
              `kind mismatch: existing entry is '${existing.kind}', new entry is '${req.entry.kind}'`,
            ),
          ),
        );
        return;
      }
      // Update in-memory + persist. saveVault re-encrypts the full secrets
      // dict and atomic-writes the vault file. On failure (disk full, perm
      // error, encrypted-write race with another writer), the in-memory
      // state is also rolled back — otherwise the broker would serve an
      // entry that isn't on disk and the next reload would lose it.
      const previousEntry = existing;
      this.secrets[req.key] = req.entry;
      try {
        saveVault(this.passphrase, this.vaultPath, this.secrets);
      } catch (err: unknown) {
        // Roll back in-memory state.
        this.secrets[req.key] = previousEntry;
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "put",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `error:${(err as Error)?.message ?? "save failed"}`,
        });
        socket.write(
          encodeResponse(
            errorResponse("INTERNAL", `Failed to persist: ${(err as Error)?.message ?? "unknown"}`),
          ),
        );
        return;
      }
      // Successful put — log only the key, NEVER the value.
      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "put",
        key: req.key,
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: "allowed",
      });
      socket.write(encodeResponse({ ok: true, put: true, key: req.key }));
      return;
    }

    // ── Approval kernel ops (RFC B) — handled BEFORE grant-mgmt ACL ─────────
    //
    // Placement note: handling these here (rather than after grant-mgmt)
    // keeps the discriminated union narrow in the grant-mgmt block, so
    // `req.op` can be assigned to `AuditOp` without a string literal that
    // doesn't exist in that enum. The ACL semantics also differ — approval
    // ops are callable from any agent (request/lookup) plus the gateway
    // (consume/revoke/list); the cron-cannot-manage-grants rule does not
    // apply.
    if (
      req.op === "approval_request" ||
      req.op === "approval_lookup" ||
      req.op === "approval_consume" ||
      req.op === "approval_revoke" ||
      req.op === "approval_list" ||
      req.op === "approval_record"
    ) {
      await this._handleApprovalOp(socket, req);
      return;
    }

    // ── Grant management ops ─────────────────────────────────────────────────
    //
    // #225 review-fix: gate mint_grant / list_grants / revoke_grant on the
    // caller NOT being a cron unit. The intent is "operator-only" — these
    // ops mint capability tokens that grant cron access, so a cron itself
    // must not be able to call them (otherwise a hijacked cron could mint
    // tokens for sibling agents and exfiltrate their keys).
    //
    // Rule:
    //   - peer === null on Linux → deny (fail-closed identity).
    //   - peer with cron-pattern systemdUnit → deny (cron context).
    //   - peer with no systemdUnit OR non-cron systemdUnit → allow
    //     (operator interactive session, or a deliberately-allowed
    //     management agent).
    //
    // Non-Linux dev mode (SWITCHROOM_BROKER_ALLOW_NON_LINUX=1): peer is null
    // but identity is bypassed everywhere — accept the same dev-mode
    // exception used by `get`/`list` so test harnesses can exercise the path.
    const isGrantMgmtOp =
      req.op === "mint_grant" ||
      req.op === "list_grants" ||
      req.op === "revoke_grant";
    if (isGrantMgmtOp) {
      // Phase 2a: agent-bound listeners are NEVER allowed to mint, list, or
      // revoke grants. Grant management is operator-only. An agent that has
      // its own dedicated socket has no business minting capability tokens.
      if (agentName !== null) {
        writeAudit({
          ts: new Date().toISOString(),
          op: req.op,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "denied:agent-cannot-manage-grants",
        });
        socket.write(
          encodeResponse(
            errorResponse(
              "DENIED",
              "Grant management ops are operator-only; agent-bound listeners cannot mint, list, or revoke grants",
            ),
          ),
        );
        return;
      }
      const allowNonLinux = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX === "1";
      if (peer === null && !allowNonLinux) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: req.op,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "denied:peercred-unavailable",
        });
        socket.write(
          encodeResponse(errorResponse("DENIED", "peercred unavailable; cannot verify operator identity")),
        );
        return;
      }
      if (peer !== null && peer.systemdUnit !== null) {
        const parsed = parseCronUnit(peer.systemdUnit);
        if (parsed !== null) {
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: req.op,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:cron-cannot-manage-grants",
          });
          socket.write(
            encodeResponse(
              errorResponse(
                "DENIED",
                "Grant management ops are operator-only; cron units cannot mint, list, or revoke grants",
              ),
            ),
          );
          return;
        }
      }
    }

    if (req.op === "mint_grant") {
      // Parse ttl_seconds into a duration for mintGrant
      const { agent, keys, ttl_seconds, description } = req;
      let mintResult: Awaited<ReturnType<typeof mintGrant>>;
      try {
        mintResult = await mintGrant(this.grantsDb, agent, keys, ttl_seconds, description);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "mint_grant",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `error:${msg}`,
        });
        socket.write(encodeResponse(errorResponse("INTERNAL", `Failed to mint grant: ${msg}`)));
        return;
      }

      // Write token file atomically at ~/.switchroom/agents/<agent>/.vault-token
      // (mode 0600).
      //
      // #225 review-fix: write-then-rename so a cron racing the mint
      // never reads a partial token. The previous direct writeFileSync left
      // a one-syscall window where the cron could open the file between
      // creation and the bytes being committed. Rename is atomic on Linux
      // for same-filesystem moves.
      try {
        const tokenDir = path.join(os.homedir(), ".switchroom", "agents", agent);
        mkdirSync(tokenDir, { recursive: true });
        const tokenPath = path.join(tokenDir, ".vault-token");
        const tmpPath = `${tokenPath}.tmp.${process.pid}`;
        writeFileSync(tmpPath, mintResult.token, { mode: 0o600 });
        renameSync(tmpPath, tokenPath);
      } catch (err) {
        // Non-fatal: the token is still returned. File write is best-effort.
        process.stderr.write(
          `[vault-broker] mint_grant: failed to write token file for agent ${agent}: ` +
          `${(err as Error).message}\n`
        );
      }

      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "mint_grant",
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: "allowed",
        method: "grant",
        grant_id: mintResult.id,
      });
      socket.write(
        encodeResponse({
          ok: true,
          token: mintResult.token,
          id: mintResult.id,
          expires_at: mintResult.expires_at,
        }),
      );
      return;
    }

    if (req.op === "list_grants") {
      const grants = listGrants(this.grantsDb, req.agent);
      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "list_grants",
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: `allowed:${grants.length}`,
      });
      // Strip revoked_at before sending (not part of the GrantMeta wire schema)
      const grantMetas = grants.map(({ id, agent_slug, key_allow, expires_at, created_at, description }) => ({
        id,
        agent_slug,
        key_allow,
        expires_at,
        created_at,
        description,
      }));
      socket.write(encodeResponse({ ok: true, grants: grantMetas }));
      return;
    }

    if (req.op === "revoke_grant") {
      const { id } = req;
      const revoked = revokeGrant(this.grantsDb, id);

      // Best-effort: find and remove any token file for this grant ID.
      // We don't know which agent it belonged to without querying — query the
      // revoked row (revoked_at is now set) to get the agent slug.
      try {
        const row = this.grantsDb
          .query<{ agent_slug: string }, [string]>(
            "SELECT agent_slug FROM vault_grants WHERE id = ?",
          )
          .get(id);
        if (row) {
          const tokenPath = path.join(
            os.homedir(),
            ".switchroom",
            "agents",
            row.agent_slug,
            ".vault-token",
          );
          if (existsSync(tokenPath)) {
            try { unlinkSync(tokenPath); } catch { /* best-effort */ }
          }
        }
      } catch { /* best-effort */ }

      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "revoke_grant",
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: revoked ? "allowed" : "error:not-found",
        method: "grant",
        grant_id: id,
      });
      socket.write(encodeResponse({ ok: true, revoked }));
      return;
    }

    // (approval ops are dispatched earlier — see _handleApprovalOp)

    // Exhaustive check — should not reach here
    socket.write(
      encodeResponse(
        errorResponse("BAD_REQUEST", `Unknown op: ${(req as { op: string }).op}`),
      ),
    );
  }

  /**
   * Approval-kernel op dispatcher (RFC B). Handled in its own method so
   * the discriminated-union narrowing in `_handleRequest` stays clean —
   * the legacy AuditOp enum doesn't include the apv:* op names, and we
   * don't want to widen it (audit-log.ts is the vault audit log, not the
   * approval audit; the kernel writes its own approval_audit table).
   */
  private async _handleApprovalOp(
    socket: net.Socket,
    req: import("./protocol.js").BrokerRequest,
  ): Promise<void> {
    try {
      if (req.op === "approval_request") {
        // RFC §10 rate caps: per-agent max 2 concurrent pending, global max 32.
        const counts = countPendingNonces(this.grantsDb);
        const perAgentN = counts.perAgent.get(req.agent_unit) ?? 0;
        if (perAgentN >= MAX_PENDING_PER_AGENT || counts.global >= MAX_PENDING_GLOBAL) {
          const retry_after_ms = computeRetryAfterMs(
            this.grantsDb,
            perAgentN >= MAX_PENDING_PER_AGENT ? req.agent_unit : null,
          );
          socket.write(
            encodeResponse({
              ok: true,
              kind: "approval_request",
              state: "rate_limited",
              retry_after_ms,
            }),
          );
          return;
        }
        const result = kernelRequestApproval(this.grantsDb, {
          agent_unit: req.agent_unit,
          scope: req.scope,
          action: req.action,
          approver_set: req.approver_set,
          why: req.why,
          ttl_ms: req.ttl_ms,
        });
        socket.write(
          encodeResponse({
            ok: true,
            kind: "approval_request",
            state: "pending",
            request_id: result.request_id,
            expires_at: result.expires_at,
          }),
        );
        return;
      }
      if (req.op === "approval_lookup") {
        const r = kernelLookupDecision(this.grantsDb, {
          agent_unit: req.agent_unit,
          scope: req.scope,
          action: req.action,
          current_approver_set: req.current_approver_set,
        });
        const decision =
          r.state === "granted" || r.state === "denied"
            ? {
                id: r.decision.id,
                agent_unit: r.decision.agent_unit,
                scope: r.decision.scope,
                action: r.decision.action,
                decision: r.decision.decision,
                granted_at: r.decision.granted_at,
                granted_by_user_id: r.decision.granted_by_user_id,
                ttl_expires_at: r.decision.ttl_expires_at,
                last_used_at: r.decision.last_used_at,
                revoked_at: r.decision.revoked_at,
                revoke_reason: r.decision.revoke_reason,
              }
            : null;
        socket.write(encodeResponse({ ok: true, state: r.state, decision }));
        return;
      }
      if (req.op === "approval_consume") {
        const nonce = kernelConsumeNonce(this.grantsDb, req.request_id);
        if (nonce === null) {
          socket.write(encodeResponse({ ok: true, consumed: false }));
          return;
        }
        socket.write(
          encodeResponse({
            ok: true,
            consumed: true,
            agent_unit: nonce.agent_unit,
            scope: nonce.scope,
            action: nonce.action,
            why: nonce.why,
          }),
        );
        return;
      }
      if (req.op === "approval_revoke") {
        const revoked = kernelRevokeDecision(
          this.grantsDb,
          req.decision_id,
          req.actor,
          req.reason,
        );
        socket.write(encodeResponse({ ok: true, revoked }));
        return;
      }
      if (req.op === "approval_record") {
        const nonce = kernelGetNonce(this.grantsDb, req.request_id);
        if (nonce === null) {
          socket.write(encodeResponse(errorResponse("BAD_REQUEST", "unknown request_id")));
          return;
        }
        if (nonce.consumed_at === null) {
          socket.write(
            encodeResponse(
              errorResponse(
                "BAD_REQUEST",
                "nonce must be consumed before recording — call approval_consume first",
              ),
            ),
          );
          return;
        }
        const decision_id = kernelRecordDecision(this.grantsDb, {
          nonce,
          decision: req.decision,
          approver_set: req.approver_set,
          granted_by_user_id: req.granted_by_user_id,
          ttl_ms: req.ttl_ms ?? undefined,
        });
        socket.write(encodeResponse({ ok: true, decision_id }));
        return;
      }
      if (req.op === "approval_list") {
        const decisions = kernelListDecisions(this.grantsDb, { agent_unit: req.agent_unit });
        const meta = decisions.map((d) => ({
          id: d.id,
          agent_unit: d.agent_unit,
          scope: d.scope,
          action: d.action,
          decision: d.decision,
          granted_at: d.granted_at,
          granted_by_user_id: d.granted_by_user_id,
          ttl_expires_at: d.ttl_expires_at,
          last_used_at: d.last_used_at,
          revoked_at: d.revoked_at,
          revoke_reason: d.revoke_reason,
        }));
        socket.write(encodeResponse({ ok: true, decisions: meta }));
        return;
      }
      // Should not reach here — caller must have already discriminated.
      socket.write(
        encodeResponse(
          errorResponse(
            "BAD_REQUEST",
            `Unknown approval op: ${(req as { op: string }).op}`,
          ),
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      socket.write(encodeResponse(errorResponse("INTERNAL", msg)));
    }
  }

  private _handleUnlockConnection(socket: net.Socket): void {
    // Same UID check for unlock socket. On Linux: verify via peercred,
    // pinned to this connection's fd (issue #129).
    // On other OSes: rely on socket file mode 0600.
    let unlockPeer: PeerInfo | null = null;
    if (process.platform === "linux") {
      unlockPeer = this.testOpts._testIdentify
        ? this.testOpts._testIdentify(this.unlockSocketPath, socket)
        : identify(this.unlockSocketPath, socket);
      if (unlockPeer === null) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "unlock",
          caller: `pid:${process.pid}`,
          pid: process.pid,
          result: "denied:unable to verify caller identity",
        });
        socket.write("ERR unable to verify caller identity\n");
        socket.destroy();
        return;
      }
    }

    const auditPid = unlockPeer?.pid ?? process.pid;
    const auditCaller = unlockPeer !== null ? callerFromPeer(unlockPeer) : `pid:${process.pid}`;
    const auditCgroup = unlockPeer?.systemdUnit ?? undefined;

    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) {
        // Guard against massive input
        if (Buffer.byteLength(buffer, "utf8") > 4096) {
          socket.write("ERR passphrase too long\n");
          socket.destroy();
          buffer = "";
        }
        return;
      }

      // Take exactly the first line as the passphrase
      const passphrase = buffer.slice(0, newlineIdx).trimEnd();
      // Immediately drop the rest (don't process further input)
      buffer = "";

      if (!passphrase) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "unlock",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "denied:passphrase cannot be empty",
        });
        socket.write("ERR passphrase cannot be empty\n");
        socket.destroy();
        return;
      }

      try {
        this.unlockFromPassphrase(passphrase);
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "unlock",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "allowed",
        });
        socket.write("OK\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Audit-log secret-leak guard (#206 review):
        // openVault() bubbles up errors from the underlying KDF/cipher
        // library. If that library ever embeds ciphertext bytes, key
        // material, or passphrase context in its error message, putting
        // `msg` verbatim into the audit log would defeat the very thing
        // the log exists to record (who pulled what — never the value).
        //
        // Audit gets a constant string. The raw msg still travels to
        // stderr (operator diagnostics) and to the client (so the user
        // can see WHY their unlock failed) — those surfaces are not the
        // append-only public-record audit channel.
        process.stderr.write(`vault broker: unlock error: ${msg}\n`);
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "unlock",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "error:decryption failed",
        });
        // Closes #472 finding #24 — pre-fix the wire response was
        // `ERR ${msg}` which leaked underlying error fingerprints
        // (wrong-passphrase vs wrong-KDF-param vs corrupt-ciphertext).
        // Same-UID processes that probed the unlock socket could
        // enumerate failure shapes and infer structural details
        // (which KDF, which cipher, whether the file is even a vault).
        // Stderr (operator console) and audit log keep the verbose
        // form for diagnostics; the wire surface is now constant.
        socket.write("ERR decryption failed\n");
      } finally {
        socket.destroy();
      }
    });

    socket.on("error", () => {
      socket.destroy();
    });
  }

  private _writePidFile(): void {
    try {
      const pidPath = resolvePath(PID_FILE_DEFAULT);
      writeFileSync(pidPath, String(process.pid) + "\n", { mode: 0o600 });
    } catch { /* non-fatal */ }
  }

  /**
   * Attempt to auto-unlock the vault at start. Called once after the sockets
   * are bound and sd_notify READY=1 has fired. Any failure is non-fatal —
   * the broker stays running and the user can unlock interactively.
   *
   * Sources, in order:
   *   1. The machine-bound auto-unlock blob written by
   *      `switchroom vault broker enable-auto-unlock` — default at
   *      ~/.switchroom/vault-auto-unlock (configurable via
   *      vault.broker.autoUnlockCredentialPath, or the
   *      SWITCHROOM_VAULT_BROKER_AUTO_UNLOCK_PATH env var the
   *      docker-compose vault-broker service injects).
   *   2. `$CREDENTIALS_DIRECTORY/vault-passphrase` — for power users who
   *      installed the broker as a system unit with systemd
   *      LoadCredentialEncrypted=. We don't ship that mode by default but
   *      the read path stays cheap so power users aren't blocked.
   */
  private _tryAutoUnlock(): void {
    if (this._tryAutoUnlockFromMachineBoundFile()) return;
    this._tryAutoUnlockFromSystemdCredentials();
  }

  /**
   * Read ~/.switchroom/vault-auto-unlock (or configured/env path), decrypt
   * with the key derived from /etc/machine-id + the per-file salt, push the
   * passphrase into unlockFromPassphrase. Returns true if we attempted —
   * regardless of success — so the caller knows whether to try other paths.
   *
   * Returns false only when auto-unlock is not configured (file path absent).
   */
  private _tryAutoUnlockFromMachineBoundFile(): boolean {
    // Resolution order:
    //   1. SWITCHROOM_VAULT_BROKER_AUTO_UNLOCK_PATH env var — set by the
    //      docker-compose vault-broker service so the in-container path
    //      (`/state/vault-auto-unlock`) overrides the host-shaped default
    //      that wouldn't resolve inside the container.
    //   2. config.vault.broker.autoUnlockCredentialPath — operator override.
    //   3. DEFAULT_AUTO_UNLOCK_PATH — the canonical host location.
    const envPath = process.env.SWITCHROOM_VAULT_BROKER_AUTO_UNLOCK_PATH;
    const configuredPath =
      (envPath && envPath.length > 0 ? envPath : undefined) ??
      this.config?.vault?.broker?.autoUnlockCredentialPath ??
      DEFAULT_AUTO_UNLOCK_PATH;
    const filePath = resolvePath(configuredPath);
    if (!existsSync(filePath)) return false;

    let passphrase: string;
    try {
      passphrase = readAutoUnlockFile(filePath);
    } catch (err) {
      if (err instanceof AutoUnlockDecryptError) {
        process.stderr.write(
          `[vault-broker] auto-unlock decrypt failed (${err.reason}): ${err.message}\n` +
          `[vault-broker] staying locked; use \`switchroom vault broker unlock\` interactively\n`,
        );
      } else if (err instanceof MachineIdUnavailableError) {
        process.stderr.write(
          `[vault-broker] auto-unlock unavailable: ${err.message}\n`,
        );
      } else {
        process.stderr.write(
          `[vault-broker] auto-unlock read failed: ${(err as Error).message}\n`,
        );
      }
      return true; // we attempted; don't fall through to systemd-creds path
    }
    try {
      this.unlockFromPassphrase(passphrase);
      process.stderr.write(`[vault-broker] auto-unlocked from ${filePath}\n`);
    } catch (err) {
      process.stderr.write(
        `[vault-broker] auto-unlock applied passphrase but vault rejected it: ` +
        `${(err as Error).message}; staying locked\n`,
      );
    }
    passphrase = "";
    return true;
  }

  /**
   * Compat path: when run as a system unit with `LoadCredentialEncrypted=`,
   * systemd materializes the decrypted credential at
   * `$CREDENTIALS_DIRECTORY/vault-passphrase`. Power users opting into that
   * setup get the same auto-unlock semantics with no further config.
   */
  private _tryAutoUnlockFromSystemdCredentials(): void {
    const dir = process.env.CREDENTIALS_DIRECTORY;
    if (!dir) return;
    const credPath = `${dir}/vault-passphrase`;
    let passphrase: string;
    try {
      passphrase = readFileSync(credPath, "utf8").replace(/\n+$/, "");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        process.stderr.write(
          `[vault-broker] note: CREDENTIALS_DIRECTORY set but vault-passphrase ` +
          `not present; staying locked\n`,
        );
        return;
      }
      process.stderr.write(
        `[vault-broker] auto-unlock read failed: ${(err as Error).message}; ` +
        `falling back to interactive\n`,
      );
      return;
    }
    try {
      this.unlockFromPassphrase(passphrase);
      process.stderr.write(
        `[vault-broker] auto-unlocked from $CREDENTIALS_DIRECTORY/vault-passphrase\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[vault-broker] auto-unlock failed: ${(err as Error).message}; ` +
        `falling back to interactive\n`,
      );
    }
    passphrase = "";
  }

  private _sdNotify(message: string): void {
    const notifySocket = process.env.NOTIFY_SOCKET;
    if (!notifySocket) return;

    // The NOTIFY_SOCKET may be an abstract socket (starts with "@") or a
    // path socket. We implement sd_notify inline without dependencies.
    try {
      const socketPath = notifySocket.startsWith("@")
        ? "\0" + notifySocket.slice(1)
        : notifySocket;
      const client = net.createConnection({ path: socketPath });
      client.on("connect", () => {
        client.write(message);
        client.destroy();
      });
      client.on("error", () => {
        // Non-fatal — sd_notify failure doesn't block startup
      });
    } catch { /* non-fatal */ }
  }
}

// ─── Vault layout drift detection (plan v3 §5 companion) ────────────────────

/**
 * Defend against state-E layout divergence: an older switchroom CLI
 * wrote to the legacy `~/.switchroom/vault.enc` path AFTER migration
 * ran, replacing the symlink with a fresh regular file. Broker and
 * CLI now write to different files; without this check the broker
 * would serve stale data unbounded.
 *
 * Heuristic: if the resolved vault path's parent dir contains a
 * sibling regular file at `<parent>/../vault.enc` (the legacy path),
 * AND that file's content differs from what we're about to open,
 * refuse to unlock with a clear error.
 *
 * Only triggers when the layout is the canonical
 * `~/.switchroom/vault/vault.enc` form. Custom vault paths and
 * pre-migration single-file paths skip the check.
 *
 * Throws `VaultError` on detected drift; caller's existing
 * VaultError handling surfaces the message to logs / stderr.
 */
function detectVaultLayoutDrift(vaultPath: string): void {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const crypto = require("node:crypto") as typeof import("node:crypto");

  // Only meaningful when the resolved vault path is at the canonical
  // dir-mount layout: <something>/vault/vault.enc. Inside the broker
  // container that's typically /state/vault/vault.enc.
  const dir = path.dirname(vaultPath);
  if (path.basename(dir) !== "vault") return;
  if (path.basename(vaultPath) !== "vault.enc") return;

  // Look for a sibling at <parent-of-dir>/vault.enc — the legacy path.
  const parent = path.dirname(dir);
  const legacyPath = path.join(parent, "vault.enc");
  if (!fs.existsSync(legacyPath)) return;
  let legacyStat;
  try { legacyStat = fs.lstatSync(legacyPath); } catch { return; }
  // Symlink: probably ours, points back at vault/vault.enc — fine.
  if (legacyStat.isSymbolicLink()) return;
  if (!legacyStat.isFile()) return;

  // Both exist as regular files. Compare hashes.
  let canonicalHash: string;
  let legacyHash: string;
  try {
    canonicalHash = crypto.createHash("sha256").update(fs.readFileSync(vaultPath)).digest("hex");
    legacyHash = crypto.createHash("sha256").update(fs.readFileSync(legacyPath)).digest("hex");
  } catch {
    // Read failure on either file — don't block boot on a
    // detection-helper hiccup. Worst case: we serve data the broker
    // already had access to.
    return;
  }
  if (canonicalHash === legacyHash) return; // State C — equivalent, fine

  // State E — drift. Refuse to unlock.
  throw new Error(
    `Vault layout divergence detected: ${legacyPath} and ${vaultPath} ` +
    `are both regular files with different content. An older switchroom ` +
    `CLI may have written to the legacy path after migration ran. ` +
    `Run \`switchroom apply\` from the host to surface the recovery recipe ` +
    `(state E refusal with literal \`mv\` commands).`,
  );
}

// ─── Top-level graceful shutdown ─────────────────────────────────────────────

let _globalBroker: VaultBroker | null = null;

export function registerShutdownHandlers(broker: VaultBroker): void {
  _globalBroker = broker;
  const shutdown = (): void => {
    if (_globalBroker) {
      _globalBroker.stop();
      _globalBroker = null;
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ─── Top-level entrypoint (Phase 1b — broker container CMD) ──────────────────
//
// Dockerfile.broker invokes `bun /opt/switchroom/dist/vault/broker/server.js`.
// Without a main() + entry guard, the bundle would import VaultBroker, run no
// listen call, and exit immediately (Phase 1b review blocker). We mirror the
// in-agent scheduler's pattern at src/agent-scheduler/index.ts: read env for
// socket/config/vault paths, construct a broker, register shutdown handlers,
// call start().
//
// Env contract:
//   SWITCHROOM_BROKER_SOCKET    Path to data socket. Default
//                               /run/switchroom/broker/vault-broker.sock
//                               (compose mounts /run/switchroom/broker/<agent>
//                               per-agent; the singleton broker uses the
//                               parent dir directly inside the container).
//   SWITCHROOM_BROKER_PER_AGENT_DIR   Phase 2a — when set (default
//                               /run/switchroom/broker), the broker scans
//                               this directory for files matching
//                               <agent>.sock that compose mounted in (one
//                               per agent), and binds a dedicated listener
//                               on each. Each listener uses socket-path-as-
//                               identity ACL (checkAclByAgent) instead of
//                               cgroup peercred. Falls back to legacy
//                               single-socket mode if the dir doesn't
//                               exist or is empty.
//   SWITCHROOM_CONFIG           Path to switchroom.yaml. Default unset →
//                               loadConfig() auto-detects.
//   SWITCHROOM_VAULT_PATH       Path to encrypted vault. Default from config.
//
// The broker stays alive on its open server sockets — we don't loop here.
export async function main(): Promise<void> {
  const legacySocketPath =
    process.env.SWITCHROOM_BROKER_SOCKET ??
    "/run/switchroom/broker/vault-broker.sock";
  const perAgentDir =
    process.env.SWITCHROOM_BROKER_PER_AGENT_DIR ??
    "/run/switchroom/broker";
  const configPath = process.env.SWITCHROOM_CONFIG;
  const vaultPath = process.env.SWITCHROOM_VAULT_PATH;

  // Phase 2a — enumerate per-agent socket targets that compose mounted in.
  // We accept two shapes (matching the kernel and the patterns
  // socketPathToAgent() vets):
  //   (a) regular files named <agent>.sock — pre-created by compose
  //   (b) directories named <agent> (per-agent named-volume mount points);
  //       we bind a socket at `<dir>/sock`. This is what the v0.7 compose
  //       generator emits — `broker-<name>-sock` mounts at
  //       `/run/switchroom/broker/<name>` inside the broker, and the agent
  //       sees the same file via its `/run/switchroom/broker` mount of
  //       the same volume, accessed by its env path
  //       `/run/switchroom/broker/<name>/sock`.
  //   (c) nothing (named volumes that resolve to empty dirs without the
  //       per-agent subdir mounts) — fall through to legacy single-socket.
  // The agent name is always derived from the socket path (not from a
  // wire-payload field) via socketPathToAgent(), so both shapes preserve
  // the path-as-identity invariant.
  let perAgentTargets: string[] = [];
  try {
    if (existsSync(perAgentDir)) {
      const entries = readdirSync(perAgentDir, { withFileTypes: true });
      const flat: string[] = [];
      const subdirs: string[] = [];
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        // (a) flat file
        if (
          (e.isFile() || e.isSocket()) &&
          e.name.endsWith(".sock")
        ) {
          flat.push(resolve(perAgentDir, e.name));
          continue;
        }
        // (b) per-agent subdir — bind <subdir>/sock if the subdir name
        // parses as a valid agent identifier.
        if (e.isDirectory()) {
          const candidate = resolve(perAgentDir, e.name, "sock");
          if (socketPathToAgent(candidate) !== null) {
            subdirs.push(candidate);
          }
        }
      }
      perAgentTargets = [...flat, ...subdirs]
        .filter((p) => socketPathToAgent(p) !== null)
        .sort();
    }
  } catch (err) {
    process.stderr.write(
      `[vault-broker] per-agent enumeration failed at ${perAgentDir}: ${(err as Error).message}\n`,
    );
  }

  const broker = new VaultBroker();
  registerShutdownHandlers(broker);

  if (perAgentTargets.length > 0) {
    // Phase 2a path. We still need start() to load config, vault path,
    // grants DB, and bind the unlock socket — those are unchanged. We
    // pass the legacy path so the existing data socket also binds (acts
    // as the operator-control surface for unlock + grant management),
    // then layer per-agent listeners on top.
    await broker.start(legacySocketPath, configPath, vaultPath);
    process.stdout.write(
      `vault-broker: legacy socket listening on ${legacySocketPath}\n`,
    );
    for (const target of perAgentTargets) {
      try {
        const agentName = await broker.bindAgentSocket(target);
        process.stdout.write(
          `vault-broker: per-agent socket listening agent=${agentName} sock=${target}\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[vault-broker] failed to bind ${target}: ${(err as Error).message}\n`,
        );
      }
    }
    return;
  }

  // Legacy single-socket fallback.
  await broker.start(legacySocketPath, configPath, vaultPath);
  process.stdout.write(
    `vault-broker: listening on ${legacySocketPath}\n`,
  );
}

// Entry guard — only run main() when this file is invoked directly as the
// broker server bundle (dist/vault/broker/server.js or src/vault/broker/
// server.ts). The naive `import.meta.url === file://${process.argv[1]}`
// guard fires spuriously when this module is bundled INTO another entry
// point (e.g. dist/cli/switchroom.js): bun's bundler rewrites
// `import.meta.url` to point at the OUTPUT bundle, so the comparison
// matches argv[1] for any CLI invocation and the broker tries to boot
// from random verbs like `issues list`. We additionally require the
// bundle filename to look like the broker entry. See PR #807 / CI fix.
if (
  import.meta.url === `file://${process.argv[1]}` &&
  /(?:^|[/\\])(?:vault[/\\]broker[/\\])?server\.(?:js|ts)$/.test(
    process.argv[1] ?? "",
  )
) {
  main().catch((err) => {
    process.stderr.write(
      `vault-broker fatal: ${err instanceof Error ? err.stack : err}\n`,
    );
    process.exit(1);
  });
}
