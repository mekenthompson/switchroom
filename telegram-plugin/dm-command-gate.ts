/**
 * Pure decision logic for the bot-command access gate.
 *
 * Backport of upstream `5a71459` (claude-plugins-official #894). The
 * /start, /help, /status command handlers used to reply to ANY private
 * DM regardless of `dmPolicy`, leaking the bot's existence to
 * non-allowlisted senders. That contradicted access.json's "drop
 * silently" contract for allowlist mode and the bot-disabled state.
 *
 * Lives in its own module (separate from server.ts and gateway.ts) so
 * the decision can be unit-tested without booting the MCP server or
 * the gateway long-poll. The actual call sites in server.ts and
 * gateway.ts wrap this with `ctx.chat?.type` / `ctx.from` /
 * `loadAccess()` shims.
 */

export interface DmCommandGateInput {
  /** Telegram chat type from `ctx.chat?.type`. Only "private" is allowed. */
  chatType: string | undefined
  /** Stringified sender id from `ctx.from?.id`. Required. */
  senderId: string | undefined
  /** Current access policy: pairing | allowlist | disabled. */
  dmPolicy: "pairing" | "allowlist" | "disabled" | string
  /** Sender ids on the outbound allowlist. */
  allowFrom: readonly string[]
}

export type DmCommandGateDecision =
  | { allow: true; senderId: string }
  | { allow: false; reason: "not-private" | "no-sender" | "disabled" | "not-allowlisted" }

/**
 * Decide whether a bot command (/start, /help, /status) should be
 * answered. Returns `{ allow: false, reason }` on every drop branch
 * so callers and tests can introspect why a particular drop happened.
 *
 * The four drop branches:
 * - `not-private` — non-DM chat (group/supergroup/channel)
 * - `no-sender` — message without a `from` (rare; channel posts)
 * - `disabled` — operator turned the bot off via dmPolicy=disabled
 * - `not-allowlisted` — dmPolicy=allowlist and sender not on `allowFrom`
 *
 * Pairing-mode senders that aren't yet on `allowFrom` are explicitly
 * ALLOWED through — that's how /status surfaces a user's pending code.
 */
export function decideDmCommandGate(input: DmCommandGateInput): DmCommandGateDecision {
  if (input.chatType !== "private") return { allow: false, reason: "not-private" }
  if (input.senderId == null || input.senderId.length === 0) {
    return { allow: false, reason: "no-sender" }
  }
  if (input.dmPolicy === "disabled") return { allow: false, reason: "disabled" }
  if (input.dmPolicy === "allowlist" && !input.allowFrom.includes(input.senderId)) {
    return { allow: false, reason: "not-allowlisted" }
  }
  return { allow: true, senderId: input.senderId }
}
