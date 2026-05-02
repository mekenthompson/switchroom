/**
 * I7 — Issue #542: status reactions skipping intermediates on a LONG
 * multi-tool turn.
 *
 * THIS IS A REGRESSION TEST FOR AN OPEN BUG.
 *
 * Symptom from the original bug report (chat 8248703757, 2026-05-01
 * 14:08 AEST, agent clerk):
 *
 *   "message emoji aren't working, switchroom just thumbs up and
 *    didn't have progress flow as designed"
 *
 * The bug is on a multi-step task (mail skill load → vault patch →
 * search → read → file write → reply — six tool calls, ~30s wall
 * clock). The expected ladder is 👀 → 🤔 → 🔥 (or per-tool emoji) →
 * 👍. The observed behavior is straight 👀 → 👍 with no intermediate
 * states visible to the user.
 *
 * The existing F1 test (`real-gateway-f1-ladder-integrity.test.ts`)
 * covers SHORT turns (sub-debounce, ~500ms). The fix there flushes a
 * pending reaction at terminal time. But #542 is a LONG turn — way
 * past the 700ms debounce — so F1's fix doesn't apply. There's a
 * SEPARATE root cause this test should surface.
 *
 * If this test passes on current main: the harness models the
 * scenario but doesn't reproduce the bug — meaning the bug lives in
 * a layer the harness doesn't cover (probably Telegram server-side
 * dedup of repeat reactions, or the rate-limit retry path eating
 * intermediate setMessageReaction calls). That's still useful: it
 * tells us we need a different probe (real-DC, or instrumentation).
 *
 * If this test FAILS: we've reproduced #542 in-process. Use the
 * failure to find which controller call doesn't land.
 *
 * fails when: production's StatusReactionController.setTool() /
 *   setThinking() doesn't actually invoke bot.api.setMessageReaction
 *   for intermediate states on a long turn, OR when the controller's
 *   state machine collapses to terminal before intermediate emissions
 *   happen.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRealGatewayHarness } from './real-gateway-harness.js'

const CHAT = '8248703757'
const INBOUND_MSG = 100

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function uniqueLadder(seq: string[]): string[] {
  const out: string[] = []
  for (const e of seq) {
    if (out[out.length - 1] !== e) out.push(e)
  }
  return out
}

describe('I7 — issue #542: long multi-tool turn shows intermediate reactions', () => {
  it('a 6-tool ~30s turn produces a ladder with intermediates between 👀 and 👍', async () => {
    // Replays the exact shape from the live bug report:
    //   inbound msg → thinking → 6 tool calls spread across ~30s →
    //   reply → turn_end
    // Each tool runs ~3-5s, well past the 700ms debounce — every
    // intermediate transition has plenty of time to fire.
    const h = createRealGatewayHarness({ gapMs: 0 })
    h.inbound({
      chatId: CHAT,
      messageId: INBOUND_MSG,
      text: 'Grab the email from abs at roller this arvo, file it in the inbox.',
    })
    h.feedSessionEvent({
      kind: 'enqueue',
      chatId: CHAT,
      messageId: '1',
      threadId: null,
      rawContent: 'Grab the email from abs at roller this arvo, file it in the inbox.',
    })
    await h.clock.advance(50)

    // Phase 1: thinking
    h.feedSessionEvent({ kind: 'thinking' })
    await h.clock.advance(800) // > 700ms debounce — 🤔 should fire

    // Phase 2: tool 1 — Skill (load mail skill)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Skill' })
    await h.clock.advance(3000)

    // Phase 3: tool 2 — Bash (vault patch)
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Bash' })
    await h.clock.advance(4000)

    // Phase 4: tool 3 — WebSearch
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'WebSearch' })
    await h.clock.advance(5000)

    // Phase 5: tool 4 — Read
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Read' })
    await h.clock.advance(2000)

    // Phase 6: tool 5 — Write
    h.feedSessionEvent({ kind: 'tool_use', toolName: 'Write' })
    await h.clock.advance(3000)

    // Phase 7: tool 6 — stream_reply (final reply)
    await h.streamReply({
      chat_id: CHAT,
      text: 'Filed the email under inbox/2026-05-01-abs-roller.eml.',
      done: true,
    })
    await h.clock.advance(2000)

    const seq = h.recorder.reactionSequence()
    const ladder = uniqueLadder(seq)

    expect(ladder[0]).toBe('👀')
    expect(ladder[ladder.length - 1]).toBe('👍')
    // The whole point of #542: intermediates MUST be present on a long
    // multi-tool turn. If this is 2 (just 👀 → 👍) the bug has reproduced.
    expect(
      ladder.length,
      `expected at least one intermediate emoji between 👀 and 👍 on a 6-tool ~30s turn (issue #542). full sequence: ${JSON.stringify(seq)}`,
    ).toBeGreaterThanOrEqual(3)

    h.finalize()
  })

})

// ─── INVESTIGATION FINDINGS for #542 ──────────────────────────────────
//
// The harness reproduces a healthy ladder:
//   👀 → 🤔 → ✍ → 👨‍💻 → ⚡ → 👨‍💻 → 👍
// So the StatusReactionController emits the right intermediate states.
//
// The bug therefore lives in a layer the harness DOES NOT model — most
// likely one of:
//
//   1. **Telegram chat-level allowed_reactions filter.** Supergroups
//      and channels can restrict `available_reactions` to a small set
//      (often just 👍 ❤️ 🔥 🎉 😁 🤔 😢 👏). Bots calling
//      setMessageReaction with an emoji outside this set get 400
//      "REACTION_INVALID" — production catches and logs it
//      (status-reactions.ts:278) but does NOT fall back, so the only
//      emoji that lands is whichever happens to be in the allowed set
//      (typically 👍 from setDone).
//
//   2. **Premium emoji.** Some emoji like 👨‍💻 may be premium-only in
//      certain regions or chat types.
//
//   3. **Rapid-fire rate limiting.** Server may dedup or throttle
//      consecutive setMessageReaction calls to the same message.
//
// PRODUCTION GAP: gateway.ts:4384 instantiates StatusReactionController
// WITHOUT passing allowedReactions — even though `getChat` returns
// `available_reactions` for supergroups/channels. The controller's
// fallback logic in resolveEmoji() (status-reactions.ts:283-298) is
// designed to handle this case but is dead code without the wire-up.
//
// PROPOSED FIXES (not implemented here — file a separate bug-fix PR):
//   A. Probe getChat at controller init time, pass `available_reactions`
//      as `allowedReactions` to the constructor. resolveEmoji's
//      existing filter then activates.
//   B. Add fallback-on-emit-failure inside the chain: if emit throws
//      with 400 "REACTION_INVALID", retry with the next variant.
//   C. Keep an in-memory cache of which emojis Telegram has accepted
//      per chat; bias resolveEmoji to known-good emoji.
//
// HARNESS GAP: the fake recorder's setMessageReaction unconditionally
// succeeds. To reproduce #542 in-process, the harness would need to
// model per-chat available_reactions and reject non-allowed emojis.
// That extension belongs in a follow-up — the user can verify the
// hypothesis by checking their bot's chat configuration via
// `getChat(chat_id).available_reactions` in a quick script.
