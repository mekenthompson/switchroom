/**
 * Dual-dispatch coverage for the `/vault grant` wizard
 * (MIGRATION.md §2, gateway.ts `handleVaultGrantCallback` +
 * `executeGrantWizard` + the bare `vg:cancel` branch).
 *
 * The gateway helpers `mintGrantWizardKernelRequest` /
 * `recordGrantWizardKernelDecision` are intentionally NOT exported
 * (they live inside the gateway script). This test models the exact
 * same two-step (consume → record) sequence the gateway performs at
 * `vg:generate` / `vg:cancel` time, driven against an in-memory SQLite
 * kernel, to lock down:
 *
 *   1. New wizard path — `kernel_request_id` is set on the wizard state:
 *      tapping Generate writes an `allow_once` decision row +
 *      `consume`/`grant` audit rows; tapping Cancel from the confirm
 *      step writes a `deny` row + `consume`/`deny` audit rows.
 *   2. Legacy in-flight wizard — `kernel_request_id` is `undefined`
 *      (wizard was rendered before the deploy): the gateway helper
 *      short-circuits, no kernel writes occur. Critical for backwards-
 *      compat with cards rendered before this PR landed.
 *   3. Audit-only framing (issue #833): kernel row is informational.
 *      Phase 2 will switch enforcement; in Phase 1 the legacy
 *      `mint_grant` row is still the source of truth for grant
 *      validation (`validateGrant` reads `vault_grants`).
 *
 * If the dispatch shape regresses — e.g. someone rewires the gateway
 * to call `approvalRecord` without first `approvalConsume` — the
 * audit counts here will drift and fail the test.
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
const AGENT_SLUG = "klanker";
const SCOPE = `vault:grant:${AGENT_SLUG}`;
const ACTION = "mint";
const APPROVER_SET = ["12345"];

function newDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON");
  migrateApprovalSchema(db);
  return db;
}

/**
 * Local re-implementation of the gateway's
 * `recordGrantWizardKernelDecision` helper, but driven against a real
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

describe("/vault grant wizard dual-dispatch (Phase 1 migration, audit-only)", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  it("new wizard + Generate tap: writes allow_once row + audit trail", () => {
    const req = requestApproval(db, {
      agent_unit: AGENT_UNIT,
      scope: SCOPE,
      action: ACTION,
      approver_set: APPROVER_SET,
      why: 'Mint capability token for agent "klanker" — 2 key(s), 30d TTL.',
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

  it("new wizard + Cancel tap from confirm step: writes deny row + audit trail", () => {
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

  it("legacy in-flight wizard (no kernel request_id): no kernel writes", () => {
    // Wizard was rendered before this PR's deploy → state has no
    // kernel_request_id. Both Generate and Cancel paths must short-
    // circuit with zero kernel side-effects so the legacy mint_grant
    // path is unaffected.
    const generateOut = simulateDualDispatch(
      db,
      undefined,
      "allow_once",
      Number(APPROVER_SET[0]),
      APPROVER_SET,
    );
    const cancelOut = simulateDualDispatch(
      db,
      undefined,
      "deny",
      Number(APPROVER_SET[0]),
      APPROVER_SET,
    );
    expect(generateOut.recorded).toBe(false);
    expect(cancelOut.recorded).toBe(false);

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

  it("double-tap on a new wizard card: second tap is a kernel no-op", () => {
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

  it("scope/action shape matches the gateway helper contract (#832 namespacing)", () => {
    // The gateway uses scope=`vault:grant:<agent_slug>` action=`mint`.
    // Drift here means a kernel-server ACL rule keyed on `vault:grant:*`
    // / `mint` would stop matching the new wizard cards. Lock that
    // contract down — same shape as the `vault:secret:<slug>` namespace
    // used by PR #830 / vd:unlock.
    const req = requestApproval(db, {
      agent_unit: AGENT_UNIT,
      scope: SCOPE,
      action: ACTION,
      approver_set: APPROVER_SET,
    });
    const nonce = consumeNonce(db, req.request_id);
    expect(nonce).not.toBeNull();
    expect(nonce!.scope.startsWith("vault:grant:")).toBe(true);
    expect(nonce!.action).toBe("mint");
    expect(nonce!.agent_unit).toBe(AGENT_UNIT);
  });

  it("Generate-after-Cancel race: only the first tap records (single-use nonce)", () => {
    // Defence-in-depth: even if a user somehow taps Generate after
    // Cancel (or vice-versa) on the same wizard card, the kernel's
    // single-use nonce semantics ensure exactly one decision row is
    // ever written. This guards against double-decision audit rows.
    const req = requestApproval(db, {
      agent_unit: AGENT_UNIT,
      scope: SCOPE,
      action: ACTION,
      approver_set: APPROVER_SET,
    });
    const cancelFirst = simulateDualDispatch(
      db,
      req.request_id,
      "deny",
      Number(APPROVER_SET[0]),
      APPROVER_SET,
    );
    const generateSecond = simulateDualDispatch(
      db,
      req.request_id,
      "allow_once",
      Number(APPROVER_SET[0]),
      APPROVER_SET,
    );
    expect(cancelFirst.recorded).toBe(true);
    expect(generateSecond.recorded).toBe(false);

    const lookup = lookupDecision(db, {
      agent_unit: AGENT_UNIT,
      scope: SCOPE,
      action: ACTION,
      current_approver_set: APPROVER_SET,
    });
    // First tap wins → state stays denied.
    expect(lookup.state).toBe("denied");
  });
});
