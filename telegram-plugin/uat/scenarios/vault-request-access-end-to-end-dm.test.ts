/**
 * End-to-end UAT scenario for the agent-initiated vault_request_access
 * flow — closes the test-coverage gap that allowed #1053 to ship.
 *
 * #1053: an agent called `vault_request_access`, operator approved,
 * passphrase was entered, broker minted a grant token and wrote it
 * to `.vault-token` — BUT the agent's subsequent `vault get` still
 * returned VAULT-BROKER-DENIED because the CLI's get path didn't
 * forward the token. Every unit test passed (gateway, broker, CLI
 * each looked right in isolation) but the integration was broken.
 *
 * The lesson the operator drew: "test and prevent these kinds of
 * things using the full telegram test bot." This scenario is that
 * test — it round-trips through real Telegram, real broker, real
 * agent, asserting the final state (vault get succeeds) rather
 * than any single component's contract.
 *
 * Sibling: `vault-audit-allow-dm.test.ts` exercises the OPERATOR-
 * initiated path (operator opens /vault audit, taps Allow on a
 * recent denial). This scenario exercises the AGENT-initiated path
 * (agent calls vault_request_access, operator approves the card
 * the agent's tool emitted) — a different gateway handler
 * (handleVaultRequestAccessCallback vs handleVaultRecentDenialCallback)
 * but the same broker token-writing + grant-validation backend.
 *
 * **Skipped by default.** To unskip:
 *
 * 1. Standard UAT preflight (`uat/SETUP.md` §5-6) — test-harness
 *    agent live, driver session auth'd, env vars set.
 *
 * 2. **Operator passphrase visibility.** The scenario must enter
 *    the operator's vault passphrase in chat as part of the
 *    approve flow. Set `TELEGRAM_UAT_VAULT_PASSPHRASE` in the
 *    env so the scenario can send it. The gateway deletes the
 *    passphrase message from chat history immediately after
 *    caching it (see `deleteSensitiveMessage` in gateway.ts) so
 *    no plaintext lingers.
 *
 * 3. **Sacrificial vault key.** Same convention as the
 *    `/vault audit` scenario — pre-create a key the harness can
 *    request. Suggested:
 *
 *    ```bash
 *    TMPF=$(mktemp) && printf '%s' 'sentinel-1053-value' > "$TMPF" && \
 *      switchroom vault set uat/req-access-target --file "$TMPF" \
 *        --format string ; shred -u "$TMPF"
 *    ```
 *
 *    Slash-namespaced shape on purpose — also exercises #1047
 *    (vault-key regex allowing '/').
 *
 * 4. Remove `describe.skip` below.
 *
 * Why skipped: mutates host vault state (mints a 30-day grant on
 * test-harness) — opt-in only. Cleanup is operator-side
 * (`switchroom vault revoke <grant-id>` after the run).
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const SENTINEL_VALUE = "sentinel-1053-value";
const TARGET_KEY = "uat/req-access-target";

describe.skip("uat: vault_request_access end-to-end (#1053 regression)", () => {
  it(
    "agent calls tool → operator approves + enters passphrase → agent reads the value",
    async () => {
      const operatorPassphrase = process.env.TELEGRAM_UAT_VAULT_PASSPHRASE;
      if (!operatorPassphrase) {
        throw new Error(
          "TELEGRAM_UAT_VAULT_PASSPHRASE must be set in env for this scenario " +
          "(see SETUP.md). The scenario sends it via DM as part of the approve " +
          "flow; the gateway deletes the message immediately after caching.",
        );
      }
      const sc = await spinUp({ agent: "test-harness" });
      try {
        // 1. Tell the agent to call the MCP tool. The agent's reply
        //    is what fires the approval card — we don't fire it
        //    from the driver side because the WHOLE POINT is to
        //    cover the agent → gateway → broker → token-file
        //    → agent path.
        await sc.sendDM(
          `Please call your vault_request_access MCP tool with ` +
          `key="${TARGET_KEY}", scope="read", reason="UAT regression for #1053". ` +
          `Then attempt to read the key once the operator confirms.`,
        );

        // 2. Wait for the bot's approval card. Anchor on the
        //    headline emoji + tool-specific copy.
        const card = await sc.expectMessage(/🔐.*wants vault access/, {
          from: "bot",
          timeout: 60_000,
        });

        // 3. Confirm the card carries the right inline keyboard.
        //    Locate the [✅ Approve] button.
        const kb = await sc.driver.getKeyboard(sc.botUserId, card.messageId);
        expect(kb).not.toBeNull();
        const approveButton = kb!
          .flat()
          .find((b) => b.callbackData !== undefined && /approve/i.test(b.text));
        expect(approveButton, "card should have an [✅ Approve] button").toBeDefined();

        // 4. Tap Approve. With no cached passphrase yet, the gateway
        //    edits the card to prompt for the passphrase as the
        //    next message (vault_request_access tap-to-unlock flow
        //    from #1012 Phase 2 / #1034).
        await sc.driver.pressButton(
          sc.botUserId,
          card.messageId,
          approveButton!.callbackData!,
        );
        await sc.expectMessage(/Vault is locked.*Reply with your passphrase/, {
          from: "bot",
          timeout: 15_000,
        });

        // 5. Send the passphrase. Gateway caches it, deletes the
        //    chat message via deleteSensitiveMessage, then auto-
        //    resumes the mint flow. Card edits to the "Granted"
        //    state when the broker accepts the attestation.
        await sc.sendDM(operatorPassphrase);
        await sc.expectMessage(/Granted.*read access/, {
          from: "bot",
          timeout: 30_000,
        });

        // 6. THE LOAD-BEARING ASSERTION FOR #1053: ask the agent
        //    to fetch the key. The agent's `switchroom vault get`
        //    MUST forward the freshly-minted token. If it doesn't
        //    (the pre-#1053-fix state), the broker denies on the
        //    peercred ACL and the agent reports VAULT-BROKER-DENIED.
        //    Post-fix: the get succeeds and returns the sentinel
        //    value the operator pre-staged.
        await sc.sendDM(
          `Now run: switchroom vault get ${TARGET_KEY} — and tell me ` +
          `exactly what the command printed (including any error markers).`,
        );
        const replyAfterGet = await sc.expectMessage(
          new RegExp(SENTINEL_VALUE),
          { from: "bot", timeout: 60_000 },
        );
        expect(replyAfterGet.text).toContain(SENTINEL_VALUE);
        // The bot's reply MUST NOT contain the denial marker. This
        // is the regression guard: a future bug that reintroduces
        // the silent token-drop would surface VAULT-BROKER-DENIED
        // alongside the value (or instead of it).
        expect(replyAfterGet.text).not.toMatch(/VAULT-BROKER-DENIED/);
      } finally {
        await sc.tearDown();
      }
    },
    300_000, // 5 min — covers card render + Approve tap + passphrase
             // round-trip + grant mint + agent's next turn + vault get.
  );
});
