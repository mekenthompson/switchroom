/**
 * End-to-end flow test for the reaction-trigger pipeline (#1074).
 *
 * Mirrors the gateway handler's decision flow (predicate → admin check
 * → hour cap → debounce → InboundMessage build → dispatch) without
 * pulling in the gateway module's heavy side-effects. The integration
 * point that matters is the SHAPE of the InboundMessage emitted to the
 * dispatcher — that's what the bridge sees as a synthetic turn.
 *
 * What this test pins:
 *   1. A bot-authored 👎 dispatches a single inbound with
 *      `meta.source="reaction"` after the debounce window.
 *   2. A ❤️ reaction (not in default allowlist) dispatches NOTHING.
 *   3. A user-authored target message dispatches NOTHING.
 *   4. Two reactions within the window collapse into one batched
 *      synthetic with the second emoji NOT lost.
 *   5. The hour cap refuses past the limit (no inbound emitted).
 *   6. Group + non-admin reacter dispatches NOTHING.
 *   7. Group + admin reacter dispatches normally.
 *
 * Each scenario builds a fresh HourCap + DebounceBuffer so state never
 * leaks across tests.
 */

import { describe, it, expect } from 'bun:test'
import {
  DebounceBuffer,
  HourCap,
  REACTIONS_DEFAULTS,
  buildReactionInboundMeta,
  buildReactionInboundText,
  evaluateTriggerCandidate,
  isGroupChat,
  resolveReactionsConfig,
  truncatePreview,
  type PendingReaction,
  type ReactionBatch,
  type ReactionsResolvedConfig,
} from '../gateway/reaction-trigger.ts'

interface FakeInbound {
  chatId: string
  text: string
  meta: Record<string, string>
  userId: number
  user: string
  messageId: number
  threadId?: number
}

/**
 * Test driver that mirrors the gateway handler flow.
 */
interface DriverState {
  cfg: ReactionsResolvedConfig
  cap: HourCap
  buf: DebounceBuffer
  sched: FakeScheduler
  dispatched: FakeInbound[]
  /** Map from message_id → role + text. */
  history: Map<number, { role: 'user' | 'assistant'; text: string }>
  /** Set of user_ids treated as group admin (consulted on group chats). */
  admins: Set<number>
}

interface FakeScheduler {
  pending: Array<{ id: number; fn: () => void }>
  schedule: (fn: () => void, ms: number) => { id: number; fn: () => void }
  cancel: (h: { id: number }) => void
  flushAll: () => void
}

function makeScheduler(): FakeScheduler {
  let next = 1
  const pending: Array<{ id: number; fn: () => void }> = []
  return {
    pending,
    schedule(fn) {
      const h = { id: next++, fn }
      pending.push(h)
      return h
    },
    cancel(h) {
      const i = pending.findIndex((p) => p.id === h.id)
      if (i >= 0) pending.splice(i, 1)
    },
    flushAll() {
      const snap = pending.splice(0)
      for (const p of snap) p.fn()
    },
  }
}

function makeDriver(over: Partial<ReactionsResolvedConfig> = {}): DriverState {
  const cfg = { ...REACTIONS_DEFAULTS, ...over }
  const sched = makeScheduler()
  const dispatched: FakeInbound[] = []
  const buf = new DebounceBuffer(
    cfg.debounceMs,
    (b) => dispatchBatch(b, dispatched),
    { schedule: sched.schedule as never, cancel: sched.cancel as never },
  )
  return {
    cfg,
    cap: new HourCap(cfg.perHourCap),
    buf,
    sched,
    dispatched,
    history: new Map(),
    admins: new Set(),
  }
}

function dispatchBatch(batch: ReactionBatch, sink: FakeInbound[]): void {
  const head = batch.reactions[batch.reactions.length - 1]!
  sink.push({
    chatId: String(batch.chatId),
    text: buildReactionInboundText(batch),
    meta: buildReactionInboundMeta(batch),
    userId: head.userId,
    user: head.user,
    messageId: Date.now(),
    ...(head.threadId !== undefined ? { threadId: head.threadId } : {}),
  })
}

/**
 * Replays the gateway's handler logic against the driver.
 *
 * Returns the rejection reason (or 'enqueued') so the test can assert
 * the exact branch taken without grepping stderr.
 */
