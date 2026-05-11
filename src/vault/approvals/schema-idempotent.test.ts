/**
 * Tests for the approval-kernel schema migration's durability across
 * broker restarts (#969 P2a).
 *
 * Earlier revisions of `migrateApprovalSchema` used DROP+CREATE on every
 * call (on the assumption that no production data had landed yet). With
 * the kernel container shipped to compose AND `vault_request_save` /
 * vault-grant flows now minting durable `allow_always` decisions, a
 * DROP-on-restart wipes operator approvals — which violates the
 * user-facing expectation that tapping "Always" survives a deploy.
 *
 * These tests lock in CREATE-IF-NOT-EXISTS semantics: running the
 * migration twice on the same DB must preserve rows.
 */

import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import { migrateApprovalSchema } from "./schema.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  migrateApprovalSchema(db);
  return db;
}

describe("migrateApprovalSchema — durability (#969 P2a)", () => {
  it("preserves approval_decisions rows across re-migration", () => {
    const db = makeDb();
    db.run(
      `INSERT INTO approval_decisions
        (id, agent_unit, scope, action, decision, ttl_expires_at,
         granted_at, granted_by_user_id, approver_set_canonical)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      [
        "dec_test_001",
        "switchroom-klanker.service",
        "vault:my_key",
        "save",
        "allow_always",
        1_700_000_000,
        12345,
        "[]",
      ],
    );
    // Simulate a broker restart — re-run the migration.
    migrateApprovalSchema(db);
    const row = db
      .query<{ id: string; decision: string }, [string]>(
        "SELECT id, decision FROM approval_decisions WHERE id = ?",
      )
      .get("dec_test_001");
    expect(row).not.toBeNull();
    expect(row?.id).toBe("dec_test_001");
    expect(row?.decision).toBe("allow_always");
  });

  it("preserves approval_audit rows across re-migration", () => {
    const db = makeDb();
    db.run(
      `INSERT INTO approval_audit
        (ts, agent_unit, scope, action, event)
       VALUES (?, ?, ?, ?, ?)`,
      [1_700_000_000, "switchroom-test.service", "vault:k", "save", "grant"],
    );
    migrateApprovalSchema(db);
    const count = db
      .query<{ n: number }, []>("SELECT COUNT(*) as n FROM approval_audit")
      .get();
    expect(count?.n).toBe(1);
  });

  it("preserves approval_nonces rows across re-migration", () => {
    const db = makeDb();
    db.run(
      `INSERT INTO approval_nonces
        (request_id, agent_unit, scope, action, approver_set_canonical,
         created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["abcd1234", "switchroom-test.service", "vault:k", "save", "[]", 1_700_000_000, 1_700_000_300],
    );
    migrateApprovalSchema(db);
    const row = db
      .query<{ request_id: string }, [string]>(
        "SELECT request_id FROM approval_nonces WHERE request_id = ?",
      )
      .get("abcd1234");
    expect(row?.request_id).toBe("abcd1234");
  });

  it("is fully idempotent — running on an existing DB does not throw", () => {
    const db = makeDb();
    expect(() => {
      migrateApprovalSchema(db);
      migrateApprovalSchema(db);
      migrateApprovalSchema(db);
    }).not.toThrow();
  });
});
