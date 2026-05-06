/**
 * Approval kernel — SQLite schema (RFC B §5).
 *
 * Three tables in vault-grants.db (kernel folds into the existing broker DB
 * per RFC §4 — no rename, downgrade-friendly):
 *
 *   approval_decisions  — durable allow/deny decisions per (agent, scope, action).
 *   approval_nonces     — short-lived 8-hex callback tokens; single-use redemption.
 *   approval_audit      — append-only audit trail of every kernel event.
 *
 * Schema columns follow the implementation brief verbatim. RFC §5's column
 * names differ in places (e.g. `decision` vs `granted`/`action_grammar`,
 * `agent_unit` vs `agent`); the brief's names win on conflict — they're what
 * the wiring downstream is written against.
 *
 * No HMAC, no chains, no crypto: same-uid is game-over per docs/vault.md:227.
 * `decision_id_chain_prev` is a plain self-FK so a future revocation can
 * point to the prior decision it superseded; this is bookkeeping, not a
 * tamper-evidence chain.
 */

import type { Database } from "bun:sqlite";

/**
 * Idempotent migration. Safe to call on every broker startup. The vault
 * broker already does this for `vault_grants`; we piggyback on the same
 * lifecycle so a fresh vault-grants.db gets all four tables in one shot.
 */
export function migrateApprovalSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS approval_decisions (
      id                       TEXT PRIMARY KEY,
      agent                    TEXT NOT NULL,
      surface                  TEXT NOT NULL,
      scope                    TEXT NOT NULL,
      action_grammar           TEXT NOT NULL,
      granted                  INTEGER NOT NULL,
      approver_set             TEXT NOT NULL,
      approver_set_canonical   TEXT NOT NULL,
      granted_at               INTEGER NOT NULL,
      expires_at               INTEGER,
      revoked_at               INTEGER,
      decision_id_chain_prev   TEXT,
      FOREIGN KEY (decision_id_chain_prev) REFERENCES approval_decisions(id)
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS approval_decisions_lookup
    ON approval_decisions(agent, surface, scope, action_grammar)
    WHERE revoked_at IS NULL
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS approval_nonces (
      request_id   TEXT PRIMARY KEY,
      decision_id  TEXT,
      created_at   INTEGER NOT NULL,
      consumed_at  INTEGER,
      expires_at   INTEGER NOT NULL,
      agent        TEXT NOT NULL,
      surface      TEXT NOT NULL,
      scope        TEXT NOT NULL,
      action_grammar TEXT NOT NULL,
      approver_set_canonical TEXT NOT NULL,
      why          TEXT,
      FOREIGN KEY (decision_id) REFERENCES approval_decisions(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS approval_audit (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id TEXT,
      event       TEXT NOT NULL,
      ts          INTEGER NOT NULL,
      actor       TEXT NOT NULL,
      payload     TEXT,
      FOREIGN KEY (decision_id) REFERENCES approval_decisions(id)
    )
  `);
}

/** Audit event vocabulary — one of these strings goes into approval_audit.event. */
export type ApprovalAuditEvent =
  | "request"
  | "grant"
  | "revoke"
  | "drift_revoke"
  | "consume"
  | "expire"
  | "deny";