function feedReaction(
  d: DriverState,
  args: {
    chatId: number
    messageId: number
    emoji: string | null
    action: 'add' | 'change' | 'remove'
    reacterId: number
    reacterName?: string
    threadId?: number
  },
):
  | { kind: 'persisted_only'; reason: string }
  | { kind: 'enqueued' } {
  if (args.action === 'remove' || args.emoji === null) {
    return { kind: 'persisted_only', reason: 'remove_or_null_emoji' }
  }
  const row = d.history.get(args.messageId)
  const botAuthored = row?.role === 'assistant'
  const preview = truncatePreview(row?.text ?? '')
  const decision = evaluateTriggerCandidate(d.cfg, {
    chatId: args.chatId,
    messageId: args.messageId,
    emoji: args.emoji,
    action: args.action,
    botAuthored,
  })
  if (!decision.ok) {
    return { kind: 'persisted_only', reason: decision.reason }
  }
  if (d.cfg.groupAdminOnly && isGroupChat(args.chatId)) {
    if (!d.admins.has(args.reacterId)) {
      return { kind: 'persisted_only', reason: 'group_non_admin' }
    }
  }
  if (!d.cap.tryConsume(String(args.chatId))) {
    return { kind: 'persisted_only', reason: 'hour_cap_exhausted' }
  }
  const pending: PendingReaction = {
    targetMessageId: args.messageId,
    emoji: args.emoji,
    action: args.action,
    ts: Date.now(),
    preview,
    userId: args.reacterId,
    user: args.reacterName ?? `u${args.reacterId}`,
    ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
  }
  d.buf.enqueue(args.chatId, pending)
  return { kind: 'enqueued' }
}

// ─── Scenarios ───────────────────────────────────────────────────────────

