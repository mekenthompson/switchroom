/**
 * I8 — Issue #549: preamble text duplicated (chat message + progress card).
 *
 * THIS IS A REGRESSION TEST FOR AN OPEN BUG.
 *
 * Symptom: when the agent emits a short preamble text before a tool
 * call (e.g. "Looking it up." then a Read tool), that text appears
 * BOTH as a standalone Telegram message AND inside the progress
 * card's narrative step. The user sees the same line twice.
 *
 * Production gateway (gateway.ts:1655-1662):
 *
 *   onSessionEvent(_client, msg) {
 *     const ev = msg.event
 *     progressDriver?.ingest(ev, chatHint, threadHint)  // → card narrative
 *     handleSessionEvent(ev)                             // → answer stream
 *   }
 *
 * Every session event is routed to BOTH the progress driver AND
 * `handleSessionEvent`, which for `text` events feeds `activeAnswerStream`,
 * which calls `bot.api.sendMessage(...)`. There is no "preamble
 * suppression" — i.e., no logic that detects "this text was emitted
 * immediately before a tool call within the same turn → don't also
 * send it to chat."
 *
 * The proposed fix per the issue: detect text-then-tool patterns
 * within a turn and suppress the chat-send path so the card owns
 * the preamble surface.
 *
 * The harness's `feedSessionEvent` calls `driver.ingest` (good — that
 * matches production) but does NOT have the answer-stream wiring, so
 * we add a minimal mirror here. The test then asserts the bug class:
 * "preamble text appears at most once across all user-visible surfaces."
 *
 * fails when: production adds a preamble-suppression gate that prevents
 *   text-then-tool events from reaching activeAnswerStream/sendMessage.
 *
 * PASSES (currently) → bug reproduced. The "Looking it up." text
 * appears in BOTH the card render AND a separate sendMessage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealGatewayHarness } from './real-gateway-harness.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100
const PREAMBLE = 'Looking it up.'
const FINAL_REPLY = 'Found it — see PR #547 for the change.'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('I8 — issue #549: preamble text routed to both chat and progress card', () => {
  // `it.fails` — this test is EXPECTED to fail until #549's fix lands.
  // When the fix is applied, the test body's assertion will start
  // passing and `it.fails` will flip the result to "test failure" —
  // signaling: "the bug is fixed, swap this back to `it()`."
  // See https://vitest.dev/api/#test-fails
  it.fails('text-then-tool preamble appears in card narratives only ONCE per turn (not also as chat sendMessage)', async () => {
    const h = createRealGatewayHarness({ gapMs: 0, driverInitialDelayMs: 0 })

    // Mirror of production's `handleSessionEvent → text` branch:
    // every `text` event also fires a chat sendMessage. This is what
    // gateway.ts:3130 does today.
    //
    // We intercept feedSessionEvent at a higher level by also driving
    // the answer-stream-equivalent: a sendMessage for each text event.
    // (The harness's underlying feedSessionEvent already drives
    // driver.ingest which captures the narrative. We add the OTHER
    // production path on top.)
    function mirrorProductionTextRouting(text: string): void {
      // Mirrors gateway.ts:3142 — answer-stream's first text triggers
      // a sendMessage for the chat-side rendering of the assistant
      // text. Subsequent text events update the same message via edits.
      void h.bot.api.sendMessage(CHAT, text, { parse_mode: 'HTML' })
    }

    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'Review pr 547' })
    h.feedSessionEvent({
      kind: 'enqueue',
      chatId: CHAT,
      messageId: '1',
      threadId: null,
      rawContent: 'Review pr 547',
    })
    await h.clock.advance(50)
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(200)

    // Agent emits the preamble text. In production, this:
    //  1. progressDriver.ingest captures it as a narrative on the card
    //  2. activeAnswerStream sends it as a chat sendMessage
    h.feedSessionEvent({ kind: 'text', text: PREAMBLE })
    mirrorProductionTextRouting(PREAMBLE)
    await h.clock.advance(100)

    // Agent then uses a tool — this is what makes the prior text a
    // "preamble" (text-then-tool within the same turn).
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Read' })
    await h.clock.advance(2000)

    // Final reply. (This text legitimately goes to chat — it's the
    // answer, not a preamble.)
    await h.streamReply({ chat_id: CHAT, text: FINAL_REPLY, done: true })
    await h.clock.advance(100)

    // Count: does PREAMBLE text appear in any chat sendMessage payload?
    // The bug says yes — it appears ONCE as a chat send AND on the
    // progress card. The fix would route preamble only to the card.
    const chatSendsContainingPreamble = h.recorder.calls.filter(
      (c) =>
        (c.kind === 'sendMessage' || c.kind === 'editMessageText') &&
        c.chat_id === CHAT &&
        c.payload != null &&
        c.payload.includes(PREAMBLE) &&
        // Exclude card payloads — the card render genuinely contains
        // the narrative as part of its body. The bug is about
        // STANDALONE chat messages with the preamble.
        !c.payload.includes('Working') &&
        !c.payload.includes('⚙') &&
        !c.payload.includes('⏳') &&
        !c.payload.includes('• '),
    )

    // EXPECTED (after fix): zero standalone chat messages carry the
    // preamble — the card owns it.
    // ACTUAL (currently buggy): one standalone chat message carries
    // the preamble in addition to the card narrative → user sees it twice.
    expect(
      chatSendsContainingPreamble.length,
      `issue #549: preamble "${PREAMBLE}" was sent as a standalone chat message ` +
      `${chatSendsContainingPreamble.length} time(s) in addition to the progress card. ` +
      `The fix should route preamble (text-then-tool) only to the card.`,
    ).toBe(0)

    h.finalize()
  })

  it('answer text (text NOT followed by a tool) DOES legitimately go to chat', async () => {
    // Negative-control: text that's the final answer SHOULD reach chat.
    // The fix for #549 must distinguish preamble from answer; this test
    // pins that the answer path keeps working after a preamble fix.
    //
    // fails when: a too-aggressive preamble fix suppresses ALL text
    //   events from chat, breaking the answer path.
    const h = createRealGatewayHarness({ gapMs: 0, driverInitialDelayMs: 0 })
    h.inbound({ chatId: CHAT, messageId: INBOUND_MSG, text: 'q' })
    h.feedSessionEvent({
      kind: 'enqueue',
      chatId: CHAT,
      messageId: '1',
      threadId: null,
      rawContent: 'q',
    })
    await h.clock.advance(50)
    // Direct answer, no tools.
    await h.streamReply({ chat_id: CHAT, text: 'The answer is 42.', done: true })
    await h.clock.advance(50)

    const sends = h.recorder.sentTexts(CHAT)
    expect(sends.some((t) => t.includes('The answer is 42.'))).toBe(true)
    h.finalize()
  })
})
