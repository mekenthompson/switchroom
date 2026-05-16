/**
 * Phase 2b — approval kernel ACL by agent name.
 *
 * Symmetric with `src/vault/broker/acl.ts:checkAclByAgent` (Phase 2a). The
 * kernel binds a per-agent listener at `/run/switchroom/kernel/<agent>/sock`
 * (see `kernel-server.ts`); the listener's bind-time agent name is the
 * trusted identity for any connection accepted on it. NO wire-payload field
 * — including `agent_unit` — can override that.
 *
 * What this guard checks:
 *
 *   - Was the connection accepted on a listener with a known agent name?
 *     (The kernel-server today rejects unidentified listeners at bind, so
 *     the runtime invariant is "agentName non-empty by construction" —
 *     but this helper is fail-closed for tests / future callers that pass
 *     an empty string.)
 *
 *   - Does the candidate `agent_unit` match the listener's agent? When
 *     they disagree the request is DENIED. The candidate is the
 *     wire-claimed `agent_unit` for `approval_request`/`approval_lookup`,
 *     and the *resolved DB row's* `agent_unit` for the mutating ops
 *     (`approval_consume`/`approval_revoke`/`approval_record`, #1399) —
 *     either way the listener's bind-time identity is the only authority;
 *     the caller-supplied id selects the row but cannot grant cross-agent
 *     reach. Mismatches surface in the audit row for forensics.
 *
 * The kernel does NOT carry a per-key allowlist analogous to the broker's
 * `schedule[i].secrets`. Per-agent isolation IS the security model: every
 * approval-kernel row is keyed on `agent_unit`, and a listener bound for
 * `alice` can only ever write `alice` rows. So the ACL surface is just
 * the name-equality check; once it passes, the kernel.ts code paths
 * naturally scope their reads/writes to `agent_unit = <listener>`.
 */

export type ApprovalAclResult =
  | { allow: true }
  | { allow: false; reason: string };

export function checkApprovalAclByAgent(
  listenerAgent: string,
  claimedAgentUnit: string,
): ApprovalAclResult {
  if (!listenerAgent) {
    return {
      allow: false,
      reason: "listener has no bound agent identity (kernel-server bind misconfiguration)",
    };
  }
  if (!claimedAgentUnit) {
    return {
      allow: false,
      reason: "request has no agent_unit; refusing to attribute to listener identity by default",
    };
  }
  if (claimedAgentUnit !== listenerAgent) {
    return {
      allow: false,
      reason: `agent_unit mismatch: socket=${listenerAgent}, claim=${claimedAgentUnit}`,
    };
  }
  return { allow: true };
}