describe('reaction-trigger flow', () => {
  it('bot-authored 👎 dispatches a synthetic inbound with meta.source="reaction"', () => {
    const d = makeDriver()
    d.history.set(42, { role: 'assistant', text: 'hello from bot' })
    const r = feedReaction(d, {
      chatId: 100, messageId: 42, emoji: '👎', action: 'add', reacterId: 7,
    })
    expect(r.kind).toBe('enqueued')
    expect(d.dispatched.length).toBe(0)
    d.sched.flushAll()
    expect(d.dispatched.length).toBe(1)
    const out = d.dispatched[0]!
    expect(out.meta.source).toBe('reaction')
    expect(out.meta.batched).toBe('false')
    expect(out.meta.reaction_emoji).toBe('👎')
    expect(out.meta.target_message_id).toBe('42')
    expect(out.text).toContain('<channel source="reaction"')
    expect(out.text).toContain('hello from bot')
    expect(out.userId).toBe(7)
  })

  it('❤️ (not in default allowlist) dispatches NOTHING (negative)', () => {
    const d = makeDriver()
    d.history.set(42, { role: 'assistant', text: 'hi' })
    const r = feedReaction(d, {
      chatId: 100, messageId: 42, emoji: '❤️', action: 'add', reacterId: 7,
    })
    expect(r.kind).toBe('persisted_only')
    if (r.kind === 'persisted_only') expect(r.reason).toBe('emoji_not_in_allowlist')
    d.sched.flushAll()
    expect(d.dispatched.length).toBe(0)
  })

  it('👎 on a USER-authored message dispatches NOTHING (no trigger)', () => {
    const d = makeDriver()
    d.history.set(42, { role: 'user', text: 'something the user said' })
    const r = feedReaction(d, {
      chatId: 100, messageId: 42, emoji: '👎', action: 'add', reacterId: 7,
    })
    expect(r.kind).toBe('persisted_only')
    if (r.kind === 'persisted_only') expect(r.reason).toBe('not_bot_authored')
    d.sched.flushAll()
    expect(d.dispatched.length).toBe(0)
  })

  it('two qualifying reactions within window collapse into one batched synthetic', () => {
    const d = makeDriver()
    d.history.set(42, { role: 'assistant', text: 'first bot msg' })
    d.history.set(43, { role: 'assistant', text: 'second bot msg' })
    feedReaction(d, { chatId: 100, messageId: 42, emoji: '👎', action: 'add', reacterId: 7 })
    feedReaction(d, { chatId: 100, messageId: 43, emoji: '✅', action: 'add', reacterId: 7 })
    d.sched.flushAll()
    expect(d.dispatched.length).toBe(1)
    const out = d.dispatched[0]!
    expect(out.meta.batched).toBe('true')
    expect(out.meta.count).toBe('2')
    // Inline list includes both target msg ids.
    expect(out.text).toContain('on msg 42')
    expect(out.text).toContain('on msg 43')
  })

  it('hour cap refuses past the limit (no inbound emitted)', () => {
    const d = makeDriver({ perHourCap: 2, debounceMs: 100 })
    d.history.set(42, { role: 'assistant', text: 'hi' })
    // Three back-to-back, each in its own debounce window.
    for (let i = 0; i < 3; i++) {
      const r = feedReaction(d, {
        chatId: 100, messageId: 42, emoji: '👎', action: 'add', reacterId: 7,
      })
      if (i < 2) expect(r.kind).toBe('enqueued')
      else {
        expect(r.kind).toBe('persisted_only')
        if (r.kind === 'persisted_only') expect(r.reason).toBe('hour_cap_exhausted')
      }
      // Drain so each enqueue gets its own debounce flush.
      d.sched.flushAll()
    }
    expect(d.dispatched.length).toBe(2)
  })

  it('group reaction by non-admin dispatches NOTHING (fail-closed)', () => {
    const d = makeDriver()
    d.history.set(42, { role: 'assistant', text: 'group bot msg' })
    // Negative chat_id → group; admins set is empty.
    const r = feedReaction(d, {
      chatId: -1001234, messageId: 42, emoji: '👎', action: 'add', reacterId: 7,
    })
    expect(r.kind).toBe('persisted_only')
    if (r.kind === 'persisted_only') expect(r.reason).toBe('group_non_admin')
    d.sched.flushAll()
    expect(d.dispatched.length).toBe(0)
  })

  it('group reaction by admin dispatches normally', () => {
    const d = makeDriver()
    d.admins.add(7)
    d.history.set(42, { role: 'assistant', text: 'group bot msg' })
    const r = feedReaction(d, {
      chatId: -1001234, messageId: 42, emoji: '👎', action: 'add', reacterId: 7,
    })
    expect(r.kind).toBe('enqueued')
    d.sched.flushAll()
    expect(d.dispatched.length).toBe(1)
  })

  it('group reaction with group_admin_only=false ignores admin status', () => {
    const d = makeDriver({ groupAdminOnly: false })
    d.history.set(42, { role: 'assistant', text: 'group bot msg' })
    const r = feedReaction(d, {
      chatId: -1001234, messageId: 42, emoji: '👎', action: 'add', reacterId: 7,
    })
    expect(r.kind).toBe('enqueued')
    d.sched.flushAll()
    expect(d.dispatched.length).toBe(1)
  })

  it('reaction-remove (old: [👎], new: []) is persistence-only (action=remove)', () => {
    const d = makeDriver()
    d.history.set(42, { role: 'assistant', text: 'hi' })
    // action=remove is filtered out before predicate evaluation.
    const r = feedReaction(d, {
      chatId: 100, messageId: 42, emoji: null, action: 'remove', reacterId: 7,
    })
    expect(r.kind).toBe('persisted_only')
    d.sched.flushAll()
    expect(d.dispatched.length).toBe(0)
  })

  it('reaction on a message not in history (no row) fails closed — no trigger', () => {
    const d = makeDriver()
    // No history entry for 42 — bot-authored is unknown.
    const r = feedReaction(d, {
      chatId: 100, messageId: 42, emoji: '👎', action: 'add', reacterId: 7,
    })
    expect(r.kind).toBe('persisted_only')
    if (r.kind === 'persisted_only') expect(r.reason).toBe('not_bot_authored')
    d.sched.flushAll()
    expect(d.dispatched.length).toBe(0)
  })

  it('enabled=false dispatches NOTHING even on default allowlist match', () => {
    const d = makeDriver({ enabled: false })
    d.history.set(42, { role: 'assistant', text: 'hi' })
    const r = feedReaction(d, {
      chatId: 100, messageId: 42, emoji: '👎', action: 'add', reacterId: 7,
    })
    expect(r.kind).toBe('persisted_only')
    if (r.kind === 'persisted_only') expect(r.reason).toBe('disabled')
    d.sched.flushAll()
    expect(d.dispatched.length).toBe(0)
  })

  it('cascade: trigger_emojis: [] disables triggering without flipping enabled', () => {
    // Operator narrows to empty allowlist — every qualifying emoji is
    // now a miss. This is the "kill switch without bigger hammer" case.
    const cfg = resolveReactionsConfig({ trigger_emojis: [] })
    const d = makeDriver(cfg)
    d.history.set(42, { role: 'assistant', text: 'hi' })
    const r = feedReaction(d, {
      chatId: 100, messageId: 42, emoji: '👎', action: 'add', reacterId: 7,
    })
    expect(r.kind).toBe('persisted_only')
    if (r.kind === 'persisted_only') expect(r.reason).toBe('emoji_not_in_allowlist')
    d.sched.flushAll()
    expect(d.dispatched.length).toBe(0)
  })
})
