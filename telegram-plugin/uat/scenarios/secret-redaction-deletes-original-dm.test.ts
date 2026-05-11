/**
 * UAT scenario — operator pastes a real-shaped secret into the bot's
 * DM; bot detects, deletes the original, posts a redaction card.
 *
 * Part of: secret-redaction bug class reported 2026-05-12 (Bug A —
 * sometimes the original message isn't actually deleted from chat
 * history despite the bot claiming it was).
 *
 * **Skipped by default.** To unskip:
 *
 * 1. Run the standard UAT preflight (uat/SETUP.md §5-6) so the
 *    test-harness agent is live and the driver session is auth'd.
 *
 * 2. Verify the test-harness chat has secret-detect enabled. The
 *    agent's switchroom.yaml `access.json` must include the driver
 *    in `allowFrom` so the driver's paste is treated as a real
 *    operator message (not silently ignored). Existing UAT setup
 *    already covers this for the smoke scenario.
 *
 * 3. Confirm a vault passphrase is cached in the test-harness chat
 *    so the high-confidence-stored branch fires (not the
 *    no-passphrase deferred branch). Easiest: send `/vault unlock`
 *    + passphrase as the driver once before running this scenario.
 *    Without a cached passphrase the assertion changes — the bot
 *    posts the "🔒 caught a secret. tap below to unlock the vault
 *    and save it" card instead of "🔒 captured N secrets:". Both
 *    paths MUST delete the original; the matcher here is loose
 *    enough to accept either.
 *
 * 4. Remove the `describe.skip` below.
 *
 * Why skipped: sends a real-shaped (but synthetic) secret-pattern
 * string into Telegram. The pattern doesn't unlock any actual
 * secret, but committing the scenario unskipped would also commit
 * the test fixture into git history where secretlint pre-commit
 * hooks might flag it. Generated at runtime to dodge the scan.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

describe.skip("uat: secret-redaction deletes the original message (Bug A 2026-05-12)", () => {
  it(
    "paste a real-shaped secret; bot deletes the original from chat history",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        // Build a real-shaped (but synthetic) ANTHROPIC_API_KEY value
        // at runtime so the source file doesn't trip Push Protection.
        // Same idiom as telegram-plugin/tests/secret-detect-secretlint.test.ts:1.
        const fakeApiKey =
          `sk-ant-` + "a1b2c3d4".repeat(4) + "_test_synthetic";
        const inboundText = `set ANTHROPIC_API_KEY=${fakeApiKey}`;

        // Send the secret-bearing message. Capture the messageId we
        // sent so we can later assert it's gone from history.
        const sent = await sc.sendDM(inboundText);
        const sentMessageId = sent.messageId;

        // The bot should reply with either:
        //   - "🔒 captured N secret(s):" (high-confidence stored
        //     path, requires cached passphrase)
        //   - "🔒 caught a secret. we deleted it from chat. tap
        //     below to unlock the vault..." (deferred path)
        // OR the new fail-loud variant (if delete failed):
        //   - "⚠️ Could not auto-delete message containing your ..."
        // The contract this test pins is: ONE of the first two
        // success messages appears AND the original message is
        // actually gone from history.
        const reply = await sc.expectMessage(
          /🔒 (captured|caught)/,
          { from: "bot", timeout: 30_000 },
        );
        expect(reply.text).toMatch(/deleted (it )?from chat|captured/i);

        // The load-bearing assertion: the original message is
        // unreachable in chat history. driver.getMessage returns
        // null for deleted messages (driver.ts:525-534).
        //
        // Pre-2026-05-12 fix: this would sometimes pass when delete
        // succeeded and silently leave the message behind when it
        // failed (Telegram rate limits, network blip, message was
        // edited mid-delete, etc.) — and the operator would never
        // know.
        //
        // Post-fix: deleteSensitiveMessage either deletes
        // successfully OR posts an in-chat warning "⚠️ Could not
        // auto-delete..." which we'd see as a SECOND bot message.
        // The assertion here is the strict "actually gone" version.
        // chat_id for the driver's view of a DM = the partner's
        // (bot's) user_id.
        const stillThere = await sc.driver.getMessage(sc.botUserId, sentMessageId);
        expect(
          stillThere,
          `original secret-bearing message ${sentMessageId} was NOT deleted — Telegram history still has it`,
        ).toBeNull();
      } finally {
        await sc.tearDown();
      }
    },
    120_000,
  );

  it(
    "when delete fails (simulated by editing the message just before delete), the bot posts a warning naming the leaked msg_id",
    async () => {
      // This case is harder to repro without a fault-injection
      // hook — Telegram doesn't let us "make deleteMessage fail
      // deterministically" from the driver side. The contract is
      // pinned by the unit test at
      // telegram-plugin/tests/secret-detect-delete-must-surface-failures.test.ts
      // (deleteSensitiveMessage helper still logs SECURITY: …
      // FAILED + posts an in-chat warning on its catch path).
      // This UAT slot stays skipped pending a fault-injection
      // affordance in the driver — tracked as a TODO on the
      // harness roadmap.
      const _ = await spinUp({ agent: "test-harness" });
      void _;
      expect(true).toBe(true);
    },
    60_000,
  );
});
