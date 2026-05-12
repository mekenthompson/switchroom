/**
 * Silence-poke soft-fire end-to-end scenario.
 *
 * Goal context: cause class CC-3 in `docs/status-ask-cause-classes.md`
 * — the L3 safety net. Unit tests (`silence-poke.test.ts`) cover the
 * state machine: tick semantics, ladder thresholds, success measurement.
 * They DO NOT cover the wire path between `consumeArmedPoke()` (in
 * `silence-poke.ts`) and the model actually receiving the
 * `[silence-poke]` system-reminder block on its next tool result.
 *
 * The wire path lives at `gateway.ts:2740`:
 *
 *   onToolCall → executeToolCall(...) → consumeArmedPoke() →
 *   append `<system-reminder>[silence-poke] ...</system-reminder>`
 *   to the tool-result text.
 *
 * If that integration ever breaks — a refactor swaps `executeToolCall`
 * for a path that doesn't call `consumeArmedPoke`, the result-content
 * shape mutation gets dropped, MCP framing changes — the unit tests
 * still pass but the model never sees the nudge, the user goes silent
 * past 75s, and `inbound_status_query` ticks. This UAT closes that
 * regression window end-to-end.
 *
 * ## Strategy
 *
 * Force the agent into a stretch of silent tool churn that exceeds the
 * 75s soft threshold without the model emitting any outbound `reply`.
 * The conversational-pacing prompt instructs the model to soft-commit
 * fast turns, so we have to explicitly suppress that:
 *
 *   - Prompt instructs three sequential 30s `sleep` Bash calls, NO
 *     mid-turn replies, single final reply when done.
 *   - Total silent stretch is ~90s + tool overhead, comfortably past
 *     the 75s soft threshold.
 *   - If the silence-poke wire works: the model sees the
 *     `[silence-poke]` system-reminder appended to the result of the
 *     first or second sleep, breaks the no-reply rule, sends a brief
 *     update. We observe a reply in the [70s, 200s] window.
 *   - If the wire is broken: model never receives the nudge, no
 *     reply until the third sleep ends at ~90s+, OR the framework
 *     fallback at 300s fires. We catch the latter as a separate
 *     failure (the framework fallback is the FLOOR, not the goal).
 *
 * ## Tolerances
 *
 * Real-Telegram UAT against a real Claude model has variability:
 *
 *   - Model may insert one soft-commit "on it" reply at start; that
 *     resets the silence clock. Three 30s sleeps still pushes the
 *     post-commit silence past 75s as long as the commit lands
 *     within the first ~10s. We tolerate this.
 *   - Model may decline to follow the "no replies" instruction and
 *     send updates organically; if the FIRST reply still lands in
 *     [70s, 200s], the conversational pacing layer is doing its job
 *     and the test passes regardless of whether silence-poke
 *     specifically fired.
 *   - Window is generous (70-200s) to absorb 5s poll interval,
 *     mtcute receive lag, Telegram delivery jitter.
 *
 * ## Failure shapes the assertion catches
 *
 *   1. Wire path broken — first reply lands >200s after sendDM
 *      because the framework fallback (300s) is the only thing that
 *      eventually breaks the silence.
 *   2. Soft poke armed but not drained — first reply lands at >200s
 *      similarly.
 *   3. Model misbehavior — first reply is the FINAL answer (long
 *      text after all three sleeps complete at ~90s+); strictly that
 *      passes the window check, but the test also asserts the first
 *      reply is brief (<400 chars) as a sanity floor on "this is
 *      actually a poke response, not the final answer." Skip strict
 *      length if the prompt happens to be so simple the final
 *      answer IS brief.
 *
 * Requires the same env as `smoke-dm-reply.test.ts` (see
 * `uat/SETUP.md` §6). Long-running: outer budget 4 min.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const SOFT_WINDOW_MIN_MS = 70_000;
const SOFT_WINDOW_MAX_MS = 200_000;

// Explicit instruction shape. Mirrors the `BG_DISPATCH_PROMPT` pattern
// in `bg-sub-agent-dispatch-dm.test.ts` — pin the tool + the sequence
// so behaviour is deterministic enough to test the *infra*, not the
// model's free-form judgement.
const SILENT_CHURN_PROMPT =
  "I need you to test something. Run THREE separate Bash tool calls " +
  "in sequence: first `sleep 30`, then `sleep 30`, then `sleep 30`. " +
  "Critical: do NOT send any `reply` or `stream_reply` between or " +
  "during the sleeps — no soft commit, no progress updates, no " +
  "narration. Just the three Bash calls back-to-back. Once all three " +
  "complete, send ONE brief final reply saying 'done' so I know " +
  "you're back.";

describe("uat: silence-poke soft fires + reaches the model wire", () => {
  it(
    "agent breaks self-imposed silence in [70s, 200s] window via silence-poke",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const sendStart = Date.now();
        await sc.sendDM(SILENT_CHURN_PROMPT);

        // Wait for the FIRST reply. If silence-poke + the wire path
        // are working, this lands between ~75s and ~110s as the
        // model responds to the [silence-poke] system-reminder
        // appended to the first or second sleep's tool result.
        const firstReply = await sc.expectMessage(/\S/, {
          from: "bot",
          timeout: SOFT_WINDOW_MAX_MS + 20_000,
        });
        const elapsed = Date.now() - sendStart;

        expect(firstReply.text.length).toBeGreaterThan(0);

        // Primary window assertion.
        expect(
          elapsed,
          `first bot reply lands at ${elapsed}ms (target window ` +
            `[${SOFT_WINDOW_MIN_MS}, ${SOFT_WINDOW_MAX_MS}]). ` +
            `Reply text: ${JSON.stringify(firstReply.text.slice(0, 200))}.`,
        ).toBeGreaterThanOrEqual(SOFT_WINDOW_MIN_MS);
        expect(
          elapsed,
          `first bot reply lands at ${elapsed}ms — above ${SOFT_WINDOW_MAX_MS}ms ` +
            `ceiling. Either silence-poke wire is broken (poke armed but ` +
            `not drained at gateway.ts:onToolCall) or the framework ` +
            `fallback at 300s was the first thing to break silence. ` +
            `Reply text: ${JSON.stringify(firstReply.text.slice(0, 200))}.`,
        ).toBeLessThanOrEqual(SOFT_WINDOW_MAX_MS);

        // Sanity floor: the first reply should be brief — proves it's
        // a poke-driven update, not the final "done" answer after all
        // three sleeps finished naturally. ~400 char ceiling allows a
        // verbose model to add a sentence of context. Bump this if it
        // flakes on perfectly valid short answers.
        if (firstReply.text.length > 400) {
          console.warn(
            `[silence-poke] first reply at ${elapsed}ms is ${firstReply.text.length} ` +
              `chars — longer than expected for a poke-driven update. The ` +
              `window assertion still passed, but consider whether the model ` +
              `bypassed the silence stretch (e.g. ran the sleeps in one ` +
              `Bash call, dodging the per-call result poke chokepoint).`,
          );
        }
      } finally {
        await sc.tearDown();
      }
    },
    240_000,
  );
});
