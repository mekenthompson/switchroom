/**
 * Mid-turn `disable_notification` scenario.
 *
 * Goal context: cause class CC-2 in `docs/status-ask-cause-classes.md`
 * — the L2 conversational layer. The conversational-pacing prompt
 * (`profiles/_shared/telegram-style.md.hbs:10`) instructs the model to
 * pass `disable_notification: true` on mid-turn `reply` calls so the
 * user only gets a device ping on the FINAL answer. If that contract
 * silently degrades — model regression, prompt drift, or a gateway
 * code path that drops the flag — every mid-turn reply pings. Users
 * mute the bot. They then can't tell working from done. They ask
 * "are you alive?" — `inbound_status_query` ticks.
 *
 * The flag is observable on the receiving side via mtcute's
 * `message.isSilent` getter (corresponds to Telegram's
 * `message.silent` flag, set by sender's `disable_notification` Bot
 * API param). The driver was extended in this PR to surface it on
 * `ObservedMessage.silent`.
 *
 * ## What the scenario asserts
 *
 * 1. Send a prompt that should produce multiple bot outbounds (a
 *    soft commit + mid-turn updates + a final answer). The prompt
 *    is explicit about wanting paced updates so the model doesn't
 *    optimize to a single reply.
 * 2. Collect every bot message in the turn (waits for quiescence:
 *    no fresh bot message for `QUIESCENCE_MS`).
 * 3. Assert: every bot message EXCEPT THE LAST has `silent === true`.
 * 4. Assert: the LAST bot message has `silent === false` (the final
 *    answer should ping).
 *
 * ## Tolerances
 *
 * - If the turn has only one bot message (model judged the work fast
 *   enough to skip pacing), the mid-turn assertion is vacuous and we
 *   only check that the single final message is NOT silent. The
 *   prompt is engineered to be slow enough that this is unlikely,
 *   but we don't fail on it.
 * - Quiescence window is 12s — long enough that a paused model isn't
 *   mistaken for "done", short enough that test wall-clock stays
 *   reasonable.
 * - Edits don't count as fresh messages — we observe `edited === false`
 *   only. This matches the production semantic: an edit doesn't push
 *   a notification.
 *
 * ## Failure shapes
 *
 *   1. Mid-turn ping degrade — at least one non-last message has
 *      `silent === false`. The error message names the offending
 *      message index + text preview.
 *   2. Final-answer silent — the last message has `silent === true`.
 *      Means the final answer doesn't ping; user might miss the
 *      reply landing.
 *   3. No bot messages within timeout — distinct failure: agent
 *      isn't responding at all.
 *
 * Requires the same env as `smoke-dm-reply.test.ts` (see
 * `uat/SETUP.md` §6).
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import type { ObservedMessage } from "../driver.js";

const QUIESCENCE_MS = 12_000;
const OVERALL_DEADLINE_MS = 120_000;

// Multi-step prompt with explicit pacing expectations. Engineered so
// a well-behaved model produces:
//   1. soft commit ("on it" / "let me check")
//   2. mid-turn update after each file (with disable_notification: true)
//   3. final answer
//
// The work itself is two trivial file reads + a one-sentence
// summary. If the model collapses this to a single reply, the test
// still asserts the disable_notification contract on what it does
// emit; the vacuous-mid-turn path is allowed.
const PACED_PROMPT =
  "Please follow this exact pacing protocol for this turn:\n" +
  "  1. First send a brief 'on it' reply so I know you started.\n" +
  "  2. Read /etc/hostname, then send a brief mid-turn update saying " +
  "what the hostname is. Use disable_notification:true on that update.\n" +
  "  3. Read /etc/os-release, then send a brief mid-turn update saying " +
  "what the OS family is. Use disable_notification:true on that update.\n" +
  "  4. Finally send a single-sentence summary as your final answer " +
  "(no disable_notification flag — this one should ping me).\n" +
  "Keep each message short.";

describe("uat: mid-turn replies pass disable_notification (CC-2)", () => {
  it(
    "every mid-turn bot reply is silent; only the final answer pings",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        await sc.sendDM(PACED_PROMPT);

        const collected: ObservedMessage[] = [];
        const overallDeadline = Date.now() + OVERALL_DEADLINE_MS;
        let quiescenceDeadline = Date.now() + 30_000; // first message
        // bigger budget

        // Drain bot messages until QUIESCENCE_MS passes with no
        // fresh non-edit observation, or the overall deadline hits.
        while (Date.now() < overallDeadline) {
          const remaining = Math.min(
            quiescenceDeadline - Date.now(),
            overallDeadline - Date.now(),
          );
          if (remaining <= 0) break;
          try {
            const msg = await sc.expectMessage(
              (m: ObservedMessage) => m.fromBot && !m.edited,
              { from: "bot", timeout: remaining },
            );
            collected.push(msg);
            quiescenceDeadline = Date.now() + QUIESCENCE_MS;
          } catch {
            // Timed out — that's the quiescence signal we wanted.
            break;
          }
        }

        expect(
          collected.length,
          `no bot messages observed within ${OVERALL_DEADLINE_MS}ms — ` +
            `agent isn't responding at all (distinct failure from CC-2).`,
        ).toBeGreaterThan(0);

        const trail = collected
          .map(
            (m, i) =>
              `  [${i}] silent=${m.silent} text=${JSON.stringify(
                m.text.slice(0, 80),
              )}`,
          )
          .join("\n");

        // Final answer should ping.
        const last = collected[collected.length - 1];
        expect(
          last.silent,
          `final answer (message ${collected.length - 1}) was marked ` +
            `silent — the user won't get pinged when the turn finishes. ` +
            `Trail:\n${trail}`,
        ).toBe(false);

        // Mid-turn updates should NOT ping. Vacuous when the model
        // emitted only the final answer; meaningful when paced.
        const midTurn = collected.slice(0, -1);
        const loudMidTurn = midTurn.filter((m) => !m.silent);
        expect(
          loudMidTurn.length,
          `${loudMidTurn.length} mid-turn message(s) were NOT silent — ` +
            `each one pings the user's device. Conversational pacing ` +
            `requires disable_notification:true on mid-turn replies. ` +
            `Trail:\n${trail}`,
        ).toBe(0);

        if (midTurn.length === 0) {
          console.warn(
            `[midturn-silent] model produced only 1 bot reply — the ` +
              `mid-turn assertion was vacuous. Prompt may not be ` +
              `slow enough to force pacing, or the model is ignoring ` +
              `the explicit step-by-step instructions. This is not a ` +
              `failure of CC-2, but the scenario didn't cover its ` +
              `intended ground.`,
          );
        }
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_DEADLINE_MS + 30_000,
  );
});
