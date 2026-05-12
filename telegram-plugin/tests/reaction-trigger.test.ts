/**
 * Unit tests for the reaction-trigger primitives (#1074).
 *
 * Covers the synchronous predicate, the per-chat hour cap, the
 * debounce buffer's single/collapse/batch behaviours, and the inbound
 * text/meta builders. The integration test that exercises the full
 * gateway handler lives in `reaction-trigger.gateway.test.ts`.
 */

import { describe, it, expect } from 'bun:test'
import {
  BATCH_INLINE_LIMIT,
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

// Helper — minimal candidate factory.
function candidate(
  over: Partial<Parameters<typeof evaluateTriggerCandidate>[1]> = {},
): Parameters<typeof evaluateTriggerCandidate>[1] {
  return {
    chatId: 123,
    messageId: 42,
    emoji: '👎',
    action: 'add',
    botAuthored: true,
    ...over,
  }
}

const FULL_CFG: ReactionsResolvedConfig = REACTIONS_DEFAULTS

describe('resolveReactionsConfig', () => {
  it('returns built-in defaults for undefined / null input', () => {
    expect(resolveReactionsConfig(undefined)).toBe(REACTIONS_DEFAULTS)
    expect(resolveReactionsConfig(null)).toBe(REACTIONS_DEFAULTS)
  })

  it('falls through to defaults for missing fields', () => {
    const r = resolveReactionsConfig({ debounce_ms: 5000 })
    expect(r.debounceMs).toBe(5000)
    expect(r.enabled).toBe(REACTIONS_DEFAULTS.enabled)
    expect(r.perHourCap).toBe(REACTIONS_DEFAULTS.perHourCap)
    expect(r.triggerEmojis).toBe(REACTIONS_DEFAULTS.triggerEmojis)
  })

  it('REPLACES trigger_emojis (not unions)', () => {
    const r = resolveReactionsConfig({ trigger_emojis: ['🔥'] })
    expect([...r.triggerEmojis]).toEqual(['🔥'])
    // 👎 (a default) should NOT be present.
    expect(r.triggerEmojis.has('👎')).toBe(false)
  })

  it('supports trigger_emojis: [] as the empty allowlist', () => {
    const r = resolveReactionsConfig({ trigger_emojis: [] })
    expect(r.triggerEmojis.size).toBe(0)
  })

  it('defaults match the locked design (Ken approved 2026-05-12)', () => {
    expect(REACTIONS_DEFAULTS.enabled).toBe(true)
    expect(REACTIONS_DEFAULTS.debounceMs).toBe(30_000)
    expect(REACTIONS_DEFAULTS.perHourCap).toBe(10)
    expect(REACTIONS_DEFAULTS.groupAdminOnly).toBe(true)
    expect([...REACTIONS_DEFAULTS.triggerEmojis].sort()).toEqual(
      ['👍', '👎', '✅', '❌'].sort(),
    )
  })
})

describe('evaluateTriggerCandidate', () => {
  it('accepts a bot-authored 👎 (default allowlist)', () => {
    expect(evaluateTriggerCandidate(FULL_CFG, candidate())).toEqual({ ok: true })
  })

  it('rejects when enabled=false (master switch)', () => {
    const cfg = resolveReactionsConfig({ enabled: false })
    expect(evaluateTriggerCandidate(cfg, candidate())).toEqual({
      ok: false,
      reason: 'disabled',
    })
  })

  it('rejects reactions on user-authored messages (no trigger)', () => {
    expect(evaluateTriggerCandidate(FULL_CFG, candidate({ botAuthored: false }))).toEqual({
      ok: false,
      reason: 'not_bot_authored',
    })
  })

  it('rejects emoji not in the allowlist (e.g. ❤️ on a bot reply)', () => {
    expect(evaluateTriggerCandidate(FULL_CFG, candidate({ emoji: '❤️' }))).toEqual({
      ok: false,
      reason: 'emoji_not_in_allowlist',
    })
  })

  it('rejects null emoji (custom emoji / non-emoji reaction)', () => {
    expect(evaluateTriggerCandidate(FULL_CFG, candidate({ emoji: null }))).toEqual({
      ok: false,
      reason: 'no_emoji',
    })
  })

  it('accepts each default-allowlist emoji', () => {
    for (const e of ['👎', '❌', '👍', '✅']) {
      expect(evaluateTriggerCandidate(FULL_CFG, candidate({ emoji: e }))).toEqual({
        ok: true,
      })
    }
  })

  it('narrowed allowlist rejects previously-accepted emojis', () => {
    const cfg = resolveReactionsConfig({ trigger_emojis: ['👎'] })
    expect(evaluateTriggerCandidate(cfg, candidate({ emoji: '👍' }))).toEqual({
      ok: false,
      reason: 'emoji_not_in_allowlist',
    })
    expect(evaluateTriggerCandidate(cfg, candidate({ emoji: '👎' }))).toEqual({
      ok: true,
    })
  })

  it('empty-allowlist effectively disables triggering without enabled=false', () => {
    const cfg = resolveReactionsConfig({ trigger_emojis: [] })
    expect(evaluateTriggerCandidate(cfg, candidate({ emoji: '👎' }))).toEqual({
      ok: false,
      reason: 'emoji_not_in_allowlist',
    })
  })
})

describe('isGroupChat', () => {
  it('treats negative chat ids as groups (Bot API convention)', () => {
    expect(isGroupChat(-100123)).toBe(true)
    expect(isGroupChat(-1)).toBe(true)
  })
  it('treats positive chat ids as DMs', () => {
    expect(isGroupChat(987654)).toBe(false)
    expect(isGroupChat(1)).toBe(false)
  })
})

describe('HourCap', () => {
  it('admits up to `cap` events then refuses, scoped per chat', () => {
    const cap = new HourCap(3)
    expect(cap.tryConsume('A')).toBe(true)
    expect(cap.tryConsume('A')).toBe(true)
    expect(cap.tryConsume('A')).toBe(true)
    expect(cap.tryConsume('A')).toBe(false)
    expect(cap.tryConsume('A')).toBe(false)
    // Different chat — independent budget.
    expect(cap.tryConsume('B')).toBe(true)
  })

  it('cap=0 always refuses', () => {
    const cap = new HourCap(0)
    expect(cap.tryConsume('A')).toBe(false)
    expect(cap.tryConsume('A')).toBe(false)
  })

  it('rolls forward after the 1-hour window passes', () => {
    let now = 1_000_000
    const cap = new HourCap(2, () => now)
    expect(cap.tryConsume('A')).toBe(true)
    expect(cap.tryConsume('A')).toBe(true)
    expect(cap.tryConsume('A')).toBe(false)
    // Roll past the hour window.
    now += 60 * 60 * 1000 + 1
    expect(cap.tryConsume('A')).toBe(true)
    expect(cap.tryConsume('A')).toBe(true)
    expect(cap.tryConsume('A')).toBe(false)
  })

  it('reports a trailing-hour count via size()', () => {
    let now = 0
    const cap = new HourCap(5, () => now)
    cap.tryConsume('A')
    cap.tryConsume('A')
    expect(cap.size('A')).toBe(2)
    now += 60 * 60 * 1000 + 1
    expect(cap.size('A')).toBe(0)
  })
})

describe('DebounceBuffer', () => {
  // Fake scheduler — exposes timers so the test drives the clock.
  function makeScheduler(): {
    schedule: (fn: () => void, ms: number) => { id: number; fn: () => void; ms: number }
    cancel: (h: { id: number }) => void
    flushAll: () => void
    pending: { id: number; fn: () => void; ms: number }[]
    nextId: number
  } {
    let nextId = 1
    const pending: { id: number; fn: () => void; ms: number }[] = []
    return {
      schedule(fn: () => void, ms: number) {
        const h = { id: nextId++, fn, ms }
        pending.push(h)
        return h
      },
      cancel(h: { id: number }) {
        const i = pending.findIndex((p) => p.id === h.id)
        if (i >= 0) pending.splice(i, 1)
      },
      flushAll() {
        // Snapshot then drain — running fn() may enqueue more.
        const snap = pending.splice(0)
        for (const p of snap) p.fn()
      },
      pending,
      nextId,
    }
  }

  function pending(over: Partial<PendingReaction> = {}): PendingReaction {
    return {
      targetMessageId: 7,
      emoji: '👎',
      action: 'add',
      ts: 0,
      preview: 'hello',
      userId: 99,
      user: 'tester',
      ...over,
    }
  }

  it('single enqueue fires the sink with batched=false after window', () => {
    const sched = makeScheduler()
    const batches: ReactionBatch[] = []
    const buf = new DebounceBuffer(30_000, (b) => batches.push(b), {
      schedule: sched.schedule as never,
      cancel: sched.cancel as never,
    })
    buf.enqueue(123, pending({ emoji: '👎', targetMessageId: 1 }))
    expect(batches.length).toBe(0)
    sched.flushAll()
    expect(batches.length).toBe(1)
    expect(batches[0]!.batched).toBe(false)
    expect(batches[0]!.reactions.length).toBe(1)
    expect(batches[0]!.reactions[0]!.emoji).toBe('👎')
  })

  it('two enqueues within window collapse into batched=true with 2 entries', () => {
    const sched = makeScheduler()
    const batches: ReactionBatch[] = []
    const buf = new DebounceBuffer(30_000, (b) => batches.push(b), {
      schedule: sched.schedule as never,
      cancel: sched.cancel as never,
    })
    buf.enqueue(123, pending({ emoji: '👎', targetMessageId: 1 }))
    buf.enqueue(123, pending({ emoji: '✅', targetMessageId: 2 }))
    expect(batches.length).toBe(0)
    sched.flushAll()
    expect(batches.length).toBe(1)
    expect(batches[0]!.batched).toBe(true)
    expect(batches[0]!.reactions.length).toBe(2)
  })

  it('separate chats do not collapse into each other', () => {
    const sched = makeScheduler()
    const batches: ReactionBatch[] = []
    const buf = new DebounceBuffer(30_000, (b) => batches.push(b), {
      schedule: sched.schedule as never,
      cancel: sched.cancel as never,
    })
    buf.enqueue(123, pending({ targetMessageId: 1 }))
    buf.enqueue(456, pending({ targetMessageId: 2 }))
    sched.flushAll()
    expect(batches.length).toBe(2)
    expect(batches.map((b) => b.chatId).sort()).toEqual([123, 456])
  })

  it('manual flush() before timer is a no-op double-flush', () => {
    const sched = makeScheduler()
    const batches: ReactionBatch[] = []
    const buf = new DebounceBuffer(30_000, (b) => batches.push(b), {
      schedule: sched.schedule as never,
      cancel: sched.cancel as never,
    })
    buf.enqueue(123, pending())
    buf.flush(123)
    expect(batches.length).toBe(1)
    // No pending timer is left to fire.
    sched.flushAll()
    expect(batches.length).toBe(1)
  })

  it('caps unbounded growth — extra entries past maxPending are dropped', () => {
    const sched = makeScheduler()
    const batches: ReactionBatch[] = []
    const buf = new DebounceBuffer(
      30_000,
      (b) => batches.push(b),
      {
        schedule: sched.schedule as never,
        cancel: sched.cancel as never,
        maxPending: 3,
      },
    )
    for (let i = 0; i < 10; i++) buf.enqueue(123, pending({ targetMessageId: i }))
    sched.flushAll()
    expect(batches.length).toBe(1)
    expect(batches[0]!.reactions.length).toBe(3)
  })
})

describe('truncatePreview', () => {
  it('returns "" for null / undefined / ""', () => {
    expect(truncatePreview(null)).toBe('')
    expect(truncatePreview(undefined)).toBe('')
    expect(truncatePreview('')).toBe('')
  })
  it('returns short strings unchanged', () => {
    expect(truncatePreview('hi')).toBe('hi')
  })
  it('truncates with ellipsis past 200 chars', () => {
    const s = 'x'.repeat(500)
    const out = truncatePreview(s)
    expect(out.length).toBe(200)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('buildReactionInboundText / Meta', () => {
  function batchOf(reactions: PendingReaction[]): ReactionBatch {
    return { chatId: 1, reactions, batched: reactions.length > 1 }
  }
  function p(emoji: string, mid: number, preview = 'hi'): PendingReaction {
    return {
      targetMessageId: mid, emoji, action: 'add', ts: 0,
      preview, userId: 1, user: 'u',
    }
  }

  it('single produces a <channel source="reaction"> envelope', () => {
    const text = buildReactionInboundText(batchOf([p('👎', 42, 'the bot said something')]))
    expect(text).toContain('<channel source="reaction"')
    expect(text).toContain('emoji="👎"')
    expect(text).toContain('action="add"')
    expect(text).toContain('target_message_id="42"')
    expect(text).toContain('the bot said something')
    expect(text.endsWith('</channel>')).toBe(true)
  })

  it('single meta carries the discriminators', () => {
    const meta = buildReactionInboundMeta(batchOf([p('👍', 7, 'ok')]))
    expect(meta.source).toBe('reaction')
    expect(meta.batched).toBe('false')
    expect(meta.count).toBe('1')
    expect(meta.reaction_emoji).toBe('👍')
    expect(meta.target_message_id).toBe('7')
    expect(meta.target_message_preview).toBe('ok')
  })

  it('batched lists each reaction inline up to the limit + "+N more"', () => {
    const reactions = Array.from({ length: BATCH_INLINE_LIMIT + 3 }, (_, i) =>
      p('👎', i + 1, `m${i + 1}`),
    )
    const text = buildReactionInboundText(batchOf(reactions))
    expect(text).toContain('batched="true"')
    expect(text).toContain(`count="${reactions.length}"`)
    expect(text).toContain('+3 more')
    // Inline-listed first N entries.
    expect(text).toContain('on msg 1')
    expect(text).toContain(`on msg ${BATCH_INLINE_LIMIT}`)
    // Past-limit entries are NOT inlined (only count is propagated).
    expect(text).not.toContain(`on msg ${BATCH_INLINE_LIMIT + 1}`)
  })

  it('escapes < and > in preview body and emoji attr', () => {
    const text = buildReactionInboundText(
      batchOf([p('👎', 1, '<script>alert(1)</script>')]),
    )
    expect(text).not.toContain('<script>')
    expect(text).toContain('&lt;script&gt;')
  })

  it('persistence path is unchanged — buildReactionInboundText is pure', () => {
    // Smoke check that the function does not throw / mutate inputs.
    const b = batchOf([p('👍', 1)])
    Object.freeze(b)
    Object.freeze(b.reactions)
    expect(() => buildReactionInboundText(b)).not.toThrow()
  })
})
