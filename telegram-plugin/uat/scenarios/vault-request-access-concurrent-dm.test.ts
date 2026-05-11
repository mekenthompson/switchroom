/**
 * End-to-end UAT scenario for the #1051 fix — concurrent
 * vault_request_access cards must BOTH end up readable by the agent.
 *
 * #1051 had two failure modes:
 *   (a) `.vault-token` overwrite — each new grant strands the prior
 *       (agent can read only the most-recently-approved key).
 *   (b) pending-op race — second Approve tap before first passphrase
 *       reply orphans the first stage entirely (no second grant
 *       even minted).
 *
 * Both fixed by the gateway-side grant-union path: list existing
 * grants → union keys → mint a consolidated grant. PLUS the
 * pending-op shape extended to a queue so concurrent taps don't
 * overwrite.
 *
 * This scenario covers (a) — the most-likely real-world repro
 * (gymbro fires two cards back-to-back; operator approves both
 * sequentially). Covering (b) cleanly needs precise tap-timing
 * that's harder to script — the static-source test
 * `telegram-plugin/tests/vault-grant-union.test.ts` pins it at the
 * code level instead.
 *
 * **Skipped by default.** To unskip:
 *
 * 1. Standard UAT preflight (`uat/SETUP.md` §5-6).
 * 2. `TELEGRAM_UAT_VAULT_PASSPHRASE` set in env.
 * 3. Pre-create two sacrificial vault keys:
 *
 *    ```bash
 *    for k in uat/concurrent-a uat/concurrent-b ; do
 *      TMPF=$(mktemp); printf '%s' "sentinel-${k##*/}" > "$TMPF"
 *      switchroom vault set "$k" --file "$TMPF" --format string
 *      shred -u "$TMPF"
 *    done
 *    ```
 *
 * 4. Remove `describe.skip` below.
 *
 * Why skipped: mutates vault state (mints a grant covering both keys
 * on test-harness). Cleanup is operator-side post-run.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const KEY_A = "uat/concurrent-a";
const KEY_B = "uat/concurrent-b";
const SENTINEL_A = "sentinel-concurrent-a";
const SENTINEL_B = "sentinel-concurrent-b";

describe.skip("uat: concurrent vault_request_access approvals — both grants survive (#1051)", () => {
  it(
    "agent fires two cards back-to-back, operator approves both → agent can read both keys",
    async () => {
      const passphrase = process.env.TELEGRAM_UAT_VAULT_PASSPHRASE;
      if (!passphrase) {
        throw new Error(
          "TELEGRAM_UAT_VAULT_PASSPHRASE must be set in env (see uat/SETUP.md).",
        );
      }
      const sc = await spinUp({ agent: "test-harness" });
      try {
        // 1. Tell the agent to fire TWO vault_request_access calls
        //    in the same turn for two distinct keys. The natural way
        //    to express this is one prompt that describes both
        //    needs; the agent then makes both tool calls.
        await sc.sendDM(
          `Please call your vault_request_access MCP tool TWICE — ` +
          `once for key="${KEY_A}" and once for key="${KEY_B}" — ` +
          `both scope="read", both reason="UAT for #1051 concurrent". ` +
          `Then attempt to read BOTH keys via switchroom vault get and ` +
          `print the values in your reply.`,
        );

        // 2. Wait for the FIRST approval card.
        const cardA = await sc.expectMessage(
          new RegExp(`🔐.*wants vault access[\\s\\S]*${KEY_A.replace("/", "\\/")}`),
          { from: "bot", timeout: 90_000 },
        );
        const cardB = await sc.expectMessage(
          new RegExp(`🔐.*wants vault access[\\s\\S]*${KEY_B.replace("/", "\\/")}`),
          { from: "bot", timeout: 30_000 },
        );

        // 3. Tap Approve on card A.
        const kbA = await sc.driver.getKeyboard(sc.botUserId, cardA.messageId);
        const approveA = kbA!
          .flat()
          .find((b) => b.callbackData !== undefined && /approve/i.test(b.text));
        expect(approveA).toBeDefined();
        await sc.driver.pressButton(sc.botUserId, cardA.messageId, approveA!.callbackData!);

        // Wait for the passphrase prompt on card A.
        await sc.expectMessage(/Vault is locked.*Reply with your passphrase/, {
          from: "bot",
          timeout: 15_000,
        });

        // 4. Tap Approve on card B BEFORE typing the passphrase.
        //    This exercises the pending-op queueing path (bug B).
        //    The card should edit to "Queued behind an earlier card."
        const kbB = await sc.driver.getKeyboard(sc.botUserId, cardB.messageId);
        const approveB = kbB!
          .flat()
          .find((b) => b.callbackData !== undefined && /approve/i.test(b.text));
        expect(approveB).toBeDefined();
        await sc.driver.pressButton(sc.botUserId, cardB.messageId, approveB!.callbackData!);
        await sc.expectMessage(/Queued behind an earlier card|Queued.*one passphrase/i, {
          from: "bot",
          timeout: 15_000,
        });

        // 5. Send passphrase. Gateway drains the queue, mints a
        //    unioned grant for {KEY_A, KEY_B}, writes a single
        //    .vault-token. BOTH cards edit to "Granted".
        await sc.sendDM(passphrase);
        await sc.expectMessage(new RegExp(`Granted[\\s\\S]*${KEY_A.replace("/", "\\/")}`), {
          from: "bot",
          timeout: 30_000,
        });
        await sc.expectMessage(new RegExp(`Granted[\\s\\S]*${KEY_B.replace("/", "\\/")}`), {
          from: "bot",
          timeout: 30_000,
        });

        // 6. Ask the agent to read BOTH keys. The load-bearing
        //    assertion: pre-fix, the agent could only read ONE
        //    (.vault-token had been overwritten with the second
        //    grant's token, which only covered KEY_B). Post-fix,
        //    the agent has a single token whose grant covers
        //    BOTH keys, so BOTH gets succeed.
        await sc.sendDM(
          `Now run: switchroom vault get ${KEY_A} && switchroom vault get ${KEY_B} ` +
          `— and paste the output verbatim. Include any error markers if either fails.`,
        );
        const finalReply = await sc.expectMessage(
          new RegExp(SENTINEL_A),
          { from: "bot", timeout: 90_000 },
        );
        expect(
          finalReply.text,
          `agent must read KEY_A — pre-fix this was the SECOND grant's key and would have succeeded; the union now covers it`,
        ).toContain(SENTINEL_A);
        expect(
          finalReply.text,
          `agent must read KEY_B — pre-fix this would have FAILED with VAULT-BROKER-DENIED because .vault-token was overwritten`,
        ).toContain(SENTINEL_B);
        expect(
          finalReply.text,
          `neither key should denied`,
        ).not.toMatch(/VAULT-BROKER-DENIED/);
      } finally {
        await sc.tearDown();
      }
    },
    420_000, // 7 min — covers two cards rendering + two approves +
             //         passphrase round-trip + drain queue + two
             //         mints + two vault gets.
  );
});
