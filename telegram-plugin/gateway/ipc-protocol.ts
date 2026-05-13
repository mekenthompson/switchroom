// === Gateway -> Bridge (Client) messages ===

export interface InboundMessage {
  type: "inbound";
  chatId: string;
  threadId?: number;
  messageId: number;
  user: string;
  userId: number;
  ts: number;
  text: string;
  imagePath?: string;
  attachment?: { fileId: string; mimeType: string; fileName?: string };
  meta: Record<string, string>;
}

export interface PermissionEvent {
  type: "permission";
  requestId: string;
  behavior: "allow" | "deny";
  /**
   * Session-scoped always-allow rule. Only set when the operator taps
   * "🔁 Always allow" — the gateway already persists the rule to
   * switchroom.yaml + settings.json via `switchroom agent grant`, but
   * those writes only kick in on the NEXT agent boot. This field carries
   * the rule to the running bridge so it can short-circuit future
   * `permission_request` notifications (from the parent claude AND any
   * sub-agents dispatched via the Task tool, which share the same MCP
   * server / bridge process) within the current session.
   *
   * Issue #1138: without this, a sub-agent dispatched after the operator
   * tapped "Always allow" still hit the popup, because Claude Code reads
   * `.claude/settings.json` once at boot.
   *
   * Format matches `resolveAlwaysAllowRule`'s output: bare tool name
   * (`Edit`), `Skill(<name>)`, or `mcp__<server>__<tool>`.
   */
  rule?: string;
}

export interface StatusEvent {
  type: "status";
  status: "agent_down" | "agent_connected" | "gateway_shutting_down";
}

export interface ToolCallResult {
  type: "tool_call_result";
  id: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

export interface ScheduleRestartResult {
  type: "schedule_restart_result";
  success: boolean;
  restartedImmediately?: boolean;
  waitingForTurn?: boolean;
  error?: string;
}

export type GatewayToClient =
  | InboundMessage
  | PermissionEvent
  | StatusEvent
  | ToolCallResult
  | ScheduleRestartResult;

// === Bridge (Client) -> Gateway messages ===

export interface RegisterMessage {
  type: "register";
  agentName: string;
  topicId?: number;
}

export interface ToolCallMessage {
  type: "tool_call";
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface SessionEventForward {
  type: "session_event";
  event: Record<string, unknown>;
  chatId: string;
  threadId?: number;
}

export interface PermissionRequestForward {
  type: "permission_request";
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
}

export interface HeartbeatMessage {
  type: "heartbeat";
  agentName: string;
}

export interface ScheduleRestartMessage {
  type: "schedule_restart";
  agentName: string;
}

/**
 * Forwarded from bridge → gateway when session-tail detects a Claude API
 * error in the JSONL transcript (Phase 4b).
 */
export interface OperatorEventForward {
  type: "operator_event";
  /** OperatorEventKind — kept as string to avoid cross-package type dep. */
  kind: string;
  agent: string;
  detail: string;
  chatId: string;
}

/**
 * Forwarded from bridge → gateway when PTY-tail extracts updated reply
 * text from Claude Code's TUI rendering. The gateway routes the text
 * through `handlePtyPartial` → draft-stream so the user sees the model's
 * reply assemble character-by-character (Claude.ai-style streaming).
 *
 * Sent by bridge.ts's `startPtyTail({onPartial})` callback. The bridge
 * doesn't know the chat id — the gateway resolves it from
 * `currentSessionChatId`, which is set when the bridge forwards the
 * matching `enqueue` session event.
 *
 * No throttle on the wire: PTY-tail's onPartial already coalesces at
 * ~150 ms. Same pattern as session_event forwarding.
 */
export interface PtyPartialForward {
  type: "pty_partial";
  /** Extracted reply text snapshot. Up to ~4096 chars (Telegram limit). */
  text: string;
}

/**
 * Legacy `update_placeholder` IPC from `vendor/hindsight-memory`'s
 * `recall.py` hook. The placeholder UX (`🔵 thinking`, `📚 recalling
 * memories`, `💭 thinking`) was removed in PR #553 PR 5 — the gateway no
 * longer registers a real handler for these. We still accept the wire
 * shape so the validator does NOT reject + log "invalid IPC message
 * shape" on every recall.py invocation, and so the message dispatches to
 * a no-op stub instead of falling through to the default-case warning.
 *
 * Important: we cannot edit `vendor/hindsight-memory/scripts/recall.py`
 * (vendored), so this soft-accept is the correct compatibility shim.
 */
export interface UpdatePlaceholderMessage {
  type: "update_placeholder";
  chatId: string;
  text: string;
}

/**
 * Phase 2 cron-fold-in: a privileged client (the in-agent scheduler
 * sibling, supervised by start.sh under SWITCHROOM_INLINE_SCHEDULER=1)
 * sends this to the gateway to inject a synthesized turn into the
 * agent's bridge. The gateway forwards the embedded `inbound` envelope
 * verbatim via `ipcServer.sendToAgent(agentName, inbound)`.
 *
 * Why a separate envelope rather than a direct inbound on the wire:
 *   1. ClientToGateway and GatewayToClient are distinct directions.
 *      A client cannot send a `type: "inbound"` message — that's a
 *      gateway→client envelope. The bridge's validateGatewayMessage
 *      is its security boundary, and the gateway's validateClientMessage
 *      is the parallel boundary on this side. Wrapping in
 *      `inject_inbound` keeps both validators sharp on their own
 *      direction.
 *   2. The gateway is *deciding* to forward — a future scope check
 *      (e.g., reject inbounds whose `meta.source` is not in a known
 *      set, rate-limit per sender) lives naturally at the gateway.
 *
 * Trust model: the gateway socket lives at a per-agent path inside
 * the agent container; only processes inside that container can
 * connect. `inject_inbound` is therefore as trusted as any other
 * process running under that agent's UID.
 */
export interface InjectInboundMessage {
  type: "inject_inbound";
  /** Target agent name — the gateway routes via sendToAgent. */
  agentName: string;
  /** Forwarded verbatim to the bridge as a `type: "inbound"` envelope. */
  inbound: InboundMessage;
}

export type ClientToGateway =
  | RegisterMessage
  | ToolCallMessage
  | SessionEventForward
  | PermissionRequestForward
  | HeartbeatMessage
  | ScheduleRestartMessage
  | OperatorEventForward
  | PtyPartialForward
  | UpdatePlaceholderMessage
  | InjectInboundMessage;
