/**
 * Voice-inbound scenario — driver sends a voice note (OGG/Opus)
 * to the test bot, gateway's `voice_in` skill transcribes it,
 * bot replies with text.
 *
 * Part of: https://github.com/switchroom/switchroom/issues/866
 *
 * **Gated by fixture + bot config.** To unskip:
 *
 * 1. Generate a 1-second silent OGG/Opus fixture:
 *
 *    ```bash
 *    mkdir -p telegram-plugin/uat/fixtures/voice
 *    ffmpeg -f lavfi -i anullsrc=r=48000:cl=mono -t 1 \
 *      -c:a libopus -b:a 32k \
 *      telegram-plugin/uat/fixtures/voice/silence-1s.opus
 *    ```
 *
 *    (Fixture is intentionally NOT committed to git — keep the repo
 *    light. Generate locally before unskipping.)
 *
 * 2. Verify the test-harness agent has `voice_in` configured. The
 *    default profile may not enable it; check `switchroom config
 *    show test-harness` for `channels.telegram.voice_in.enabled`.
 *
 * 3. Remove the `describe.skip` below.
 *
 * Why skipped by default: voice transcription costs money per call
 * (OpenAI/Whisper) and slow turns are expected — keeping this off
 * the default UAT path until someone explicitly tests voice.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const FIXTURE = path.resolve(
  __dirname,
  "..",
  "fixtures",
  "voice",
  "silence-1s.opus",
);

describe.skip("uat: voice-inbound DM round-trip", () => {
  it("driver sends a voice note, bot transcribes + replies within 60s", async () => {
    if (!existsSync(FIXTURE)) {
      throw new Error(
        `voice fixture not found at ${FIXTURE} — see scenario header to generate one`,
      );
    }
    const sc = await spinUp({ agent: "test-harness" });
    try {
      await sc.driver.sendVoice(sc.botUserId, FIXTURE);
      const reply = await sc.expectMessage(/.+/, {
        from: "bot",
        timeout: 60_000,
      });
      expect(reply.text.length).toBeGreaterThan(0);
    } finally {
      await sc.tearDown();
    }
  });
});
