/**
 * Approval kernel — pure DB operations (RFC B §5–§7).
 *
 * Stateless module: every function takes a Database handle and returns a
 * plain result. The IPC broker (server.ts) and the Telegram callback router
 * (gateway/approval-card.ts) call into here. Tests can drive these
 * functions directly against an in-memory SQLite DB without standing up the
 * broker.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { canonicalizeApproverSet } from "./canonical.js";
import type { ApprovalAuditEvent } from "./schema.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ApprovalRequestInput {
  agent: string;
  surface: string;          // 'secret' | 'vault' | 'mcp:notion' | etc
  scope: string;            // RFC §6 scope grammar string
  action_grammar: string;   // 'read' | 'write' | etc
  approver_set: string[];   // current allowFrom; canonicalized + stored
  why?: string;
  ttl_ms?: number;          // nonce expiry; defaults to 5 minutes per §8.1
}

export interface RequestApprovalResult {
  request_id: string;       // 8-hex; goes on the apv: callback_data
  expires_at: number;       // unix-ms when the prompt times out
}

export interface DecisionRow {
  id: string;
  agent: string;
  surface: string;
  scope: string;
  action_grammar: string;
  granted: boolean;
  approver_set: string[];
  approver_set_canonical: string;
  granted_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  decision_id_chain_prev: string | null;
}

export type LookupResult =
  | { status: "granted"; decision: DecisionRow }
  | { status: "denied"; decision: DecisionRow }
  | { status: "pending"; request_id: string }
  | { status: "expired" }
  | { status: "drift_revoked" }
  | { status: "no_decision" };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function generateRequestId(): string {
  // 8 hex chars — matches generateAskId convention in telegram-plugin/ask-user.ts
  return randomBytes(4).toString("hex");
}

function audit(
  db: Database,
  event: ApprovalAuditEvent,
  decisionId: string | null,
  actor: string,
  payload?: Record<string, unknown>,
): void {
  db.run(
    `INSERT INTO approval_audit (decision_id, event, ts, actor, payload)
     VALUES (?, ?, ?, ?, ?)`,
    [
      decisionId,
      event,
      Date.now(),
      actor,
      payload ? JSON.stringify(payload) : null,
    ],
  );
}

function rowToDecision(row: Record<string, unknown>): DecisionRow {
  let approverSet: string[] = [];
  try {
    const parsed = JSON.parse(row.approver_set as string);
    if (Array.isArray(parsed)) approverSet = parsed as string[];
  } catch {
    /* swallow — corrupt row, fall through with empty list */
  }
  return {
    id: row.id as string,
    agent: row.agent as string,
    surface: row.surface as string,
    scope: row.scope as string,
    action_grammar: row.action_grammar as string,
    granted: (row.granted as number) === 1,
    approver_set: approverSet,
    approver_set_canonical: row.approver_set_canonical as string,
    granted_at: row.granted_at as number,
    expires_at: (row.expires_at as number | null) ?? null,
    revoked_at: (row.revoked_at as number | null) ?? null,
    decision_id_chain_prev: (row.decision_id_chain_prev as string | null) ?? null,
  };
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Open a fresh approval request: insert a nonce row, return the request_id
 * the gateway will embed in `apv:<request_id>:<action>` callback_data.
 *
 * No decision row is created yet — that happens on consume (user tap).
 */
