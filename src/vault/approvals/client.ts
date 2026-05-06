/**
 * Approval-kernel IPC client (RFC B §10).
 *
 * Thin wrapper around `rpcRaw` so callers (gateway, CLI commands, agent
 * sub-modules) can talk to the broker's approval ops without hand-encoding
 * JSON. Each helper returns a typed result or `null` when the broker is
 * unreachable — same convention as `BrokerClient`.
 *
 * The agent-side wait loop (short-poll per RFC §10) is NOT implemented here
 * yet. Phase 1 of the migration is broker-resident state + gateway
 * round-trip; agents that need to wait will short-poll lookupApproval at
 * 2s intervals. That's the next slice of work and is intentionally out of
 * this commit so the surface area stays reviewable.
 */

import { rpcRaw, type BrokerClientOpts } from "../broker/client.js";
import type { ApprovalDecisionMeta } from "../broker/protocol.js";

export interface ApprovalRequestArgs {
  agent: string;
  surface: string;
  scope: string;
  action_grammar: string;
  approver_set: string[];
  why?: string;
  ttl_ms?: number;
}

export interface ApprovalRequestResult {
  request_id: string;
  expires_at: number;
}

export type ApprovalLookupStatus =
  | "granted"
  | "denied"
  | "pending"
  | "expired"
  | "drift_revoked"
  | "no_decision";

export interface ApprovalLookupResult {
  status: ApprovalLookupStatus;
  decision: ApprovalDecisionMeta | null;
}

export interface ApprovalConsumeResult {
  consumed: boolean;
  agent?: string;
  surface?: string;
  scope?: string;
  action_grammar?: string;
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
      agent: args.agent,
      surface: args.surface,
      scope: args.scope,
      action_grammar: args.action_grammar,
      approver_set: args.approver_set,
      why: args.why,
      ttl_ms: args.ttl_ms,
    },
    opts,
  );
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("request_id" in r.resp)) return null;
  return { request_id: r.resp.request_id, expires_at: r.resp.expires_at };
}

export async function approvalLookup(
  args: {
    agent: string;
    surface: string;
    scope: string;
    action_grammar: string;
    current_approver_set: string[];
  },
  opts?: BrokerClientOpts,
): Promise<ApprovalLookupResult | null> {
  const r = await rpcRaw(
    {
      v: 1,
      op: "approval_lookup",
      agent: args.agent,
      surface: args.surface,
      scope: args.scope,
      action_grammar: args.action_grammar,
      current_approver_set: args.current_approver_set,
    },
    opts,
  );
  if (r.kind !== "response" || !r.resp.ok) return null;
  // Both OkStatusResponse and OkApprovalLookupResponse carry `status`, but
  // the former's is an object (BrokerStatus) and the latter's is a string.
  // Narrow on the string-typed shape we actually want.
  if (!("status" in r.resp) || typeof r.resp.status !== "string") return null;
  const lookup = r.resp as { status: string; decision?: ApprovalDecisionMeta | null };
  return {
    status: lookup.status as ApprovalLookupStatus,
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
    agent: r.resp.agent,
    surface: r.resp.surface,
    scope: r.resp.scope,
    action_grammar: r.resp.action_grammar,
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
    granted: boolean;
    approver_set: string[];
    approver_user_id: string;
    ttl_ms?: number | null;
  },
  opts?: BrokerClientOpts,
): Promise<string | null> {
  const r = await rpcRaw(
    {
      v: 1,
      op: "approval_record",
      request_id: args.request_id,
      granted: args.granted,
      approver_set: args.approver_set,
      approver_user_id: args.approver_user_id,
      ttl_ms: args.ttl_ms ?? null,
    },
    opts,
  );
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("decision_id" in r.resp)) return null;
  return r.resp.decision_id;
}

export async function approvalList(
  agent?: string,
  opts?: BrokerClientOpts,
): Promise<ApprovalDecisionMeta[] | null> {
  const r = await rpcRaw({ v: 1, op: "approval_list", agent }, opts);
  if (r.kind !== "response" || !r.resp.ok) return null;
  if (!("decisions" in r.resp)) return null;
  return r.resp.decisions as ApprovalDecisionMeta[];
}
