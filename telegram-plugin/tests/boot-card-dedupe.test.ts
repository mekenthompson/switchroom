/**
 * Unit tests for `shouldSkipDuplicateBootCard` — the helper that prevents
 * the boot path AND the bridge-reconnect path from BOTH posting a boot
 * card on a single gateway lifetime.
 *
 * Regression for the duplicate-post observed in klanker's journal at
 * 2026-04-26 11:19:47, where msgId 2245 was posted by the boot path and
 * msgId 2248 by the bridge-reconnect path within 5 seconds.
 */

import { describe, it, expect } from 'bun:test'
import { shouldSkipDuplicateBootCard } from '../gateway/boot-card.js'

describe('shouldSkipDuplicateBootCard — boot path', () => {
  it('skips on the boot path when bridge-reconnect already posted a card', () => {
    // First-write-wins: when the agent's IPC client connects faster
    // than the gateway IIFE reaches its emit, bridge-reconnect runs
    // first and sets activeBootCard. The boot path must defer.
    // Regression for finn 2026-05-02 duplicate (msgId 673 + 674)
    // — both posted within ~100ms because the boot path was
    // unconditionally allowed past the gate.
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: { messageId: 42 } },
      'boot',
    )
    expect(decision.skip).toBe(true)
    expect(decision.reason).toMatch(/msgId.*42/)
    expect(decision.reason).toMatch(/site=boot/)
  })

  it('skips on the boot path when bridge-reconnect emit is in-flight', () => {
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: null, bootCardPending: true },
      'boot',
    )
    expect(decision.skip).toBe(true)
    expect(decision.reason).toMatch(/in-flight/i)
  })

  it('does not skip on the boot path with no active card and no pending emit', () => {
    const decision = shouldSkipDuplicateBootCard({ activeBootCard: null }, 'boot')
    expect(decision.skip).toBe(false)
  })
})

describe('shouldSkipDuplicateBootCard — bridge-reconnect path', () => {
  it('skips when the boot path already posted (active card present)', () => {
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: { messageId: 2245 } },
      'bridge-reconnect',
    )
    expect(decision.skip).toBe(true)
    expect(decision.reason).toBeDefined()
    expect(decision.reason).toContain('2245')
  })

  it('does not skip when the boot path produced no card', () => {
    // Plausible scenario: boot path skipped due to no chat_id known yet,
    // and bridge-reconnect arrives later with a chat_id from the IPC client.
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: null },
      'bridge-reconnect',
    )
    expect(decision.skip).toBe(false)
  })
})

describe('shouldSkipDuplicateBootCard — reason format', () => {
  it('includes the active messageId in the reason for observability', () => {
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: { messageId: 9999 } },
      'bridge-reconnect',
    )
    expect(decision.skip).toBe(true)
    expect(decision.reason).toMatch(/msgId.*9999/)
  })

  it('omits reason when not skipping', () => {
    const decision = shouldSkipDuplicateBootCard({ activeBootCard: null }, 'boot')
    expect(decision.skip).toBe(false)
    expect(decision.reason).toBeUndefined()
  })

  it('reason carries the site label so dedupe-source is greppable in logs', () => {
    const fromBoot = shouldSkipDuplicateBootCard(
      { activeBootCard: { messageId: 1 } },
      'boot',
    )
    expect(fromBoot.reason).toMatch(/site=boot/)
    const fromReconnect = shouldSkipDuplicateBootCard(
      { activeBootCard: { messageId: 1 } },
      'bridge-reconnect',
    )
    expect(fromReconnect.reason).toMatch(/site=bridge-reconnect/)
  })
})

// ---------------------------------------------------------------------------
// In-flight race window (issue #489)
//
// Before #489, the gate only saw activeBootCard, which is only assigned
// AFTER the boot path's `await startBootCard(...)` resolved. If the agent's
// IPC client connected during that 1–2s sendMessage round-trip,
// onClientRegistered would dedupe-check, see activeBootCard = null, and
// fire its own boot card. Klanker on 2026-05-01 10:13:15 produced msgId
// 4715 + 4716 from the same gateway PID via this race. The bootCardPending
// flag is set synchronously before the await so the dedupe sees in-flight.
// ---------------------------------------------------------------------------

describe('shouldSkipDuplicateBootCard — in-flight (race window, #489)', () => {
  it('skips bridge-reconnect when boot path is still awaiting sendMessage', () => {
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: null, bootCardPending: true },
      'bridge-reconnect',
    )
    expect(decision.skip).toBe(true)
    expect(decision.reason).toMatch(/in-flight/i)
  })

  it('skips bridge-reconnect when both pending and active are set (post-resolution overlap)', () => {
    // A bridge-reconnect can fire after activeBootCard was assigned but
    // before the finally-clears bootCardPending — both true is legal.
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: { messageId: 4715 }, bootCardPending: true },
      'bridge-reconnect',
    )
    expect(decision.skip).toBe(true)
    // In-flight wins because it's checked first; either reason is fine
    // for observability — the card is correctly skipped either way.
    expect(decision.reason).toBeDefined()
  })

  it('skips boot path when bridge-reconnect emit is in-flight (first-write-wins)', () => {
    // The boot path is no longer "primary" — empirical evidence
    // (finn 2026-05-02) shows bridge-reconnect can fire first when
    // the agent IPC-connects before the gateway IIFE reaches its
    // emit. Both sites consult the gate symmetrically.
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: null, bootCardPending: true },
      'boot',
    )
    expect(decision.skip).toBe(true)
  })

  it('treats undefined bootCardPending as "not pending" for backward compat', () => {
    // Callers that pre-date the flag still pass { activeBootCard } only.
    // Their behaviour must not change.
    const decision = shouldSkipDuplicateBootCard(
      { activeBootCard: null },
      'bridge-reconnect',
    )
    expect(decision.skip).toBe(false)
  })
})
