/**
 * Location-inbound scenario — driver shares a geolocation with the
 * test bot. Exercises the new `message:location` handler from #1077
 * end-to-end: gateway parses the lat/lon, builds a `(location: …)`
 * envelope, forwards to the agent, agent replies.
 *
 * Requires the same env as `smoke-dm-reply.test.ts` (see
 * `uat/SETUP.md` §6).
 *
 * Coordinates are intentionally a well-known landmark (Sydney Opera
 * House) so a failure trace makes "what was shared" obvious — and so
 * a chatbot persona has something semantically grounded to respond to,
 * which makes the bot's reply check more meaningful than asserting
 * `.+`. We still tolerate ANY reply text — the goal is to prove the
 * gateway forwarded the location, not to grade the agent's geography.
 *
 * Other 12 inbound types from #1077 are covered structurally in
 * `tests/inbound-message-types.test.ts`. End-to-end UAT for them
 * (contact, venue, dice, poll, web_app_data, users_shared,
 * chat_shared, dice, game, story, paid_media, successful_payment,
 * passport_data) is deferred — most require either a custom bot
 * setup (mini-app, payments provider) or a Telegram client gesture
 * (story share, dice roll) that the mtcute driver does not script
 * cleanly enough to be worth the brittleness.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

// Sydney Opera House — recognizable, non-sensitive, stable across runs.
const SYDNEY_OPERA_HOUSE_LAT = -33.8568;
const SYDNEY_OPERA_HOUSE_LON = 151.2153;

describe("uat: location-inbound DM round-trip", () => {
  it(
    "driver shares a geolocation, bot replies within 90s",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });

      try {
        await sc.driver.sendLocation(
          sc.botUserId,
          SYDNEY_OPERA_HOUSE_LAT,
          SYDNEY_OPERA_HOUSE_LON,
        );

        // Same budget as smoke-dm-reply: 90s tolerates the gateway's
        // coalescing window + one normal Claude turn. A healthy agent
        // replies in <20s.
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
    // Mirrors smoke-dm-reply's 110s outer budget — must exceed the
    // 90s inner deadline plus spinUp overhead.
    110_000,
  );
});
