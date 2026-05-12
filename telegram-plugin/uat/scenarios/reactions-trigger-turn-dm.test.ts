/**
 * UAT scenario — driver reacts to a bot DM with a trigger emoji and
 * observes the agent process a synthetic inbound turn (#1074).
 *
 * Flow:
 *   1. Driver sends a DM that will provoke a bot reply.
 *   2. Bot replies — driver observes the reply message id.
 *   3. Driver places a 👎 reaction on the bot's reply.
 *   4. Assert: the agent emits a subsequent action (another outbound
 *      message). The reaction-trigger pipeline synthesizes a new
 *      `<channel source="reaction">` inbound turn, which the agent's
 *      Claude session treats as a normal turn and (per profile
 *      guidance) acknowledges or course-corrects.
 *
 *   Negative:
 *     - Driver also places a ❤️ reaction (not in the default
 *       allowlist) on a separate bot message.
 *     - Assert: NO new agent action within the negative-budget window.
 *
 * Requires the same env as `smoke-dm-reply.test.ts` — see
 * `uat/SETUP.md` §6.
 *
 * NOTE: this scenario depends on the test-harness agent having the
 * default `reactions:` config (allowlist includes 👎). If an operator
 * has narrowed the allowlist this case will fail-with-message.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

const TRIGGER_INBOUND = `uat-reaction-trigger ${new Date().toISOString()}`;
const NEGATIVE_INBOUND = `uat-reaction-trigger-negative ${new Date().toISOString()}`;

describe("uat: bot reaction triggers synthetic agent turn (#1074)", () => {
  it(
    "👎 on a bot reply dispatches a new agent turn; ❤️ does not",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        // 1. Drive the first bot reply we'll react to.
        await sc.sendDM(TRIGGER_INBOUND);
        const firstReply = await sc.expectMessage(/.+/, {
          from: "bot",
          timeout: 90_000,
        });
        expect(firstReply.senderUserId).toBe(sc.botUserId);

        // 2. React 👎 to the bot's reply. Default allowlist includes 👎,
        //    so the gateway should dispatch a synthetic inbound after
        //    the debounce window elapses.
        await sc.driver.sendReaction(sc.botUserId, firstReply.messageId, "👎");

        // 3. Wait for the agent to emit ANY subsequent message. The
        //    debounce window is 30s by default, plus a Claude turn —
        //    budget 120s to be safe.
        const triggeredReply = await sc.expectMessage(/.+/, {
          from: "bot",
          timeout: 120_000,
        });
        expect(triggeredReply.messageId).not.toBe(firstReply.messageId);
        expect(triggeredReply.senderUserId).toBe(sc.botUserId);

        // ── Negative case ───────────────────────────────────────────────
        await sc.sendDM(NEGATIVE_INBOUND);
        const secondReply = await sc.expectMessage(/.+/, {
          from: "bot",
          timeout: 90_000,
        });
        await sc.driver.sendReaction(sc.botUserId, secondReply.messageId, "❤️");

        // Wait the full debounce window + a generous Claude budget. If
        // a new turn fires within this window, the negative case has
        // failed (the allowlist leaked).
        const NEGATIVE_BUDGET_MS = 45_000;
        let leaked = false;
        try {
          await sc.expectMessage(/.+/, {
            from: "bot",
            timeout: NEGATIVE_BUDGET_MS,
          });
          leaked = true;
        } catch {
          // Expected — no new message within the negative window.
        }
        expect(leaked).toBe(false);
      } finally {
        await sc.tearDown();
      }
    },
    // Per-test budget — must cover trigger turn + debounce + agent
    // reply + negative-budget window + spinUp overhead. 5 minutes is
    // generous but on the order of `progress-card-dm.test.ts` which
    // also has multi-phase waits.
    300_000,
  );
});
