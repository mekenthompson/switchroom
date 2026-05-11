/**
 * Tests for the passphrase-attested `mint_grant` path shipped in
 * #1012 Phase 2.
 *
 * Why this matters: a non-admin agent (e.g. gymbro) calling
 * `vault_request_access` (#1012 Phase 1) renders an approval card in
 * its OWN Telegram chat. When the operator taps [Approve], the
 * callback runs in that agent's gateway, which connects to the
 * agent-bound broker socket. Before this PR the broker refused with
 *
 *   "agent-bound listeners cannot mint, list, or revoke grants"
 *
 * making the feature useless for the actual use case. Phase 2 adds
 * passphrase attestation as the third trust posture for grant-mgmt
 * (mirroring the put / passphrase-attest path used by
 * `vault_request_save` since #969 P1a).
 *
 * Threat surface: the operator's vault passphrase IS the operator
 * identity. If a non-admin agent has it (cached after /vault unlock
 * in that chat), the operator was in the loop. Same risk surface as
 * `vault_request_save` from a non-admin agent today.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { VaultBroker } from "./server.js";
import {
  encodeRequest,
  decodeResponse,
  type BrokerResponse,
} from "./protocol.js";
import type { VaultEntry } from "../vault.js";
import { createAuditLogger as _ } from "./audit-log.js";
import type { AuditEntry, AuditLogger } from "./audit-log.js";
import { migrateGrantsSchema } from "../grants.js";

const TEST_SECRETS: Record<string, VaultEntry> = {
  fatsecret_credentials: { kind: "string", value: "user/pw" },
};

const TEST_PASSPHRASE = "operator-typed-this-via-vault-unlock";

function cloneSecrets(): Record<string, VaultEntry> {
  return JSON.parse(JSON.stringify(TEST_SECRETS));
}

function makeConfigWithNonAdminAgent() {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: { socket: "~/.switchroom/vault-broker.sock", enabled: true },
    },
    // gymbro is a non-admin agent — mirrors the production config
    // shape where most specialists are admin:false and a small set
    // (klanker/carrie/test-harness on Ken's host) are admin:true.
    agents: { gymbro: {} },
  } as any;
}

function makeInMemoryGrantsDb(): Database {
  const db = new Database(":memory:");
  migrateGrantsSchema(db);
  return db;
}

async function rpc(
  socketPath: string,
  req: Parameters<typeof encodeRequest>[0],
): Promise<BrokerResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: socketPath });
    let buffer = "";
    client.on("error", reject);
    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        client.destroy();
        try {
          resolve(decodeResponse(line));
        } catch (e) {
          reject(e);
        }
      }
    });
    client.on("connect", () => {
      client.write(encodeRequest(req));
    });
  });
}

describe("VaultBroker: mint_grant passphrase attestation (#1012 Phase 2)", () => {
  let broker: VaultBroker;
  // Socket path uses the legacy flat shape `<dir>/<agent>.sock` so
  // socketPathToAgent parses agentName = "gymbro" — i.e. the broker
  // sees this as a non-admin agent-bound connection. This is the
  // exact identity posture #1012 Phase 1 originally failed under.
  let socketPath: string;
  let tmpDir: string;
  let grantsDb: Database;
  let auditEntries: AuditEntry[];
  let prevNonLinuxFlag: string | undefined;

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    // Disable Linux peercred so the test runs the agent-bound gate
    // purely via socket-path-as-identity. socketPathToAgent fires
    // regardless of platform, so the agent-deny path is exercised
    // even with this flag set.
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-mint-attest-test-"));
    socketPath = path.join(tmpDir, "gymbro.sock");

    grantsDb = makeInMemoryGrantsDb();
    auditEntries = [];

    const testAuditLogger: AuditLogger = {
      write: (e: AuditEntry) => {
        auditEntries.push(e);
      },
    };

    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeConfigWithNonAdminAgent(),
      _testGrantsDb: grantsDb,
      _testAuditLogger: testAuditLogger,
      _testPassphrase: TEST_PASSPHRASE,
      // Force every connection to be treated as agent-bound (gymbro).
      // socketPathToAgent can't parse a /tmp path, so without this hook
      // the test would silently exercise the no-agent-identity path
      // (operator-like trust) and never hit the agent-deny / attestation
      // branches we're trying to verify.
      _testAgentName: "gymbro",
    });
    await broker.start(socketPath, undefined, undefined);
  });

  afterEach(() => {
    broker.stop();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  // ── Regression: the bug that made #1012 Phase 1 useless ─────────────

  it("non-admin agent without passphrase: DENIED (the gymbro screenshot)", async () => {
    // fails when: the agent-deny gate is removed or accidentally
    // bypassed. This was the literal error in the gymbro
    // screenshot — without it the threat model collapses (any
    // non-admin agent could self-elevate by minting its own grants).
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "gymbro",
      keys: ["fatsecret_credentials"],
      ttl_seconds: 30 * 86400,
      description: "no-attestation attempt",
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      expect(resp.msg).toMatch(/Grant management ops are operator-only/);
    }
    const denied = auditEntries.find(
      (e) => e.op === "mint_grant" && String(e.result).startsWith("denied:agent-cannot-manage-grants"),
    );
    expect(denied).toBeDefined();
  });

  // ── Happy path: passphrase attestation unlocks grant-mgmt ───────────

  it("non-admin agent with correct passphrase: ALLOWED, grant written", async () => {
    // fails when: the attestation path is broken at the broker.
    // Closes the gymbro screenshot end-to-end.
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "gymbro",
      keys: ["fatsecret_credentials"],
      ttl_seconds: 30 * 86400,
      description: "operator-attested via Telegram approval card",
      passphrase: TEST_PASSPHRASE,
    });

    expect(resp.ok).toBe(true);
    if (resp.ok && "token" in resp) {
      expect(resp.token).toMatch(/^vg_[0-9a-f]{6}\./);
      expect(resp.id).toMatch(/^vg_/);
    }

    // Audit row: method=passphrase, result includes "passphrase-attested"
    // so post-hoc forensics can distinguish operator-attested mints
    // from operator-socket and admin-agent mints.
    const allowed = auditEntries.find(
      (e) => e.op === "mint_grant" && String(e.result).includes("passphrase-attested"),
    );
    expect(
      allowed,
      `expected a passphrase-attested allow row in audit; got: ${JSON.stringify(auditEntries, null, 2)}`,
    ).toBeDefined();
    expect(allowed!.method).toBe("passphrase");
  });

  // ── Bad-attest: wrong passphrase fails closed, doesn't fall through ──

  it("non-admin agent with wrong passphrase: DENIED with passphrase-mismatch (no fall-through)", async () => {
    // fails when: a passphrase mismatch is silently ignored and the
    // request falls through to the agent-deny path (then the operator
    // sees "agent cannot manage grants" and is confused about why
    // their unlock didn't take effect). Surface the mismatch clearly
    // so they re-unlock with the correct passphrase.
    const resp = await rpc(socketPath, {
      v: 1,
      op: "mint_grant",
      agent: "gymbro",
      keys: ["fatsecret_credentials"],
      ttl_seconds: 30 * 86400,
      passphrase: "WRONG-PASSPHRASE",
    });

    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
      expect(resp.msg).toMatch(/does not match/);
    }
    const mismatch = auditEntries.find(
      (e) => e.op === "mint_grant" && String(e.result).startsWith("denied:passphrase-mismatch"),
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.method).toBe("passphrase");
  });

  // ── Scope limit: only mint_grant accepts passphrase attestation ─────

  it("list_grants from a non-admin agent is still DENIED (operator-only)", async () => {
    // Scope discipline: the agent → operator approval flow only needs
    // MINT. Listing and revoking grants is operator-side audit work
    // and stays admin-agent-only. Pinning this so a future refactor
    // that extends attestation to list/revoke has to consciously
    // widen the threat surface (and add the corresponding zod schema
    // fields).
    const resp = await rpc(socketPath, {
      v: 1,
      op: "list_grants",
      agent: "gymbro",
    });
    expect(resp.ok).toBe(false);
    if (!resp.ok) {
      expect(resp.code).toBe("DENIED");
    }
  });
});
