/**
 * Approval-kernel IPC client (RFC B §10).
 *
 * Thin wrapper around `rpcRaw` so callers (gateway, CLI commands, agent
 * sub-modules) can talk to the broker's approval ops without hand-encoding
 * JSON. Each helper returns a typed result or `null` when the broker is
 * unreachable — same convention as `BrokerClient`.
 *
 * Discriminant note: the lookup wire response uses `state` (not `status`) to
 * avoid colliding with `BrokerStatus` on the broker response union. The
 * helpers below normalize that field name out for callers.
 */

import { rpcRaw, type BrokerClientOpts } from "../broker/client.js";
import type {
  ApprovalDecisionMeta,
  ApprovalDecisionMode,
} from "../broker/protocol.js";

export interface ApprovalRequestArgs {
  agent_unit: string;
  scope: string;
  action: string;
  approver_set: string[];
  why?: string;
  ttl_ms?: number;
}

export type ApprovalRequestResult =
  | { state: "pending"; request_id: string; expires_at: number }
  | { state: "rate_limited"; retry_after_ms: number };

export type ApprovalLookupState =
  | "granted"
  | "denied"
  | "pending"
  | "expired"
  | "drift_revoked"
  | "no_decision";

export interface ApprovalLookupResult {
  state: ApprovalLookupState;
  decision: ApprovalDecisionMeta | null;
}

export interface ApprovalConsumeResult {
  consumed: boolean;
  agent_unit?: string;
  scope?: string;
  action?: string;
  why?: string | null;
}

export async function approvalRequest(
  args: ApprovalRequestArgs,
  opts?: BrokerClientOpts,
): Promise<ApprovalRequestResult | null> {
  const r = await rpcRaw(
    {
      v: 1,
      op: "approval_request",
      agent_unit: args.agent_unit,
      scope: args.scope,
      action: args.action,
      approver_set: args.approver_set,
      why: args.why,
      ttl_ms: args.ttl_ms,
    },
    opts,
  );
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("kind" in r.resp) || r.resp.kind !== "approval_request") return null;
  if (r.resp.state === "rate_limited") {
    return { state: "rate_limited", retry_after_ms: r.resp.retry_after_ms };
  }
  return {
    state: "pending",
    request_id: r.resp.request_id,
    expires_at: r.resp.expires_at,
  };
}

export async function approvalLookup(
  args: {
    agent_unit: string;
    scope: string;
    action: string;
    current_approver_set: string[];
  },
  opts?: BrokerClientOpts,
): Promise<ApprovalLookupResult | null> {
  const r = await rpcRaw(
    {
      v: 1,
      op: "approval_lookup",
      agent_unit: args.agent_unit,
      scope: args.scope,
      action: args.action,
      current_approver_set: args.current_approver_set,
    },
    opts,
  );
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("state" in r.resp) || typeof r.resp.state !== "string") return null;
  // Approval lookup is the only response with `state: <string>`. The new
  // approval_request response also has `state` but it's still distinguishable
  // by the values; we narrow on the lookup states here.
  const lookupStates = new Set([
    "granted", "denied", "pending", "expired", "drift_revoked", "no_decision",
  ]);
  if (!lookupStates.has(r.resp.state)) return null;
  const lookup = r.resp as {
    state: ApprovalLookupState;
    decision?: ApprovalDecisionMeta | null;
  };
  return {
    state: lookup.state,
    decision: lookup.decision ?? null,
  };
}

export async function approvalConsume(
  request_id: string,
  opts?: BrokerClientOpts,
): Promise<ApprovalConsumeResult | null> {
  const r = await rpcRaw({ v: 1, op: "approval_consume", request_id }, opts);
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("consumed" in r.resp)) return null;
  return {
    consumed: r.resp.consumed,
    agent_unit: r.resp.agent_unit,
    scope: r.resp.scope,
    action: r.resp.action,
    why: r.resp.why ?? null,
  };
}

export async function approvalRevoke(
  decision_id: string,
  actor: string,
  reason?: string,
  opts?: BrokerClientOpts,
): Promise<boolean | null> {
  const r = await rpcRaw(
    { v: 1, op: "approval_revoke", decision_id, actor, reason },
    opts,
  );
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("revoked" in r.resp)) return null;
  return r.resp.revoked;
}

export async function approvalRecord(
  args: {
    request_id: string;
    decision: ApprovalDecisionMode;
    approver_set: string[];
    granted_by_user_id: number;
    ttl_ms?: number | null;
  },
  opts?: BrokerClientOpts,
): Promise<string | null> {
  const r = await rpcRaw(
    {
      v: 1,
      op: "approval_record",
      request_id: args.request_id,
      decision: args.decision,
      approver_set: args.approver_set,
      granted_by_user_id: args.granted_by_user_id,
      ttl_ms: args.ttl_ms ?? null,
    },
    opts,
  );
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("decision_id" in r.resp)) return null;
  return r.resp.decision_id;
}

export async function approvalList(
  agent_unit?: string,
  opts?: BrokerClientOpts,
): Promise<ApprovalDecisionMeta[] | null> {
  const r = await rpcRaw({ v: 1, op: "approval_list", agent_unit }, opts);
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("decisions" in r.resp)) return null;
  return r.resp.decisions as ApprovalDecisionMeta[];
}