export function requestApproval(
  db: Database,
  input: ApprovalRequestInput,
  now: number = Date.now(),
): RequestApprovalResult {
  const request_id = generateRequestId();
  const ttl = input.ttl_ms ?? 5 * 60 * 1000; // 5 min default per §8.1
  const expires_at = now + ttl;
  const canonical = canonicalizeApproverSet(input.approver_set);

  db.run(
    `INSERT INTO approval_nonces
       (request_id, decision_id, created_at, consumed_at, expires_at,
        agent, surface, scope, action_grammar, approver_set_canonical, why)
     VALUES (?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request_id,
      now,
      expires_at,
      input.agent,
      input.surface,
      input.scope,
      input.action_grammar,
      canonical,
      input.why ?? null,
    ],
  );

  audit(db, "request", null, input.agent, {
    request_id,
    surface: input.surface,
    scope: input.scope,
    action_grammar: input.action_grammar,
    why: input.why,
  });

  return { request_id, expires_at };
}

/**
 * Look up whether a given (agent, surface, scope, action) is currently
 * granted. Performs config-drift detection: if the stored
 * approver_set_canonical does not match the current one, the decision is
 * auto-revoked (audit row written) and the caller is told to re-prompt.
 */
export function lookupDecision(
  db: Database,
  query: {
    agent: string;
    surface: string;
    scope: string;
    action_grammar: string;
    current_approver_set: string[];
  },
  now: number = Date.now(),
): LookupResult {
  const currentCanonical = canonicalizeApproverSet(query.current_approver_set);

  const row = db
    .query<Record<string, unknown>, [string, string, string, string]>(
      `SELECT * FROM approval_decisions
       WHERE agent = ? AND surface = ? AND scope = ? AND action_grammar = ?
         AND revoked_at IS NULL
       ORDER BY granted_at DESC LIMIT 1`,
    )
    .get(query.agent, query.surface, query.scope, query.action_grammar);

  if (!row) return { status: "no_decision" };

  const decision = rowToDecision(row);

  // Expiry check (TTL grants)
  if (decision.expires_at !== null && decision.expires_at < now) {
    return { status: "expired" };
  }

  // Drift detection (§5.1): canonical mismatch → auto-revoke + re-prompt.
  if (decision.approver_set_canonical !== currentCanonical) {
    db.run(
      `UPDATE approval_decisions SET revoked_at = ? WHERE id = ?`,
      [now, decision.id],
    );
    audit(db, "drift_revoke", decision.id, "kernel", {
      stored_canonical: decision.approver_set_canonical,
      current_canonical: currentCanonical,
    });
    return { status: "drift_revoked" };
  }

  return decision.granted
    ? { status: "granted", decision }
    : { status: "denied", decision };
}

/**
 * Atomically consume a single-use nonce. Returns the nonce row on first
 * call; returns null on every subsequent call (already consumed, expired,
 * or unknown).
 *
 * The atomicity guarantee comes from `UPDATE … WHERE consumed_at IS NULL`
 * with a rowcount check — SQLite serializes writes within a connection,
 * and bun:sqlite uses one connection per Database handle. Concurrent taps
 * race here; exactly one wins.
 */
export interface NonceRow {
  request_id: string;
  decision_id: string | null;
  created_at: number;
  consumed_at: number | null;
  expires_at: number;
  agent: string;
  surface: string;
  scope: string;
  action_grammar: string;
  approver_set_canonical: string;
  why: string | null;
}

export function consumeNonce(
  db: Database,
  request_id: string,
  now: number = Date.now(),
): NonceRow | null {
  // First read the row so we can return it; the atomic UPDATE either flips
  // consumed_at from NULL→now (we win) or no-ops (someone else won).
  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT * FROM approval_nonces WHERE request_id = ?`,
    )
    .get(request_id);
  if (!row) return null;

  const nonce: NonceRow = {
    request_id: row.request_id as string,
    decision_id: (row.decision_id as string | null) ?? null,
    created_at: row.created_at as number,
    consumed_at: (row.consumed_at as number | null) ?? null,
    expires_at: row.expires_at as number,
    agent: row.agent as string,
    surface: row.surface as string,
    scope: row.scope as string,
    action_grammar: row.action_grammar as string,
    approver_set_canonical: row.approver_set_canonical as string,
    why: (row.why as string | null) ?? null,
  };

  if (nonce.expires_at < now) {
    audit(db, "expire", null, "kernel", { request_id });
    return null;
  }

  const result = db.run(
    `UPDATE approval_nonces SET consumed_at = ?
     WHERE request_id = ? AND consumed_at IS NULL`,
    [now, request_id],
  );

  if ((result.changes ?? 0) === 0) {
    // Already consumed by a concurrent tap — we lose the race.
    return null;
  }

  audit(db, "consume", null, "kernel", { request_id });
  return nonce;
}

/**
 * Record the user's decision and (for grants) write the durable
 * approval_decisions row. Called by the gateway after a successful
 * consumeNonce. Returns the new decision id or null if no row was written
 * (allow_once still records a transient row so /approvals revoke can target
 * it; deny without a chain prev still records).
 */
