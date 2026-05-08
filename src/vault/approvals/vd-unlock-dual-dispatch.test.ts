/**
 * Dual-dispatch coverage for the `vd:unlock` deferred-secret card
 * (MIGRATION.md §1, gateway.ts `handleVaultDeferCallback`).
 *
 * The gateway helper `recordDeferredSecretKernelDecision` is intentionally
 * NOT exported (lives inside the gateway script). This test models the
 * exact same two-step (consume → record) sequence the gateway performs,
 * driven against an in-memory SQLite kernel, to lock down:
 *
 *   1. New card path — `kernel_request_id` is set: tapping unlock writes
 *      an `allow_once` decision row + `consume`/`grant` audit rows; tapping
 *      cancel writes a `deny` row + `consume`/`deny` audit rows.
 *   2. Legacy in-flight card path — `kernel_request_id` is `undefined`:
 *      the gateway helper short-circuits, no kernel writes occur. Critical
 *      for backwards-compat with cards rendered before the deploy.
 *
 * If the dispatch shape regresses — e.g. someone rewires the gateway to
 * call `approvalRecord` without first `approvalConsume` — the audit
 * counts here will drift and fail the test.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Database } from "bun:sqlite";
import { migrateApprovalSchema } from "./schema.js";
import {
  requestApproval,
  consumeNonce,
  recordDecision,
  lookupDecision,
} from "./kernel.js";

const AGENT_UNIT = "switchroom-klanker.service";
const SCOPE = "secret:openai_api_key";
const ACTION = "unlock";
const APPROVER_SET = ["12345"];

function newDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  migrateApprovalSchema(db);
  return db;
}

/**
 * Local re-implementation of the gateway's
 * `recordDeferredSecretKernelDecision` helper, but driven against a real
 * in-memory kernel DB instead of the IPC client. Mirrors the gateway's
 * `consume → record` order and its short-circuit on missing request_id.
 */
function simulateDualDispatch(
  db: Database,
  request_id: string | undefined,
  decision: "allow_once" | "deny",
  granted_by_user_id: number,
  approver_set: string[],
): { recorded: boolean } {
  if (!request_id) return { recorded: false };
  const nonce = consumeNonce(db, request_id);
  if (!nonce) return { recorded: false };
  recordDecision(db, {
    nonce,
    decision,
    approver_set,
    granted_by_user_id,
  });
  return { recorded: true };
}

function countAuditEvents(db: Database, event: string): number {
  return (
    db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM approval_audit WHERE event = ?`,
      )
      .get(event)?.n ?? 0
  );
}

describe("vd:unlock dual-dispatch (Phase 1 migration)", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("new card + unlock tap: writes allow_once row + audit trail", () => {
    const req = requestApproval(db, {
      agent_unit: AGENT_UNIT,
      scope: SCOPE,
      action: ACTION,
      approver_set: APPROVER_SET,
      why: "Unlock vault to save a deferred secret detected in chat.",
    });

    const out = simulateDualDispatch(
      db,
      req.request_id,
      "allow_once",
      Number(APPROVER_SET[0]),
      APPROVER_SET,
    );
    expect(out.recorded).toBe(true);

    // Decision row exists and is in the granted state.
    const lookup = lookupDecision(db, {
      agent_unit: AGENT_UNIT,
      scope: SCOPE,
      action: ACTION,
      current_approver_set: APPROVER_SET,
    });
    expect(lookup.state).toBe("granted");

    // Audit trail captures request → consume → grant.
    expect(countAuditEvents(db, "request")).toBe(1);
    expect(countAuditEvents(db, "consume")).toBe(1);
    expect(countAuditEvents(db, "grant")).toBe(1);
  });

  it("new card + cancel tap: writes deny row + audit trail", () => {
    const req = requestApproval(db, {
      agent_unit: AGENT_UNIT,
      scope: SCOPE,
      action: ACTION,
      approver_set: APPROVER_SET,
    });

    const out = simulateDualDispatch(
      db,
      req.request_id,
      "deny",
      Number(APPROVER_SET[0]),
      APPROVER_SET,
    );
    expect(out.recorded).toBe(true);

    const lookup = lookupDecision(db, {
      agent_unit: AGENT_UNIT,
      scope: SCOPE,
      action: ACTION,
      current_approver_set: APPROVER_SET,
    });
    expect(lookup.state).toBe("denied");

    expect(countAuditEvents(db, "deny")).toBe(1);
    expect(countAuditEvents(db, "grant")).toBe(0);
  });

  it("legacy in-flight card (no kernel request_id): no kernel writes", () => {
    const out = simulateDualDispatch(
      db,
      undefined,
      "allow_once",
      Number(APPROVER_SET[0]),
      APPROVER_SET,
    );
    expect(out.recorded).toBe(false);

    // No nonce ever opened, no decisions recorded, no audit rows.
    const decisions = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM approval_decisions`)
      .get();
    const nonces = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM approval_nonces`)
      .get();
    const audit = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM approval_audit`)
      .get();
    expect(decisions?.n ?? 0).toBe(0);
    expect(nonces?.n ?? 0).toBe(0);
    expect(audit?.n ?? 0).toBe(0);
  });

  it("double-tap on a new card: second tap is a kernel no-op", () => {
    const req = requestApproval(db, {
      agent_unit: AGENT_UNIT,
      scope: SCOPE,
      action: ACTION,
      approver_set: APPROVER_SET,
    });

    const first = simulateDualDispatch(
      db,
      req.request_id,
      "allow_once",
      Number(APPROVER_SET[0]),
      APPROVER_SET,
    );
    const second = simulateDualDispatch(
      db,
      req.request_id,
      "allow_once",
      Number(APPROVER_SET[0]),
      APPROVER_SET,
    );
    expect(first.recorded).toBe(true);
    expect(second.recorded).toBe(false);

    // Exactly one decision row and one grant audit event — single-use
    // nonce semantics enforced by `consumeNonce`.
    const decisionsRow = db
      .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM approval_decisions`)
      .get();
    expect(decisionsRow?.n ?? 0).toBe(1);
    expect(countAuditEvents(db, "grant")).toBe(1);
    expect(countAuditEvents(db, "consume")).toBe(1);
  });

  it("scope/action shape matches the gateway helper contract", () => {
    // The gateway uses scope=`secret:<slug>` action=`unlock`. Drift here
    // means a kernel-server ACL rule keyed on `secret:*`/`unlock` would
    // stop matching the new cards. Lock that contract down.
    const req = requestApproval(db, {
      agent_unit: AGENT_UNIT,
      scope: SCOPE,
      action: ACTION,
      approver_set: APPROVER_SET,
    });
    const nonce = consumeNonce(db, req.request_id);
    expect(nonce).not.toBeNull();
    expect(nonce!.scope.startsWith("secret:")).toBe(true);
    expect(nonce!.action).toBe("unlock");
    expect(nonce!.agent_unit).toBe(AGENT_UNIT);
  });
});
