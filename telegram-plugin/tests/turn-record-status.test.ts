import { describe, expect, it } from 'vitest'

import {
  computeTurnStatus,
  computeTurnRoute,
  backstopSendOutcome,
  finalizeBackstopSend,
  buildTurnRecord,
  type DeliveryOutcome,
} from '../gateway/turn-record-status.js'

/**
 * PR B — send-honesty. The turns.jsonl `status` must reflect the REAL send
 * outcome, not the speculative `finalAnswerDelivered` flag the turn-flush
 * backstop sets before its async send runs.
 *
 * These assert the recorded status OUTCOME for each turn shape — the exact
 * string `emitTurnRecord` writes — not merely that a code path ran.
 */

describe('computeTurnStatus — recorded turn status reflects real outcome', () => {
  it('genuine no-reply turn → no_reply', () => {
    expect(computeTurnStatus({ finalAnswerDelivered: false })).toBe('no_reply')
  })

  it('synchronous reply-tool delivery (no deliveryOutcome) → complete', () => {
    expect(computeTurnStatus({ finalAnswerDelivered: true })).toBe('complete')
  })

  it('reply-tool short-circuit suppressed the flush → complete (reply delivered)', () => {
    expect(
      computeTurnStatus({ finalAnswerDelivered: true, deliveryOutcome: 'suppressed' }),
    ).toBe('complete')
  })

  it('fail-safe: undefined outcome + finalAnswerDelivered false never fabricates complete', () => {
    expect(computeTurnStatus({ finalAnswerDelivered: false, deliveryOutcome: undefined })).toBe(
      'no_reply',
    )
  })
})

/**
 * PR "turn-honesty" — the recorded `route` is the deterministic signal the
 * fleet-health detector uses to split a backstop-recovered turn ('flush') from
 * a genuine silent no-op ('none'). It is derived from the SAME resolved
 * delivery state as status, never a speculative pre-send flag.
 */
describe('computeTurnRoute — recorded delivery route reflects real outcome', () => {
  it("backstop delivered → 'flush'", () => {
    expect(
      computeTurnRoute({ finalAnswerDelivered: true, deliveryOutcome: 'delivered' }),
    ).toBe('flush')
  })

  it("backstop send failed → 'none' (nothing reached the user)", () => {
    expect(
      computeTurnRoute({ finalAnswerDelivered: false, deliveryOutcome: 'failed' }),
    ).toBe('none')
  })

  it("reply tool short-circuited the flush → 'reply'", () => {
    expect(
      computeTurnRoute({ finalAnswerDelivered: true, deliveryOutcome: 'suppressed' }),
    ).toBe('reply')
  })

  it("synchronous reply-tool tail (no outcome) → 'reply'", () => {
    expect(computeTurnRoute({ finalAnswerDelivered: true })).toBe('reply')
  })

  it("stream finalized as the answer (tools:0, no reply tool) → 'stream'", () => {
    expect(
      computeTurnRoute({ finalAnswerDelivered: true, deliveredViaStream: true }),
    ).toBe('stream')
  })

  it("genuine no-reply turn → 'none'", () => {
    expect(computeTurnRoute({ finalAnswerDelivered: false })).toBe('none')
  })
})

describe('backstopSendOutcome — resolve outcome from what happened on the wire', () => {
  it('throw → failed', () => {
    expect(backstopSendOutcome({ threw: true, sentCount: 0, chunkCount: 1 })).toBe('failed')
  })

  it('partial (no throw, short delivery) → failed', () => {
    expect(backstopSendOutcome({ threw: false, sentCount: 1, chunkCount: 2 })).toBe('failed')
  })

  it('full delivery → delivered', () => {
    expect(backstopSendOutcome({ threw: false, sentCount: 3, chunkCount: 3 })).toBe('delivered')
  })

  it('Fix 5 — empty split (0 chunks, no throw) → failed, not delivered', () => {
    expect(backstopSendOutcome({ threw: false, sentCount: 0, chunkCount: 0 })).toBe('failed')
  })
})

/**
 * Fix 3 — WIRING integration. These drive the SAME seams the gateway
 * turn-flush IIFE runs — `finalizeBackstopSend` (the stamp) feeding
 * `buildTurnRecord` (which `emitTurnRecord` serializes verbatim) — and assert
 * the RECORDED status string. If the accounting stamps the wrong branch, or the
 * record builder ever reverted to the speculative `finalAnswerDelivered`
 * ternary, these fail — not just if the pure predicate is wrong.
 */
describe('turn-flush wiring → recorded turns.jsonl status', () => {
  const ENDED_AT = 1_700_000_500_000
  const mkTurn = () => ({
    agent: 'test-agent',
    startedAt: ENDED_AT - 5_000,
    toolCallCount: 0,
    turnId: 'turn-abc',
    // speculatively set at gateway.ts flush site BEFORE the send runs:
    finalAnswerDelivered: true,
    deliveryOutcome: undefined as DeliveryOutcome | undefined,
  })

  const recordAfterSend = (send: { threw: boolean; sentCount: number; chunkCount: number }) => {
    const turn = mkTurn()
    finalizeBackstopSend(turn, send) // mutates turn.deliveryOutcome — as the IIFE does
    return buildTurnRecord(turn, ENDED_AT)
  }

  it('send SUCCEEDS (all chunks delivered) → complete', () => {
    expect(recordAfterSend({ threw: false, sentCount: 2, chunkCount: 2 }).status).toBe('complete')
  })

  it("turn-honesty — a delivered backstop send records route 'flush'", () => {
    // The wired record the fleet-health detector reads: a complete + tools:0
    // turn the backstop delivered carries route 'flush' → flush-recovered, not
    // a silent no-op. Pre-PR this field did not exist.
    const rec = recordAfterSend({ threw: false, sentCount: 2, chunkCount: 2 })
    expect(rec.route).toBe('flush')
  })

  it("turn-honesty — a failed backstop send records route 'none'", () => {
    const rec = recordAfterSend({ threw: true, sentCount: 0, chunkCount: 1 })
    expect(rec.route).toBe('none')
    expect(rec.status).toBe('send_failed')
  })

  it('send THROWS (simulated FLOOD_WAIT_ACTIVE) → send_failed, never complete', () => {
    // BUG ORACLE: pre-fix, `finalAnswerDelivered=true` was written BEFORE the
    // send ran and the record read that flag → 'complete' even though the send
    // threw and the user got nothing. Assert the wired outcome is honest.
    const rec = recordAfterSend({ threw: true, sentCount: 0, chunkCount: 1 })
    expect(rec.status).toBe('send_failed')
    expect(rec.status).not.toBe('complete')
  })

  it('PARTIAL multi-chunk (chunk 1 ok, chunk 2 throws) → send_failed', () => {
    expect(recordAfterSend({ threw: true, sentCount: 1, chunkCount: 3 }).status).toBe('send_failed')
  })

  it('reply-tool suppressed the flush → complete (reply delivered), via the stamp', () => {
    const turn = mkTurn()
    turn.deliveryOutcome = 'suppressed' // the IIFE's suppressed-branch stamp
    expect(buildTurnRecord(turn, ENDED_AT).status).toBe('complete')
  })

  it('record carries the honest tuple (tools + duration) alongside status', () => {
    const rec = recordAfterSend({ threw: true, sentCount: 0, chunkCount: 1 })
    expect(rec).toMatchObject({
      status: 'send_failed',
      tools: 0,
      duration_ms: 5_000,
      turn_id: 'turn-abc',
      agent: 'test-agent',
    })
  })
})
