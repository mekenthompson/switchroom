/**
 * Vault UX scenario — operator DMs `/vault audit`, taps `[Allow]`
 * on a recent denial, agent re-attempts the vault read and succeeds.
 *
 * Part of: https://github.com/switchroom/switchroom/issues/866
 * Exercises: #969 P2b one-tap allow flow.
 *
 * **Gated by operator setup.** To unskip:
 *
 * 1. **Driver must be admin on `test-harness`.** `agent add
 *    --allow-from $DRIVER_UID` already includes the driver in
 *    `access.json:allowFrom`. Confirm the `/vault` commands also
 *    work — they may require an explicit `admin_chat_id` setting
 *    in the agent's switchroom.yaml. Look for
 *    "VAULT-AUDIT-FORBIDDEN" or similar in the gateway log when
 *    the driver DMs `/vault audit`.
 *
 * 2. **Sacrificial vault keys for the test.** The scenario writes
 *    and reads `uat-test-denial` under a deliberately empty
 *    `--allow` scope so the agent's first read fails with
 *    VAULT-BROKER-DENIED — that denial is what shows up in
 *    `/vault audit`. Pre-create the key on the host:
 *
 *    ```bash
 *    TMPF=$(mktemp) && printf '%s' 'sentinel-uat-value' > "$TMPF" && \
 *      switchroom vault set uat-test-denial --file "$TMPF" \
 *        --format string ; shred -u "$TMPF"
 *    ```
 *
 *    The scenario then triggers a denial, taps Allow (scopes the
 *    key to `test-harness`), and asserts the agent can now read it.
 *    Cleanup at the end is operator-side: re-narrow the scope or
 *    remove the key.
 *
 * 3. Remove the `describe.skip` below.
 *
 * Why skipped by default: the scenario mutates host vault state
 * (broker ACL) — opt-in only.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

describe.skip("uat: /vault audit one-tap allow", () => {
  it("driver taps [Allow] on a recent denial; agent's next read succeeds", async () => {
    const sc = await spinUp({ agent: "test-harness" });
    try {
      // 1. Trigger a denial by asking the agent to read a key the
      //    agent isn't yet scoped for.
      await sc.sendDM(
        "Please run `switchroom vault get uat-test-denial` and tell me the value.",
      );

      // The bot's denial trace finishes the turn — wait for the
      // turn-end message, then proceed to /vault audit.
      await sc.expectMessage(/VAULT-BROKER-DENIED|denied|cannot/i, {
        from: "bot",
        timeout: 60_000,
      });

      // 2. DM /vault audit. The bot replies with a recent-denials
      //    summary + inline [Allow] / [Deny] buttons per denied key.
      await sc.sendDM("/vault audit");
      const auditCard = await sc.expectMessage(/Recent denials|uat-test-denial/, {
        from: "bot",
        timeout: 30_000,
      });

      // 3. Find and press the [Allow] button.
      const kb = await sc.driver.getKeyboard(sc.botUserId, auditCard.messageId);
      expect(kb).not.toBeNull();
      const allowButton = kb!
        .flat()
        .find(
          (b) =>
            b.callbackData !== undefined &&
            /allow/i.test(b.text) &&
            b.callbackData.includes("uat-test-denial"),
        );
      expect(allowButton).toBeDefined();
      await sc.driver.pressButton(
        sc.botUserId,
        auditCard.messageId,
        allowButton!.callbackData!,
      );

      // 4. Confirmation comes back via card edit; assert it lands.
      //    (The gateway typically edits the audit card in-place to
      //    show "allowed" status.)
      await sc.expectMessage(/allowed|✓|scope updated/i, {
        from: "bot",
        timeout: 15_000,
      });

      // 5. Re-attempt the read. Should now succeed.
      await sc.sendDM(
        "Try `switchroom vault get uat-test-denial` again now.",
      );
      const success = await sc.expectMessage(/sentinel-uat-value/, {
        from: "bot",
        timeout: 60_000,
      });
      expect(success.text).toContain("sentinel-uat-value");
    } finally {
      await sc.tearDown();
    }
  });
});
