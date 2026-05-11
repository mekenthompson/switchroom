/**
 * End-to-end UAT scenario for #1052 — agent auto-resumes its task
 * after operator approves a vault_request_access card.
 *
 * Pre-fix: agent fired vault_request_access → ended its turn → operator
 * approved later → grant minted → agent did nothing further until
 * operator messaged again. Operator had to manually nudge the agent
 * to resume work the agent itself had flagged.
 *
 * Fix: gateway injects a synthetic InboundMessage after successful
 * mint (via the existing inject_inbound IPC primitive cron uses).
 * Agent's bridge receives the channel event, starts a new turn, and
 * resumes the task.
 *
 * Load-bearing assertion: after the operator's passphrase reply +
 * "Granted" card edit, the DRIVER sees a NEW bot turn (a substantive
 * reply that uses the just-granted key) WITHOUT the driver sending
 * any further message.
 *
 * **Skipped by default.** To unskip:
 *
 * 1. Standard UAT preflight (`uat/SETUP.md` §5-6).
 * 2. `TELEGRAM_UAT_VAULT_PASSPHRASE` set in env.
 * 3. Pre-create a sacrificial vault key:
 *
 *    ```bash
 *    TMPF=$(mktemp) && printf '%s' 'sentinel-1052-value' > "$TMPF" && \
 *      switchroom vault set uat/auto-resume-key --file "$TMPF" \
 *        --format string ; shred -u "$TMPF"
 *    ```
 *
 * 4. Remove `describe.skip` below.
 *
 * Why skipped: mutates vault state. Cleanup is operator-side post-run.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const KEY = "uat/auto-resume-key";
const SENTINEL = "sentinel-1052-value";

describe.skip("uat: agent auto-resumes after vault grant approval (#1052)", () => {
  it(
    "agent fires card, operator approves, agent emits new turn WITHOUT a nudge",
    async () => {
      const passphrase = process.env.TELEGRAM_UAT_VAULT_PASSPHRASE;
      if (!passphrase) {
        throw new Error(
          "TELEGRAM_UAT_VAULT_PASSPHRASE must be set in env (see uat/SETUP.md).",
        );
      }
      const sc = await spinUp({ agent: "test-harness" });
      try {
        // 1. Ask the agent to fetch the key — it'll hit DENIED first,
        //    fire vault_request_access, then end its turn.
        await sc.sendDM(
          `Please run \`switchroom vault get ${KEY}\`. If you get ` +
          `VAULT-BROKER-DENIED, call your vault_request_access MCP tool ` +
          `for that key (read, 30d, reason "UAT for #1052 auto-resume"), ` +
          `END YOUR TURN cleanly, and when the operator approves you should ` +
          `automatically resume by re-running the vault get and reporting ` +
          `the value.`,
        );

        // 2. Wait for the approval card.
        const card = await sc.expectMessage(/🔐.*wants vault access/, {
          from: "bot",
          timeout: 120_000,
        });
        const kb = await sc.driver.getKeyboard(sc.botUserId, card.messageId);
        const approveButton = kb!
          .flat()
          .find((b) => b.callbackData !== undefined && /approve/i.test(b.text));
        expect(approveButton).toBeDefined();

        // 3. Tap Approve. Triggers passphrase prompt.
        await sc.driver.pressButton(sc.botUserId, card.messageId, approveButton!.callbackData!);
        await sc.expectMessage(/Vault is locked.*Reply with your passphrase/, {
          from: "bot",
          timeout: 15_000,
        });

        // 4. Send passphrase. Card edits to "Granted ...".
        const lastDriverMsg = await sc.sendDM(passphrase);
        const lastDriverMsgId = lastDriverMsg.messageId;
        await sc.expectMessage(/Granted.*read access/, {
          from: "bot",
          timeout: 30_000,
        });

        // 5. THE LOAD-BEARING #1052 ASSERTION: the agent should
        //    auto-resume WITHOUT the driver sending another message.
        //    We wait for a substantive bot reply containing the
        //    sentinel value, OR matching the auto-resume channel
        //    source marker the gateway stamps.
        //
        //    Pre-fix: this assertion times out (no synthetic
        //    injection → agent's bridge never received a new turn
        //    → agent stayed idle).
        //
        //    Post-fix: the gateway's ipcServer.sendToAgent fires a
        //    synthetic inbound with meta.source="vault_grant_approved".
        //    The agent's bridge starts a new turn, re-runs vault get,
        //    and reports the value.
        const autoResumeReply = await sc.expectMessage(
          new RegExp(SENTINEL),
          { from: "bot", timeout: 180_000 },
        );
        expect(autoResumeReply.text).toContain(SENTINEL);
        expect(
          autoResumeReply.messageId,
          "auto-resume reply must be a NEW message, not the granted-card edit",
        ).toBeGreaterThan(lastDriverMsgId);
      } finally {
        await sc.tearDown();
      }
    },
    420_000,
  );
});