export interface RecordDecisionInput {
  nonce: NonceRow;
  granted: boolean;
  approver_set: string[];   // for re-storing approver_set_raw alongside canonical
  approver_user_id: string; // who tapped, for audit
  ttl_ms?: number;          // null/undefined → no expiry (allow_always or one-shot)
  decision_id_chain_prev?: string | null;
}

export function recordDecision(
  db: Database,
  input: RecordDecisionInput,
  now: number = Date.now(),
): string {
  const id = randomUUID();
  const expires_at = input.ttl_ms ? now + input.ttl_ms : null;

  db.run(
    `INSERT INTO approval_decisions
       (id, agent, surface, scope, action_grammar, granted,
        approver_set, approver_set_canonical,
        granted_at, expires_at, revoked_at, decision_id_chain_prev)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      id,
      input.nonce.agent,
      input.nonce.surface,
      input.nonce.scope,
      input.nonce.action_grammar,
      input.granted ? 1 : 0,
      JSON.stringify(input.approver_set),
      input.nonce.approver_set_canonical,
      now,
      expires_at,
      input.decision_id_chain_prev ?? null,
    ],
  );

  // Link the nonce → decision for audit traceability.
  db.run(
    `UPDATE approval_nonces SET decision_id = ? WHERE request_id = ?`,
    [id, input.nonce.request_id],
  );

  audit(
    db,
    input.granted ? "grant" : "deny",
    id,
    input.approver_user_id,
    {
      request_id: input.nonce.request_id,
      ttl_ms: input.ttl_ms ?? null,
    },
  );

  return id;
}

/** Revoke a decision by id. Idempotent (revoking a revoked row is a no-op). */
export function revokeDecision(
  db: Database,
  decision_id: string,
  actor: string,
  reason?: string,
  now: number = Date.now(),
): boolean {
  const result = db.run(
    `UPDATE approval_decisions SET revoked_at = ?
     WHERE id = ? AND revoked_at IS NULL`,
    [now, decision_id],
  );
  if ((result.changes ?? 0) === 0) return false;
  audit(db, "revoke", decision_id, actor, reason ? { reason } : undefined);
  return true;
}

/**
 * List active (non-revoked, non-expired) decisions.
 * Optional `agent` filter for the per-agent /approvals list view (RFC §9).
 */
export function listDecisions(
  db: Database,
  filter?: { agent?: string; include_revoked?: boolean },
  now: number = Date.now(),
): DecisionRow[] {
  const includeRevoked = filter?.include_revoked === true;
  let sql = `SELECT * FROM approval_decisions WHERE 1=1`;
  const params: unknown[] = [];
  if (!includeRevoked) {
    sql += ` AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`;
    params.push(now);
  }
  if (filter?.agent !== undefined) {
    sql += ` AND agent = ?`;
    params.push(filter.agent);
  }
  sql += ` ORDER BY granted_at DESC`;
  // bun:sqlite's typings want a tuple, but we build params dynamically.
  // Cast through a shape that satisfies SQLQueryBindings without forcing
  // a fixed arity.
  const rows = (
    db.query(sql) as unknown as {
      all: (...binds: unknown[]) => Record<string, unknown>[];
    }
  ).all(...params);
  return rows.map(rowToDecision);
}

/** Get a single decision by id (for /approvals revoke confirmation, etc). */
export function getDecision(db: Database, id: string): DecisionRow | null {
  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT * FROM approval_decisions WHERE id = ?`,
    )
    .get(id);
  return row ? rowToDecision(row) : null;
}

/** Get a pending/recently-consumed nonce (for callback handlers). */
export function getNonce(db: Database, request_id: string): NonceRow | null {
  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT * FROM approval_nonces WHERE request_id = ?`,
    )
    .get(request_id);
  if (!row) return null;
  return {
    request_id: row.request_id as string,
    decision_id: (row.decision_id as string | null) ?? null,
    created_at: row.created_at as number,
    consumed_at: (row.consumed_at as number | null) ?? null,
    expires_at: row.expires_at as number,
    agent: row.agent as string,
    surface: row.surface as string,
    scope: row.scope as string,
    action_grammar: row.action_grammar as string,
    approver_set_canonical: row.approver_set_canonical as string,
    why: (row.why as string | null) ?? null,
  };
}
