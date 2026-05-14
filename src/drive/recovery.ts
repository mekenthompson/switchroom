/**
 * Recovery wiring helpers — RFC E §4.4.
 *
 * `reconciler.ts:detectRecovery` produces a `RecoveryEvent` when a
 * Drive scope flips from missing (deleted/trashed) back to present.
 * RFC §4.4 specifies three side-effects on each recovery:
 *
 *   1. Append a `recover` row to `approval_audit` (RFC B §5).
 *   2. Surface `[ ↻ Re-enabled ]` in the next staleness digest
 *      (RFC B §9.1).
 *   3. Post a one-line nudge in the agent's Telegram topic:
 *      "↻ '<title>' is back — let me know if you want me to pick
 *      up where I left off."
 *
 * This module ships the three kernel-agnostic formatters. The
 * reconciler driver loop (which iterates over grants, fetches
 * Drive metadata, calls `detectRecovery`, and triggers these three
 * actions) is the downstream wiring — same shipped-helper-then-wire
 * pattern as the rest of RFC E Phase 1.
 *
 * The split keeps the kernel-side audit insert + the gateway-side
 * chat-post independently testable. A driver can compose them in
 * any order — failing one side-effect shouldn't poison the others.
 */

import type { ApprovalAuditEvent } from "../vault/approvals/schema.js";
import type { RecoveryEvent } from "./reconciler.js";

// ────────────────────────────────────────────────────────────────────────
// 1. Audit row
// ────────────────────────────────────────────────────────────────────────

/**
 * Ready-to-insert payload for the `approval_audit` table. The
 * reconciler driver feeds this into the kernel's audit-write path
 * (same shape the rest of the kernel uses; the `event` is the new
 * `"recover"` value added to `ApprovalAuditEvent`).
 *
 * `decision_id` is intentionally absent — recoveries don't create
 * grants, they surface that an existing grant became reachable
 * again. The audit row stands on its own.
 */
export interface RecoveryAuditRow {
  event: Extract<ApprovalAuditEvent, "recover">;
  agent_unit: string;
  /**
   * Kernel scope the recovered grant covers. RFC E uses Drive scope
   * shapes (`doc:gdrive:<id>` etc); other doc surfaces will reuse
   * this builder when they ship.
   */
  scope: string;
  /**
   * Action grammar value — "read" / "suggest" / "write" / "onboard"
   * depending on which grant recovered. Passes through verbatim
   * from the grant being checked.
   */
  action: string;
  /**
   * JSON-encoded context blob: the file metadata at the moment of
   * recovery + the prior-missing reason + the recovered-to state.
   * The kernel stores this in `approval_audit.context` for post-hoc
   * inspection.
   */
  context: string;
}

export interface BuildRecoveryAuditRowArgs {
  event: RecoveryEvent;
  agent_unit: string;
  scope: string;
  /** Grant's stored `action_grammar` ("read" / "suggest" / "write"). */
  action: string;
}

export function buildRecoveryAuditRow(
  args: BuildRecoveryAuditRowArgs,
): RecoveryAuditRow {
  return {
    event: "recover",
    agent_unit: args.agent_unit,
    scope: args.scope,
    action: args.action,
    context: JSON.stringify({
      from_reason: args.event.fromReason,
      to_state: args.event.toState,
      meta: {
        // Mirror only the Drive fields the operator's post-hoc audit
        // actually needs — name (doc title), mimeType, modifiedTime.
        // Avoid dumping the full `RecoveryEvent.meta` shape because
        // that type evolves with the reconciler and the audit row
        // needs to be stable.
        id: args.event.meta.id,
        name: args.event.meta.name ?? null,
        mimeType: args.event.meta.mimeType ?? null,
        modifiedTime: args.event.meta.modifiedTime ?? null,
      },
    }),
  };
}

// ────────────────────────────────────────────────────────────────────────
// 2. Staleness-digest line
// ────────────────────────────────────────────────────────────────────────

/**
 * Single-line `[ ↻ Re-enabled ]` row for the staleness digest (RFC B
 * §9.1). The digest renderer pulls a list of these and appends them
 * to the "things changed since last digest" section.
 *
 * Format mirrors the RFC §4.4 wording:
 *   `↻ 'Q3 Strategy Notes' is back`
 */
export function buildRecoveryDigestLine(event: RecoveryEvent): string {
  // `DriveFileMetadata.name` is the doc title from Drive's `files.get`.
  // Fall back to the file id when Drive omitted the name (rare; e.g.
  // when the file is shared-with-link and the agent has only the id).
  const title = event.meta.name ?? event.meta.id;
  return `↻ '${title}' is back`;
}

// ────────────────────────────────────────────────────────────────────────
// 3. Chat nudge
// ────────────────────────────────────────────────────────────────────────

/**
 * One-line chat message the reconciler driver posts in the agent's
 * Telegram topic on recovery. Format from RFC §4.4 verbatim:
 *
 *   ↻ 'Q3 Strategy Notes' is back — let me know if you want me to
 *   pick up where I left off.
 *
 * Returns the raw string; the gateway-side caller is responsible
 * for posting it (sendMessage / inject_inbound / wherever the
 * reconciler driver ends up wiring it). No HTML/Markdown — keeps
 * the renderer concern out of this helper.
 */
export function buildRecoveryNudge(event: RecoveryEvent): string {
  // `DriveFileMetadata.name` is the doc title from Drive's `files.get`.
  // Fall back to the file id when Drive omitted the name (rare; e.g.
  // when the file is shared-with-link and the agent has only the id).
  const title = event.meta.name ?? event.meta.id;
  return `↻ '${title}' is back — let me know if you want me to pick up where I left off.`;
}

/**
 * Bundle: build all three artifacts from one `RecoveryEvent` +
 * grant context. Reconciler driver typically wants all three in
 * one call so a failure surfacing a recovery is easy to log
 * coherently.
 */
export interface RecoveryArtifacts {
  auditRow: RecoveryAuditRow;
  digestLine: string;
  nudge: string;
}

export function buildRecoveryArtifacts(
  args: BuildRecoveryAuditRowArgs,
): RecoveryArtifacts {
  return {
    auditRow: buildRecoveryAuditRow(args),
    digestLine: buildRecoveryDigestLine(args.event),
    nudge: buildRecoveryNudge(args.event),
  };
}
