/**
 * Reaction-sequence scenario — driver DMs the test bot, bot reacts
 * to the inbound message with the gateway's status emoji sequence.
 *
 * Part of: https://github.com/switchroom/switchroom/issues/866
 *
 * The gateway emits reactions in order via `setMessageReaction`,
 * which REPLACES the prior emoji on each call. For fast turns
 * (< the progress-card `initialDelayMs` of 45s), intermediate
 * reactions may collapse — typically the terminal `👍` is what
 * lands. This scenario only asserts on the terminal emoji because
 * that's the one observable in fast-turn DMs without artificial
 * delay; the full 👀→🤔→🔥→👍 sequence is a Phase 2c target
 * with a long-turn scenario.
 *
 * Requires the same env as `smoke-dm-reply.test.ts` (see
 * `uat/SETUP.md` §6).
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

const INBOUND = `uat-reactions ${new Date().toISOString()}`;

// SKIPPED: this scenario depends on the gateway's "fast-turn"
// path that emits status-emoji reactions on the inbound. When
// the progress card is active (test-harness now sets
// `progress_card.delay_ms: 1000` so the card-lifecycle scenario
// can fire — see SETUP.md §5 and `progress-card-dm.test.ts`), the
// gateway renders the card INSTEAD of reactions, not in addition.
//
// Two-agent split (a `test-harness-fast` with default delay_ms +
// the existing `test-harness` for card scenarios) would let both
// be green at the same time. Tracked for Phase 2e.
describe.skip("uat: bot reacts to driver DM with terminal status emoji", () => {
  it("driver sees 👍 (done) appear on its inbound within 90s", async () => {
    const sc = await spinUp({ agent: "test-harness" });
    try {
      const sent = await sc.sendDM(INBOUND);
      const trail = await sc.expectReaction(
        sent.messageId,
        ["👍"],
        { timeout: 90_000 },
      );
      // The trail captures everything observed; surface the last add
      // so a failure dump shows the actual emoji set.
      const lastAdd = [...trail].reverse().find((t) => t.op === "+");
      expect(lastAdd?.emoji).toBe("👍");
    } finally {
      await sc.tearDown();
    }
  });
});
