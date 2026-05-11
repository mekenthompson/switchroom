/**
 * Smoke scenario — driver DMs the test bot, bot replies.
 *
 * Part of: https://github.com/switchroom/switchroom/issues/866
 *
 * Runs against real Telegram. Requires:
 *   - test-harness agent running (see uat/SETUP.md §5)
 *   - TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_UAT_DRIVER_SESSION
 *     in the env (operator script in SETUP.md §6)
 *   - TELEGRAM_TEST_BOT_USERNAME (defaults to `meken_switchroom_test_bot`)
 *
 * Invoke via `bun run test:uat` from `telegram-plugin/`. Default
 * `bun test` / vitest do NOT discover this file — see
 * vitest.config.ts.
 *
 * This is intentionally the simplest possible end-to-end check —
 * just confirms the DM round-trip works. Richer assertions
 * (reactions, progress card, edits) roll in with #866 Phase 2b.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

const SMOKE_INBOUND = `uat-smoke ${new Date().toISOString()}`;

describe("uat: DM round-trip smoke", () => {
  it(
    "driver DMs the test bot and observes a bot reply",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });

      try {
        await sc.sendDM(SMOKE_INBOUND);

        // 90s wall-clock budget: tolerates one rate-limit retry on the
        // bot side + a normal Claude turn. If the agent is healthy the
        // reply arrives in <20s.
        const reply = await sc.expectMessage(/.+/, {
          from: "bot",
          timeout: 90_000,
        });

        expect(reply.text.length).toBeGreaterThan(0);
        expect(reply.senderUserId).toBe(sc.botUserId);
      } finally {
        await sc.tearDown();
      }
    },
    // Per-test budget — must exceed the 90s inner expectMessage
    // deadline plus mtcute connect overhead. bun:test's default of
    // 5s would cut the test off on any turn that takes longer than
    // a few seconds.
    100_000,
  );
});
