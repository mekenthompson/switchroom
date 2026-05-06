/**
 * Tests for VaultBroker approval-kernel ops (RFC B §4 — folded into the
 * broker rather than a parallel daemon).
 *
 * Round-trips real Unix-socket IPC. Secrets pre-loaded; grants DB is
 * in-memory; non-Linux gate set so peercred bypass is in effect.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { VaultBroker } from "./server.js";
import { encodeRequest, decodeResponse, type BrokerResponse } from "./protocol.js";
import { migrateGrantsSchema } from "../grants.js";
import { migrateApprovalSchema } from "../approvals/schema.js";

function makeInMemoryGrantsDb(): Database {
  const db = new Database(":memory:");
  migrateGrantsSchema(db);
  migrateApprovalSchema(db);
  return db;
}

function makeMinimalConfig() {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: { socket: "~/.switchroom/vault-broker.sock", enabled: true },
    },
    agents: {},
  } as any;
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

describe("VaultBroker: approval-kernel ops", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let grantsDb: Database;
  let prev: string | undefined;

  beforeEach(async () => {
    prev = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-apv-"));
    socketPath = path.join(tmpDir, "t.sock");
    grantsDb = makeInMemoryGrantsDb();
    broker = new VaultBroker({
      _testSecrets: { foo: { kind: "string", value: "bar" } },
      _testConfig: makeMinimalConfig(),
      _testGrantsDb: grantsDb,
      _testAuditLogger: { write: () => { /* swallow */ } },
    });
    await broker.start(socketPath, undefined, undefined);
  });

  afterEach(() => {
    broker.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    if (prev === undefined) delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    else process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prev;
  });

  it("approval_request → approval_consume → approval_lookup full grant flow", async () => {
    // 1) Open the request
    const r1 = await rpc(socketPath, {
      v: 1,
      op: "approval_request",
      agent: "klanker",
      surface: "secret",
      scope: "secret:OPENAI",
      action_grammar: "read",
      approver_set: ["U1"],
      why: "OpenAI API call",
    });
    expect(r1.ok).toBe(true);
    if (!(r1.ok && "request_id" in r1)) throw new Error("bad shape");
    const reqId = r1.request_id;
    expect(reqId).toMatch(/^[0-9a-f]{8}$/);

    // 2) Lookup before tap → no_decision
    const r2 = await rpc(socketPath, {
      v: 1,
      op: "approval_lookup",
      agent: "klanker",
      surface: "secret",
      scope: "secret:OPENAI",
      action_grammar: "read",
      current_approver_set: ["U1"],
    });
    expect(r2.ok).toBe(true);
    if (r2.ok && "status" in r2) expect(r2.status).toBe("no_decision");

    // 3) Consume nonce (gateway has shown the card and user tapped)
    const r3 = await rpc(socketPath, {
      v: 1,
      op: "approval_consume",
      request_id: reqId,
    });
    expect(r3.ok).toBe(true);
    if (r3.ok && "consumed" in r3) {
      expect(r3.consumed).toBe(true);
      expect(r3.scope).toBe("secret:OPENAI");
    }

    // 4) Second consume of same nonce → consumed=false (single-use enforcement)
    const r3b = await rpc(socketPath, {
      v: 1,
      op: "approval_consume",
      request_id: reqId,
    });
    if (r3b.ok && "consumed" in r3b) expect(r3b.consumed).toBe(false);
  });

  it("approval_revoke and approval_list", async () => {
    // Seed a granted decision directly in the DB (the IPC path for
    // record-decision lives in-process inside the gateway tap handler;
    // here we just verify that revoke + list see the row).
    const id = "uuid-1";
    grantsDb.run(
      `INSERT INTO approval_decisions
         (id, agent, surface, scope, action_grammar, granted,
          approver_set, approver_set_canonical, granted_at,
          expires_at, revoked_at, decision_id_chain_prev)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, NULL, NULL)`,
      [
        id,
        "klanker",
        "secret",
        "secret:X",
        "read",
        JSON.stringify(["U1"]),
        JSON.stringify(["U1"]),
        Date.now(),
      ],
    );

    const list = await rpc(socketPath, { v: 1, op: "approval_list" });
    expect(list.ok).toBe(true);
    if (list.ok && "decisions" in list) {
      expect(list.decisions.length).toBe(1);
      expect(list.decisions[0]?.id).toBe(id);
    }

    const rev = await rpc(socketPath, {
      v: 1,
      op: "approval_revoke",
      decision_id: id,
      actor: "U1",
      reason: "no longer needed",
    });
    expect(rev.ok).toBe(true);
    if (rev.ok && "revoked" in rev) expect(rev.revoked).toBe(true);

    const list2 = await rpc(socketPath, { v: 1, op: "approval_list" });
    if (list2.ok && "decisions" in list2) expect(list2.decisions.length).toBe(0);
  });
});
