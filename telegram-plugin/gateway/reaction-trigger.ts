/**
 * Reaction-trigger predicate, per-chat hour cap, and debounce buffer.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/1074
 *
 * Wires bot-message emoji reactions into the agent as synthetic
 * `<channel source="reaction">` inbound turns. Mirrors the cron-fold-in
 * dispatch path (`meta.source="cron"` → `meta.source="reaction"`).
 *
 * This module is gateway-internal pure logic — no Telegram API calls,
 * no IPC. The gateway's `message_reaction` handler wires:
 *
 *   1. `evaluateTriggerCandidate(...)` — synchronous predicate.
 *   2. (async, group only) admin-status lookup via getChatMember.
 *   3. `HourCap.tryConsume(chatId)` — refuses past the per-hour limit.
 *   4. `DebounceBuffer.enqueue(...)` — batches rapid reactions into a
 *      single delivered synthetic; the buffer's caller emits the
 *      InboundMessageWire.
 *
 * Defaults are baked here so the gateway can resolve them from a
 * possibly-undefined cascade slice (`config.agents[name].reactions`).
 *
 * Trust model: same as cron-fold-in (`src/scheduler/dispatch.ts`).
 * The synthesized inbound's `text` carries an `<channel
 * source="reaction">` envelope plus the bot-side message preview
 * (capped) — NO bot token, NO vault material.
 */

export interface ReactionsResolvedConfig {
  enabled: boolean;
  triggerEmojis: ReadonlySet<string>;
  debounceMs: number;
  perHourCap: number;
  groupAdminOnly: boolean;
}

/**
 * Built-in defaults — applied when the cascade does not set a field.
 * Documented in `docs/configuration.md` and stamped as the spec
 * decision (Ken approved 2026-05-12).
 */
export const REACTIONS_DEFAULTS: ReactionsResolvedConfig = Object.freeze({
  enabled: true,
  triggerEmojis: Object.freeze(new Set(['👎', '❌', '👍', '✅'])) as ReadonlySet<string>,
  debounceMs: 30_000,
  perHourCap: 10,
  groupAdminOnly: true,
});

/**
 * Cascade-resolved reactions slice as it appears on the agent config.
 * Shape mirrors `ReactionsSchema` in `src/config/schema.ts`. We type
 * the raw input loosely so this module can stay independent of the
 * src/ side's zod schemas.
 */
export interface ReactionsConfigInput {
  enabled?: boolean;
  trigger_emojis?: readonly string[];
  debounce_ms?: number;
  per_hour_cap?: number;
  group_admin_only?: boolean;
}

/**
 * Fold a raw cascade-resolved `reactions:` block into the runtime
 * shape, filling in defaults for missing fields. A `null` or
 * `undefined` raw input collapses to the built-in defaults.
 */
export function resolveReactionsConfig(
  raw: ReactionsConfigInput | null | undefined,
): ReactionsResolvedConfig {
  if (!raw) return REACTIONS_DEFAULTS;
  return {
    enabled: raw.enabled ?? REACTIONS_DEFAULTS.enabled,
    triggerEmojis: raw.trigger_emojis !== undefined
      ? new Set(raw.trigger_emojis)
      : REACTIONS_DEFAULTS.triggerEmojis,
    debounceMs: raw.debounce_ms ?? REACTIONS_DEFAULTS.debounceMs,
    perHourCap: raw.per_hour_cap ?? REACTIONS_DEFAULTS.perHourCap,
    groupAdminOnly: raw.group_admin_only ?? REACTIONS_DEFAULTS.groupAdminOnly,
  };
}

// ─── Predicate ───────────────────────────────────────────────────────────

export interface TriggerCandidate {
  /** Negative for groups/supergroups, positive for DMs (Bot API convention). */
  chatId: number;
  /** Telegram message_id the reaction was placed on. */
  messageId: number;
  /** Emoji string from the new_reaction; null when not a plain emoji. */
  emoji: string | null;
  /** 'add' | 'change' — 'remove' candidates are rejected pre-call. */
  action: 'add' | 'change';
  /** Whether the target message was authored by the bot (lookup). */
  botAuthored: boolean;
}

export type TriggerDecision =
  | { ok: true }
  | { ok: false; reason:
        | 'disabled'
        | 'not_bot_authored'
        | 'emoji_not_in_allowlist'
        | 'no_emoji' };

/**
 * Synchronous predicate — checks everything the gateway can decide
 * without an API round-trip. Group-admin check and hour-cap consumption
 * are layered above this by the gateway handler.
 */
