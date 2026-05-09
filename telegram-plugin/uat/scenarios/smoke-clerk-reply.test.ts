/**
 * Smoke scenario — clerk replies to a simple text message.
 *
 * Part of: https://github.com/switchroom/switchroom/issues/866
 *
 * Phase 1 status: this file exercises the harness shape (typecheck-
 * clean, reads as the canonical example) but will FAIL at runtime
 * because `harness.spinUp` is stubbed. Phase 2 wires the real
 * lifecycle and this becomes the first green UAT scenario.
 *
 * The shape mirrors the canonical scenario in epic #863 so reviewers
 * can map directly between the design doc and the code.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

describe("uat: clerk smoke", () => {
  it("replies to a text message with the right reaction sequence + HTML reply", async () => {
    const sc = await spinUp({ agent: "clerk", topic: "smoke-clerk-reply" });

    try {
      const sent = await sc.driver.sendText(
        sc.chatId,
        "summarize this short note",
        { messageThreadId: sc.threadId },
      );

      // Status reactions should walk 👀 → 🤔 → 🔥 → 👍 on the inbound
      // message within 30s on a healthy run.
      await sc.expectReaction(
        sent.messageId,
        ["👀", "🤔", "🔥", "👍"],
        { timeout: 30_000 },
      );

      // The progress card should be pinned within a few seconds.
      const card = await sc.expectPinnedCard({ timeout: 5_000 });

      // And ride to `done` within the model's normal turn budget.
      const finalCard = await sc.waitForCardPhase(card, "done", {
        timeout: 60_000,
      });
      expect(finalCard.text).toMatch(/Done|✅/);

      // The actual reply prose lands as a fresh bot message, in HTML.
      const reply = await sc.expectMessage(/./, {
        from: "bot",
        timeout: 60_000,
      });
      // Reviewer note: parse_mode isn't on the wire-level update;
      // we proxy via "did the rendered HTML contain a `<` we
      // recognize, or did markdown leak as plain `*`?". Phase 2
      // will pick the right shape — left as a TODO so this file
      // typechecks today.
      expect(reply.text.length).toBeGreaterThan(0);
    } finally {
      await sc.tearDown();
    }
  });
});
