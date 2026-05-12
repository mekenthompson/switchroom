/**
 * JTBD scenario — `status?` inbound classifier.
 *
 * The conversational-pacing redesign (#1122 PR1) wired a primary
 * lagging KPI: `inbound_status_query`, the count of users typing
 * "status?", "still there?", "?", etc — every fire is a JTBD
 * failure. We assert the classifier triggers AND the agent
 * gracefully responds (i.e. doesn't crash, doesn't ignore, doesn't
 * loop on it).
 *
 * Note: the classifier is fire-and-forget — it emits a runtime
 * metric event but doesn't change routing. So all we can assert
 * from the driver side is "the agent still replies sensibly" —
 * the metric emission is verified by the unit tests in
 * `tests/inbound-classifier.test.ts`. This UAT exists for
 * end-to-end safety: "sending status? doesn't break anything."
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

const STATUS_QUERIES = ["status?", "still there?", "any update?", "?"];

describe("uat: status-query inbound", () => {
  for (const query of STATUS_QUERIES) {
    it(
      `user sends ${JSON.stringify(query)} → agent replies sensibly`,
      async () => {
        const sc = await spinUp({ agent: "test-harness" });
        try {
          await sc.sendDM(query);

          // Any non-empty reply within 60s is acceptable. The
          // interesting thing is the classifier metric fired —
          // verified at the unit-test level. Here we just want
          // "no crash, no silent-end, sensible reply."
          const reply = await sc.expectMessage(/\S/, {
            from: "bot",
            timeout: 60_000,
          });
          expect(reply.text.length).toBeGreaterThan(0);
        } finally {
          await sc.tearDown();
        }
      },
      90_000,
    );
  }
});