export function evaluateTriggerCandidate(
  cfg: ReactionsResolvedConfig,
  c: TriggerCandidate,
): TriggerDecision {
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (!c.botAuthored) return { ok: false, reason: 'not_bot_authored' };
  if (c.emoji === null) return { ok: false, reason: 'no_emoji' };
  if (!cfg.triggerEmojis.has(c.emoji)) {
    return { ok: false, reason: 'emoji_not_in_allowlist' };
  }
  return { ok: true };
}

/** Group/supergroup chats use negative IDs in the Bot API. */
export function isGroupChat(chatId: number): boolean {
  return chatId < 0;
}

// ─── Per-chat hour cap ───────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;

/**
 * In-memory rolling-1-hour counter per chat. Pure data structure —
 * not exported to a singleton so tests can construct their own.
 *
 * The cap is enforced at point-of-consume. Refusals don't surface to
 * the agent (the user may not even know they reacted past the cap);
 * the gateway logs them to stderr.
 */
export class HourCap {
  private readonly stamps = new Map<string, number[]>();
  constructor(
    private readonly cap: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Returns true if the caller may proceed (and records the timestamp).
   * Returns false when the chat is at-or-past the cap in the trailing
   * hour window. Cap=0 always refuses.
   */
  tryConsume(chatId: string): boolean {
    if (this.cap <= 0) return false;
    const t = this.now();
    const cutoff = t - HOUR_MS;
    const arr = this.stamps.get(chatId) ?? [];
    // Prune in-place — cheap as long as cap stays small (<= 100s).
    const pruned = arr.filter((s) => s > cutoff);
    if (pruned.length >= this.cap) {
      this.stamps.set(chatId, pruned);
      return false;
    }
    pruned.push(t);
    this.stamps.set(chatId, pruned);
    return true;
  }

  /** Trailing-hour count for inspection / metrics. Test-only friendly. */
  size(chatId: string): number {
    const cutoff = this.now() - HOUR_MS;
    return (this.stamps.get(chatId) ?? []).filter((s) => s > cutoff).length;
  }
}

// ─── Debounce buffer ─────────────────────────────────────────────────────

/**
 * One pending reaction held in the buffer.
 */
export interface PendingReaction {
  /** Bot-side message id the user reacted to. */
  targetMessageId: number;
  /** Emoji from the new_reaction. */
  emoji: string;
  /** add | change. */
  action: 'add' | 'change';
  /** Acquired wall-clock ms. */
  ts: number;
  /** First ~200 chars of the bot message text (preview). */
  preview: string;
  /** Reacter user_id for the synthesized inbound's userId field. */
  userId: number;
  /** Display name of the reacter (first_name → username → string id). */
  user: string;
  /** Forum thread id if the reacted message was in a topic. */
  threadId?: number;
}

/**
 * Collapsed delivery payload — the buffer hands one of these to its
 * sink when the debounce window elapses. `batched` carries N>=2
 * entries; `single` carries exactly one.
 */
export interface ReactionBatch {
  /** Bot API chatId (number form — gateway stringifies for the wire). */
  chatId: number;
  reactions: PendingReaction[];
  /** True when >1 reaction collapsed into this delivery. */
  batched: boolean;
}

/** Maximum inline reactions named in a batched synthetic's text. */
export const BATCH_INLINE_LIMIT = 10;
/** Max preview length (chars) of the bot message the user reacted to. */
export const PREVIEW_MAX_CHARS = 200;

/**
 * Truncate to PREVIEW_MAX_CHARS, marking trailing truncation with `…`.
 * Returns "" for null/undefined input; safe to pass arbitrary strings.
 */
export function truncatePreview(text: string | null | undefined): string {
  if (!text) return '';
  if (text.length <= PREVIEW_MAX_CHARS) return text;
  return text.slice(0, PREVIEW_MAX_CHARS - 1) + '…';
}

/**
 * Per-chat reaction debounce buffer.
 *
 * On `enqueue`, the buffer either starts a new timer (single pending)
 * or appends to an existing one (batched). When the timer fires, the
 * buffer hands the accumulated batch to `sink` and clears.
 *
 * Uses node's setTimeout under the hood via the injected `schedule`
 * helper so tests can drive it with a fake clock.
 *
 * Each pending entry is bounded by the cap (default
 * `BATCH_INLINE_LIMIT * 4 = 40`) — older entries beyond the cap are
 * dropped silently to prevent unbounded growth under a reaction storm.
 */
export class DebounceBuffer {
  private readonly pending = new Map<number, PendingReaction[]>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly maxPending: number;

