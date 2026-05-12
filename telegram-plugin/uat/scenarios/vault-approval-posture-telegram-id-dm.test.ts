/**
 * UAT scenario for #1115 — `vault.broker.approvalAuth: telegram-id`
 * single-factor approve path.
 *
 * **What this exercises that unit tests cannot.** The schema test, the
 * resolver fuzz, and the source-text contracts all live inside the
 * gateway process. They prove the wiring is shaped right. They do NOT
 * prove that:
 *   - the *live* Telegram callback for the Approve button is routed
 *     to `handleVaultRequestAccessCallback`,
 *   - the gateway-cached `AUTO_UNLOCK_PASSPHRASE` is what the broker
 *     actually accepts,
 *   - the broker mints a real grant token end-to-end with no
 *     passphrase prompt visible in chat,
 *   - the success card carries the single-factor footer
 *     (`Approver verified by Telegram identity`).
 *
 * This scenario closes that gap by round-tripping a real Telegram tap
 * against a real broker on a host configured with
 * `vault.broker.approvalAuth: telegram-id`.
 *
 * Sibling: `vault-request-access-end-to-end-dm.test.ts` exercises the
 * same agent-initiated path under the DEFAULT `passphrase` posture
 * (two-factor). The two scenarios together pin both rungs of the
 * posture matrix.
 *
 * **Skipped by default.** To unskip:
 *
 * 1. Standard UAT preflight (`uat/SETUP.md` §5-6) — test-harness agent
 *    live, driver session auth'd, env vars set.
 *
 * 2. **Host posture flipped to single-factor.** Edit `switchroom.yaml`:
 *
 *      vault:
 *        broker:
 *          autoUnlock: true
 *          approvalAuth: telegram-id
 *
 *    Then `switchroom update` (or `apply` + restart gateway). The
 *    scenario refuses to run if `switchroom doctor` reports the
 *    passphrase posture — running it under passphrase mode would
 *    block on a passphrase prompt the scenario doesn't send.
 *
 * 3. **Sacrificial vault key.** Same convention as the sibling:
 *
 *      TMPF=$(mktemp) && printf '%s' 'sentinel-1115-value' > "$TMPF" && \
 *        switchroom vault set uat/req-access-target-tid --file "$TMPF" \
 *          --format string ; shred -u "$TMPF"
 *
 * 4. Remove `describe.skip` below.
 *
 * Why skipped: (a) mutates host vault state (mints a 30-day grant on
 * test-harness), (b) requires the operator to flip the live posture
 * — opt-in only. Cleanup is operator-side
 * (`switchroom vault revoke <grant-id>` after the run, then revert
 * the posture if desired).
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const SENTINEL_VALUE = "sentinel-1115-value";
const TARGET_KEY = "uat/req-access-target-tid";

describe.skip("uat: vault_request_access — telegram-id (single-factor) posture (#1115)", () => {
  it(
    "agent calls tool → operator taps Approve → silent mint, no passphrase prompt, single-factor footer present",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        // 1. Trigger the agent-side MCP tool call. The agent's reply
        //    is what emits the approval card.
        await sc.sendDM(
          `Please call your vault_request_access MCP tool with ` +
          `key="${TARGET_KEY}", scope="read", reason="UAT regression for #1115 ` +
          `(telegram-id single-factor posture)". Then attempt to read the key ` +
          `once the operator confirms.`,
        );

        // 2. Wait for the bot's approval card. Anchor on the headline
        //    emoji + tool-specific copy — same as the passphrase
        //    sibling scenario, since the card itself is identical
        //    regardless of posture (it's the Approve-tap behaviour
        //    that diverges).
        const card = await sc.expectMessage(/🔐.*wants vault access/, {
          from: "bot",
          timeout: 60_000,
        });

        // 3. Confirm the inline keyboard has the Approve button and
        //    locate its callback_data.
        const kb = await sc.driver.getKeyboard(sc.botUserId, card.messageId);
        expect(kb).not.toBeNull();
        const approveButton = kb!
          .flat()
          .find((b) => b.callbackData !== undefined && /approve/i.test(b.text));
        expect(approveButton, "card should have an [✅ Approve] button").toBeDefined();

        // 4. Tap Approve. Under `telegram-id` posture this MUST take
        //    us straight to the "Approved by @ … — minting…" state —
        //    no passphrase prompt should appear at any point.
        await sc.driver.pressButton(
          sc.botUserId,
          card.messageId,
          approveButton!.callbackData!,
        );

        // 5. Expect the immediate "minting" edit (with operator
        //    @username) — the load-bearing UX signal that the
        //    passphrase prompt was skipped.
        await sc.expectMessage(/Approved by @.*minting/i, {
          from: "bot",
          timeout: 15_000,
        });

        // 6. Expect the success card with the SINGLE-FACTOR footer —
        //    `performVaultAccessApproval` annotates the card with
        //    "Approver verified by Telegram identity (broker
        //    auto-unlocked at startup)" only under telegram-id mode.
        //    If posture flipped silently to passphrase between steps
        //    1 and 5, the footer wouldn't say this and the regex
        //    misses → the scenario fails with a posture-state
        //    diagnosis.
        const granted = await sc.expectMessage(
          /Granted.*read access[\s\S]*Approver verified by Telegram identity/i,
          { from: "bot", timeout: 30_000 },
        );
        expect(granted.text).toMatch(/broker auto-unlocked at startup/i);

        // 7. **Negative invariant** — *implicit*. The scenario sends
        //    no passphrase between steps 4 (tap) and 6 (Granted). If
        //    the gateway had actually fallen back to the passphrase
        //    branch (`Reply with your passphrase` prompt), the flow
        //    would stall waiting for an operator reply and the
        //    `expectMessage(/Granted .../)` in step 6 would time out.
        //    The single-factor-footer regex in step 6 is the
        //    explicit positive gate that we landed in the
        //    telegram-id branch and not, say, an unlocked-cache
        //    shortcut.

        // 8. Load-bearing functional assertion: the freshly-minted
        //    grant actually works. Mirrors the sibling scenario's
        //    final assertion so a future regression that breaks
        //    the token-write path is caught here too.
        await sc.sendDM(
          `Now run: switchroom vault get ${TARGET_KEY} — and tell me ` +
          `exactly what the command printed (including any error markers).`,
        );
        const replyAfterGet = await sc.expectMessage(
          new RegExp(SENTINEL_VALUE),
          { from: "bot", timeout: 60_000 },
        );
        expect(replyAfterGet.text).toContain(SENTINEL_VALUE);
        expect(replyAfterGet.text).not.toMatch(/VAULT-BROKER-DENIED/);
      } finally {
        await sc.tearDown();
      }
    },
    300_000,
  );

  it(
    "doctor reports the single-factor posture so operators can verify the host before merging",
    async () => {
      // This second-tier check exists to flush out the failure mode
      // where the YAML lands `approvalAuth: telegram-id` but the
      // gateway either didn't reload or the schema-validation gate
      // silently rejected it. Without this check, scenario 1 still
      // passes when the gateway has reverted to passphrase posture
      // (the operator would just be looking at a separate gateway
      // process state and we'd never know).
      const sc = await spinUp({ agent: "test-harness" });
      try {
        await sc.sendDM(
          `Run: switchroom doctor — and quote exactly the line containing ` +
          `"Approval auth:".`,
        );
        const doctorReply = await sc.expectMessage(
          /Approval auth:\s*telegram-id/i,
          { from: "bot", timeout: 60_000 },
        );
        expect(doctorReply.text).toMatch(
          /single-factor.*Telegram account security/i,
        );
      } finally {
        await sc.tearDown();
      }
    },
    120_000,
  );
});
