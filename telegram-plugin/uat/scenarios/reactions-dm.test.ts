/**
 * Reaction lifecycle scenario — driver DMs the test bot, bot reacts
 * to the inbound message through the lifecycle and lands a terminal
 * emoji once the reply ships.
 *
 * Part of: https://github.com/switchroom/switchroom/issues/866
 * Goal context: cause class CC-1 / CC-6 in
 * `docs/status-ask-cause-classes.md` (the L1 ambient layer should
 * deliver a definitively-done terminal emoji within a few seconds
 * of the bot's final reply — otherwise the user looks at their
 * inbound, sees it still wearing 🤔, and asks "you done?").
 *
 * History: this scenario was previously `describe.skip` with a
 * rationale that the pinned progress card "renders INSTEAD of
 * reactions". The card was retired in #1126; the card-vs-reaction
 * branch in the gateway is dead. We can now exercise the full
 * lifecycle end-to-end without the two-agent split.
 *
 * What we assert (in priority order):
 *
 *  1. Within the turn, the driver sees AT LEAST ONE `+` reaction
 *     op (the L1 "I'm alive" signal). Fast turns may collapse
 *     intermediate states, so we only require *one* add, not a
 *     specific emoji.
 *  2. By the time the bot has sent a final reply (+ a short tail
 *     for Telegram to deliver the terminal-emoji replace), the
 *     LAST observed `+` op is in the `done` set (`👍 / 💯 / 🎉`).
 *
 * Why "last `+` op wins" rather than `expectReaction(['👍'])` with
 * a literal sequence: `setMessageReaction` REPLACES the prior emoji
 * atomically. mtcute's update stream can deliver the replace as a
 * `-prev` followed by a `+next`, or as a single coalesced event,
 * depending on server batching. The "last add wins" shape matches
 * the production semantics — whatever's *currently* on the message
 * is what the user actually sees.
 *
 * The observer must be attached BEFORE the reply lands so we
 * capture the queued / working reactions, not just the terminal
 * one. Pattern: `observeReactions` immediately after `sendDM`
 * returns the messageId, drain into a trail array while we wait
 * for the reply, then run a short tail to catch the terminal
 * after the reply.
 *
 * Requires the same env as `smoke-dm-reply.test.ts` (see
 * `uat/SETUP.md` §6).
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const TERMINAL_DONE_EMOJI = new Set(["👍", "💯", "🎉"]);
const TAIL_AFTER_REPLY_MS = 8_000;

const INBOUND = (): string => `uat-reactions ${new Date().toISOString()}`;

interface ObservedOp {
  emoji: string;
  op: "+" | "-";
  at: number;
}

describe("uat: reaction lifecycle on driver DM", () => {
  it(
    "driver sees an alive reaction, then a terminal-done emoji by reply tail",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const sent = await sc.sendDM(INBOUND());

        // Attach the observer immediately so the queued (👀) and
        // working reactions don't fire before the listener exists.
        const trail: ObservedOp[] = [];
        const iter = sc.driver
          .observeReactions(sc.botUserId, { messageId: sent.messageId })
          [Symbol.asyncIterator]();
        let pump: Promise<void> | null = null;
        let stopPump = false;
        pump = (async () => {
          while (!stopPump) {
            const next = await iter.next();
            if (next.done === true) return;
            trail.push({
              emoji: next.value.emoji,
              op: next.value.op,
              at: Date.now(),
            });
          }
        })();

        try {
          // Wait for the bot's reply (any content). Gives the L1
          // lifecycle time to traverse queued → working → done.
          const reply = await sc.expectMessage(/\S/, {
            from: "bot",
            timeout: 60_000,
          });
          expect(reply.text.length).toBeGreaterThan(0);

          // Tail after the reply for Telegram to deliver the
          // terminal-emoji replace. In practice <1s on a healthy bot;
          // 8s ceiling absorbs server batching jitter.
          await new Promise((resolve) =>
            setTimeout(resolve, TAIL_AFTER_REPLY_MS),
          );
        } finally {
          stopPump = true;
          await iter.return?.();
          if (pump) {
            await pump.catch(() => {
              /* generator return triggers rejection on pending iter.next() — ignore */
            });
          }
        }

        // L1 alive signal: at least one `+` op landed during the turn.
        const adds = trail.filter((o) => o.op === "+");
        expect(
          adds.length,
          `expected at least one reaction-add during the turn, got 0. ` +
            `Full trail: ${trail.map((o) => `${o.op}${o.emoji}`).join(" ") || "(empty)"}`,
        ).toBeGreaterThan(0);

        // L1 terminal: the LAST `+` op should be a terminal-done emoji.
        // Extra `-` ops after the final `+` are tolerated (Telegram
        // sometimes emits a bare clean-up `-`); the last `+` is what
        // the user actually sees.
        const lastAdd = adds[adds.length - 1];
        expect(
          TERMINAL_DONE_EMOJI.has(lastAdd.emoji),
          `expected last reaction-add to be one of ${[
            ...TERMINAL_DONE_EMOJI,
          ].join(", ")}, got ${lastAdd.emoji}. Full trail: ${trail
            .map((o) => `${o.op}${o.emoji}`)
            .join(" ")}`,
        ).toBe(true);
      } finally {
        await sc.tearDown();
      }
    },
    90_000,
  );
});