  constructor(
    private readonly windowMs: number,
    private readonly sink: (batch: ReactionBatch) => void,
    opts?: {
      maxPending?: number;
      /** Test-only injection of timer functions. */
      schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
      cancel?: (h: ReturnType<typeof setTimeout>) => void;
    },
  ) {
    this.maxPending = opts?.maxPending ?? BATCH_INLINE_LIMIT * 4;
    if (opts?.schedule) this.schedule = opts.schedule;
    if (opts?.cancel) this.cancel = opts.cancel;
  }

  private schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> =
    setTimeout;
  private cancel: (h: ReturnType<typeof setTimeout>) => void = clearTimeout;

  enqueue(chatId: number, entry: PendingReaction): void {
    const existing = this.pending.get(chatId);
    if (existing) {
      if (existing.length < this.maxPending) existing.push(entry);
      // else: storm — drop. Older entries are kept because they came first
      // and are still informative; new ones add nothing past the cap.
      return;
    }
    this.pending.set(chatId, [entry]);
    const h = this.schedule(() => this.flush(chatId), this.windowMs);
    this.timers.set(chatId, h);
  }

  /**
   * Flush a chat's pending batch immediately. Used by tests and by
   * shutdown drains. Idempotent — flushing an empty chat is a no-op.
   */
  flush(chatId: number): void {
    const reactions = this.pending.get(chatId);
    this.pending.delete(chatId);
    const h = this.timers.get(chatId);
    if (h) {
      this.cancel(h);
      this.timers.delete(chatId);
    }
    if (!reactions || reactions.length === 0) return;
    this.sink({
      chatId,
      reactions,
      batched: reactions.length > 1,
    });
  }

  /** Test-only: number of chats with pending entries. */
  pendingChatCount(): number {
    return this.pending.size;
  }

  /** Drain all pending without firing the sink — used on shutdown. */
  clear(): void {
    for (const h of this.timers.values()) this.cancel(h);
    this.timers.clear();
    this.pending.clear();
  }
}

// ─── Inbound text builder ────────────────────────────────────────────────

/**
 * Build the `text` field of the synthesized InboundMessage. The agent
 * sees this as a turn — the `<channel source="reaction">` envelope
 * signals the source. Group of helpers is exported so tests can pin
 * the exact wire shape.
 */
export function buildReactionInboundText(batch: ReactionBatch): string {
  if (batch.reactions.length === 0) {
    // Defensive — buildReactionInboundText should never see an empty
    // batch since DebounceBuffer.flush early-returns on empty.
    return '<channel source="reaction"/>';
  }
  if (batch.reactions.length === 1) {
    const r = batch.reactions[0]!;
    const safeEmoji = escapeAttr(r.emoji);
    const safeAction = escapeAttr(r.action);
    const safePreview = escapeBody(r.preview);
    return (
      `<channel source="reaction" emoji="${safeEmoji}" ` +
      `action="${safeAction}" target_message_id="${r.targetMessageId}">` +
      `User reacted ${r.emoji} to your message: "${safePreview}"` +
      `</channel>`
    );
  }
  // Batched
  const total = batch.reactions.length;
  const shown = batch.reactions.slice(0, BATCH_INLINE_LIMIT);
  const more = total - shown.length;
  const lines = shown.map(
    (r) => `${r.emoji} on msg ${r.targetMessageId} ("${escapeBody(r.preview)}")`,
  );
  const trailer = more > 0 ? ` (+${more} more)` : '';
  return (
    `<channel source="reaction" batched="true" count="${total}">` +
    `User reacted to your messages — ${total} new reactions: ` +
    lines.join('; ') +
    trailer +
    `</channel>`
  );
}

/**
 * Build the `meta` map. Wire-format requires string values only.
 */
export function buildReactionInboundMeta(batch: ReactionBatch): Record<string, string> {
  const r = batch.reactions[0];
  if (!r) {
    return { source: 'reaction', batched: 'false', count: '0' };
  }
  if (!batch.batched) {
    return {
      source: 'reaction',
      reaction_emoji: r.emoji,
      reaction_action: r.action,
      target_message_id: String(r.targetMessageId),
      target_message_preview: r.preview,
      batched: 'false',
      count: '1',
    };
  }
  return {
    source: 'reaction',
    batched: 'true',
    count: String(batch.reactions.length),
    // For batched deliveries we still expose the first reaction's
    // discriminators — preserves the single-shape contract for
    // downstream consumers that only care about "the most recent".
    reaction_emoji: r.emoji,
    reaction_action: r.action,
    target_message_id: String(r.targetMessageId),
    target_message_preview: r.preview,
  };
}

// Minimal XML-attr escape; preview body uses a slightly looser escape
// because it lands inside the element body, not an attribute value.
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeBody(s: string): string {
  return s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
