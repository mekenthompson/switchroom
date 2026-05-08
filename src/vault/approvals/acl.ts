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
 *   - Does the wire-claimed `agent_unit` match the listener's agent? When
 *     they disagree the request is DENIED — the wire claim has no power,
 *     and we surface the mismatch in the audit row so a forensic reviewer
 *     can spot misconfigured agent-side code.
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
