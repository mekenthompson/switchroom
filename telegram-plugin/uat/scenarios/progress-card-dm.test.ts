/**
 * Progress-card lifecycle scenario — driver DMs the test bot, the
 * gateway pins a status card, edits it through phases, and finalizes
 * at "done".
 *
 * Part of: https://github.com/switchroom/switchroom/issues/866
 *
 * **Gated by operator config.** The gateway's
 * `progress_card.delay_ms` defaults to 45 s, so short DM turns
 * (most of UAT) never trigger the pinned card. To unskip this
 * scenario, set the override on `test-harness` in
 * `~/.switchroom/switchroom.yaml`:
 *
 *   test-harness:
 *     channels:
 *       telegram:
 *         progress_card:
 *           delay_ms: 1000
 *
 * Then `switchroom apply && switchroom agent restart test-harness`,
 * and remove the `.skip` below. See `uat/SETUP.md` §5 for the full
 * runbook.
 *
 * Requires the same env as `smoke-dm-reply.test.ts` (see SETUP.md §6).
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const INBOUND = `uat-card ${new Date().toISOString()}`;

describe.skip("uat: progress card lifecycle on driver DM", () => {
  it("driver sees a pinned card progress to 'done' within 60s", async () => {
    const sc = await spinUp({ agent: "test-harness" });
    try {
      await sc.sendDM(INBOUND);

      // Card should be pinned within 5 s of the inbound (delay_ms
      // override has it firing immediately at start-of-turn).
      const card = await sc.expectPinnedCard({ timeout: 10_000 });
      expect(card.messageId).toBeGreaterThan(0);

      // Walk to terminal phase. Fast turns may render straight to
      // "done" — waitForCardPhase's fast-path returns immediately
      // when the input snapshot's text already matches.
      const finalCard = await sc.waitForCardPhase(card, "done", {
        timeout: 60_000,
      });
      expect(finalCard.phase).toBe("done");
      expect(finalCard.text).toMatch(/✅|Done/i);
    } finally {
      await sc.tearDown();
    }
  });
});
