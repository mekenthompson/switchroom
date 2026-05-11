/**
 * UAT scenario — operator chats casually about secrets/tokens
 * (mentioning the words, not pasting actual credentials); bot
 * MUST NOT redact the operator's question.
 *
 * Part of: secret-redaction bug class reported 2026-05-12 (Bug B —
 * false positive on the word "secret"/"token" or on
 * code-shaped-but-placeholder values like `MY_TOKEN=hello`).
 *
 * **Skipped by default.** Unskip after the standard UAT preflight
 * (uat/SETUP.md §5-6). No host-state mutations.
 *
 * The unit-shape contract is pinned in
 * `telegram-plugin/tests/secret-detect-false-positives.test.ts` —
 * which runs every CI cycle. This UAT scenario adds the
 * end-to-end Telegram round-trip so a future regression in the
 * gateway integration (not the detector) would also surface.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const CASUAL_MENTIONS = [
  "what's my fatsecret token?",
  "delete that secret you sent earlier",
  "the FATSECRET_TOKEN env var is missing",
  "set MY_TOKEN=hello and try again",
  "I keep forgetting my password again",
];

describe.skip("uat: secret-redaction does NOT fire on casual mentions (Bug B 2026-05-12)", () => {
  for (const text of CASUAL_MENTIONS) {
    it(
      `does not redact: ${JSON.stringify(text)}`,
      async () => {
        const sc = await spinUp({ agent: "test-harness" });
        try {
          const sent = await sc.sendDM(text);

          // Wait a short period for any (incorrect) redaction reply
          // to arrive. If the bot's gonna fire the redaction
          // pipeline, it does so synchronously in handleInbound —
          // well under 10s.
          //
          // The assertion: we should NOT see a "🔒 captured" or
          // "🔒 caught a secret" reply. If we do, the false
          // positive is back.
          //
          // We tolerate the bot's normal Claude reply (which is
          // unrelated content). Pin only the absence of the
          // redaction marker.
          let sawRedaction = false;
          try {
            await sc.expectMessage(/🔒 (captured|caught)/, {
              from: "bot",
              timeout: 10_000,
            });
            sawRedaction = true;
          } catch {
            // Expected: timeout means no redaction fired.
          }
          expect(
            sawRedaction,
            `false-positive redaction fired on casual chat: ${JSON.stringify(text)}`,
          ).toBe(false);

          // The original message must remain visible — the
          // operator asked a real question and the bot deleted
          // it would be terrible UX.
          // chat_id for the driver's view of a DM = the partner's
          // (bot's) user_id.
          const stillThere = await sc.driver.getMessage(
            sc.botUserId,
            sent.messageId,
          );
          expect(
            stillThere,
            `the bot deleted the operator's question (false positive on '${text}')`,
          ).not.toBeNull();
        } finally {
          await sc.tearDown();
        }
      },
      60_000,
    );
  }
});
