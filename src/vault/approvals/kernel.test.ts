/**
 * Tests for the approval kernel (RFC B §5–§7).
 *
 * Uses an in-memory SQLite database for isolation — no disk I/O. Covers:
 *
 *   - migrateApprovalSchema runs cleanly on a fresh DB and is idempotent
 *   - requestApproval → consumeNonce → recordDecision → lookupDecision flow
 *   - Single-use nonce consumption is atomic (concurrent attempts → one wins)
 *   - Expired nonces cannot be consumed
 *   - Drift detection flips canonical mismatch into drift_revoked
 *   - revokeDecision is idempotent and writes audit
 *   - listDecisions filters by agent and excludes revoked/expired by default
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Database } from "bun:sqlite";
import { migrateApprovalSchema } from "./schema.js";
import {
  requestApproval,
  consumeNonce,
  recordDecision,
  lookupDecision,
  revokeDecision,
  listDecisions,
  getNonce,
  getDecision,
} from "./kernel.js";
import { canonicalizeApproverSet } from "./canonical.js";

function newDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  migrateApprovalSchema(db);
  return db;
}

describe("approval kernel — schema", () => {
  it("migrates cleanly on a fresh DB", () => {
    const db = new Database(":memory:");
    expect(() => migrateApprovalSchema(db)).not.toThrow();
    const tables = db
      .query<{ name: string }, []>(
        `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "approval_decisions",
        "approval_nonces",
        "approval_audit",
      ]),
    );
  });

  it("is idempotent", () => {
    const db = newDb();
    expect(() => migrateApprovalSchema(db)).not.toThrow();
  });
});

describe("approval kernel — canonicalize", () => {
  it("normalizes order, whitespace, and dedupes", () => {
    expect(canonicalizeApproverSet(["b", "a"]))
      .toEqual(canonicalizeApproverSet(["a", "b"]));
    expect(canonicalizeApproverSet([" a ", "a"]))
      .toEqual(canonicalizeApproverSet(["a"]));
    expect(canonicalizeApproverSet([]))
      .toEqual("[]");
  });
});

describe("approval kernel — request/consume/record/lookup", () => {
  let db: Database;

  beforeEach(() => {
    db = newDb();
  });

  it("end-to-end grant flow", () => {
    const r = requestApproval(db, {
      agent: "klanker",
      surface: "secret",
      scope: "secret:OPENAI_API_KEY",
      action_grammar: "read",
      approver_set: ["123"],
      why: "needs to call OpenAI",
    });
    expect(r.request_id).toMatch(/^[0-9a-f]{8}$/);
    expect(r.expires_at).toBeGreaterThan(Date.now());

    // Lookup before any tap → no_decision
    expect(
      lookupDecision(db, {
        agent: "klanker",
        surface: "secret",
        scope: "secret:OPENAI_API_KEY",
        action_grammar: "read",
        current_approver_set: ["123"],
      }).status,
    ).toBe("no_decision");

    // User taps Allow
    const nonce = consumeNonce(db, r.request_id);
    expect(nonce).not.toBeNull();
    expect(nonce!.scope).toBe("secret:OPENAI_API_KEY");

    const decisionId = recordDecision(db, {
      nonce: nonce!,
      granted: true,
      approver_set: ["123"],
      approver_user_id: "123",
    });
    expect(decisionId).toBeTruthy();

    // Now lookup returns granted
    const r2 = lookupDecision(db, {
      agent: "klanker",
      surface: "secret",
      scope: "secret:OPENAI_API_KEY",
      action_grammar: "read",
      current_approver_set: ["123"],
    });
    expect(r2.status).toBe("granted");
  });

  it("nonce consumption is atomic — one wins, the other gets null", () => {
    const r = requestApproval(db, {
      agent: "klanker",
      surface: "secret",
      scope: "secret:X",
      action_grammar: "read",
      approver_set: ["123"],
    });
    const a = consumeNonce(db, r.request_id);
    const b = consumeNonce(db, r.request_id);
    // First wins; second observes consumed_at IS NOT NULL → 0 rows updated → null.
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it("expired nonces cannot be consumed", () => {
    // Backdate by passing a future "now" past expires_at
    const r = requestApproval(db, {
      agent: "klanker",
      surface: "secret",
      scope: "secret:X",
      action_grammar: "read",
      approver_set: ["123"],
      ttl_ms: 1, // 1ms TTL
    });
    // Tiny sleep
    const farFuture = Date.now() + 10_000;
    const consumed = consumeNonce(db, r.request_id, farFuture);
    expect(consumed).toBeNull();
  });

  it("getNonce reads back without consuming", () => {
    const r = requestApproval(db, {
      agent: "klanker",
      surface: "secret",
      scope: "secret:Y",
      action_grammar: "read",
      approver_set: ["1"],
    });
    expect(getNonce(db, r.request_id)?.consumed_at).toBeNull();
    consumeNonce(db, r.request_id);
    expect(getNonce(db, r.request_id)?.consumed_at).not.toBeNull();
  });
});

describe("approval kernel — drift detection (§5.1)", () => {
  it("flips to drift_revoked when approver_set changes", () => {
    const db = newDb();
    const r = requestApproval(db, {
      agent: "klanker",
      surface: "vault",
      scope: "vault:NOTION",
      action_grammar: "read",
      approver_set: ["U1"],
    });
    const nonce = consumeNonce(db, r.request_id)!;
    recordDecision(db, {
      nonce,
      granted: true,
      approver_set: ["U1"],
      approver_user_id: "U1",
    });

    // Approver set grows — every standing grant becomes dormant.
    const r2 = lookupDecision(db, {
      agent: "klanker",
      surface: "vault",
      scope: "vault:NOTION",
      action_grammar: "read",
      current_approver_set: ["U1", "U2"],
    });
    expect(r2.status).toBe("drift_revoked");

    // Audit row was written and decision is revoked.
    const audit = db
      .query<{ event: string }, []>(
        `SELECT event FROM approval_audit ORDER BY id DESC LIMIT 1`,
      )
      .get();
    expect(audit?.event).toBe("drift_revoke");

    // Subsequent lookup with the SAME new set still shows no live grant
    // (the old row stays revoked; user has to re-approve).
    const r3 = lookupDecision(db, {
      agent: "klanker",
      surface: "vault",
      scope: "vault:NOTION",
      action_grammar: "read",
      current_approver_set: ["U1", "U2"],
    });
    expect(r3.status).toBe("no_decision");
  });
});

describe("approval kernel — revoke + list", () => {
  it("revokeDecision is idempotent", () => {
    const db = newDb();
    const r = requestApproval(db, {
      agent: "klanker",
      surface: "secret",
      scope: "secret:Z",
      action_grammar: "read",
      approver_set: ["1"],
    });
    const nonce = consumeNonce(db, r.request_id)!;
    const id = recordDecision(db, {
      nonce,
      granted: true,
      approver_set: ["1"],
      approver_user_id: "1",
    });
    expect(revokeDecision(db, id, "1")).toBe(true);
    expect(revokeDecision(db, id, "1")).toBe(false);
    expect(getDecision(db, id)?.revoked_at).not.toBeNull();
  });

  it("listDecisions filters by agent and excludes revoked", () => {
    const db = newDb();
    for (const agent of ["klanker", "gymbro"]) {
      const req = requestApproval(db, {
        agent,
        surface: "secret",
        scope: `secret:${agent}`,
        action_grammar: "read",
        approver_set: ["1"],
      });
      const n = consumeNonce(db, req.request_id)!;
      recordDecision(db, {
        nonce: n,
        granted: true,
        approver_set: ["1"],
        approver_user_id: "1",
      });
    }
    expect(listDecisions(db).length).toBe(2);
    expect(listDecisions(db, { agent: "klanker" }).length).toBe(1);

    // Revoke gymbro's row
    const gymbro = listDecisions(db, { agent: "gymbro" })[0]!;
    revokeDecision(db, gymbro.id, "1");
    expect(listDecisions(db).length).toBe(1);
    expect(listDecisions(db, { include_revoked: true }).length).toBe(2);
  });
});
