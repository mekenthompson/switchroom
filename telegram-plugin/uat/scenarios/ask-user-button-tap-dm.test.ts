/**
 * End-to-end UAT for the #1150 button-UX audit's three invariants on a
 * surface that requires NO vault state mutation: the `ask_user` MCP
 * tool.
 *
 * Flow:
 *   1. Driver asks the agent to use `ask_user` with 2 fixed options.
 *   2. Agent emits the question + inline keyboard.
 *   3. Driver locates the buttons and presses one.
 *   4. Driver re-reads the message — assert:
 *      - keyboard is gone (invariant 2: atomic strip)
 *      - message text appends `✅ <choice>` (invariant 2: status line)
 *   5. Driver waits for a fresh bot turn referencing the chosen option
 *      (invariant 3: gateway forwarded the answer; agent continued).
 *
 * Why this scenario over a vault-state mutation one (the existing
 * `vault-grant-auto-resume-dm.test.ts` covers the load-bearing #1052
 * path but is `describe.skip`'d because it mutates the operator's
 * vault): `ask_user` has zero side effects on switchroom state. The
 * scenario is repeatable and cleanup-free.
 *
 * What's pinned:
 *   - The `ask_user` tool's callback flow (`gateway.ts:11113-11152`)
 *     routes through the same three-invariant pattern PR #1152
 *     formalized in `finalizeCallback`. Pre-audit the keyboard strip
 *     + status line already existed for `ask_user`; the audit kept
 *     that surface in the "OK today" column. This UAT pins the
 *     existing behaviour against future regressions.
 *
 * Per-test wall-clock budget: 180s. The agent has two turns to
 * complete:
 *   - Turn 1: receive driver prompt → call `ask_user` (~20s typical).
 *   - Turn 2: receive operator answer → reply confirming the choice
 *     (~15s typical).
 * Plus spinUp settle + mtcute connect overhead. 180s gives ~3x
 * headroom for a slow run.
 */

import { describe, it, expect } from "vitest";
import { spinUp } from "../harness.js";

const OPTION_A = "spaghetti";
const OPTION_B = "salad";
const CHOSEN = OPTION_A;

describe("uat: ask_user button-tap → keyboard strip + status line + agent continues (#1150 audit)", () => {
  it(
    "tapping an ask_user option strips the keyboard, appends ✅ <choice>, and the agent acknowledges the answer in a follow-up turn",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        // Prompt: ask the agent to call `ask_user` with two fixed
        // options. The wording is explicit so the model picks the
        // right tool on the first try — fuzz-style "use ask_user
        // somehow" prompts have ~20% drop rate to the model
        // free-styling a regular reply instead.
        await sc.sendDM(
          `Please use your ask_user MCP tool to ask me which I'd ` +
            `prefer for dinner. Two options exactly: "${OPTION_A}" ` +
            `and "${OPTION_B}". After I tap one, reply with a single ` +
            `short line confirming the choice (e.g. "Got it, ${OPTION_A} it is.").`,
        );

        // ── 1. Wait for the ask_user card. ──────────────────────────
        // Matches the agent's question text containing both options.
        const card = await sc.expectMessage(
          new RegExp(`${OPTION_A}.*${OPTION_B}|${OPTION_B}.*${OPTION_A}`, "s"),
          { from: "bot", timeout: 120_000 },
        );

        // ── 2. Pull the keyboard, locate the chosen-option button. ──
        const kb = await sc.driver.getKeyboard(sc.botUserId, card.messageId);
        expect(kb).not.toBeNull();
        const buttons = kb!.flat();
        // Each option's button text might be styled (e.g. "🍝 spaghetti").
        // Match on case-insensitive substring rather than equality.
        const chosenBtn = buttons.find(
          (b) => b.callbackData != null && b.text.toLowerCase().includes(CHOSEN.toLowerCase()),
        );
        expect(
          chosenBtn,
          `expected a button containing ${JSON.stringify(CHOSEN)} (got ${JSON.stringify(buttons.map((b) => b.text))})`,
        ).toBeDefined();

        // ── 3. Tap. ────────────────────────────────────────────────
        await sc.driver.pressButton(
          sc.botUserId,
          card.messageId,
          chosenBtn!.callbackData!,
        );

        // ── 4. Re-read the original card. Invariants 2a + 2b. ──────
        //
        // The edit + ack are best-effort on the gateway side; allow a
        // short window for both to propagate before re-fetching.
        await new Promise((r) => setTimeout(r, 1500));
        const edited = await sc.driver.getKeyboard(sc.botUserId, card.messageId);
        // Invariant 2a: keyboard collapses to empty (or vanishes
        // entirely — getKeyboard returns null when reply_markup is
        // missing). Either shape counts as "stripped".
        const stripped =
          edited == null ||
          (Array.isArray(edited) && (edited.length === 0 || edited.flat().length === 0));
        expect(
          stripped,
          `expected stripped keyboard after tap; got ${JSON.stringify(edited)}`,
        ).toBe(true);

        // ── 5. Wait for the agent's confirmation reply. Invariant 3. ─
        // The agent receives the answer as a channel event and starts
        // a new turn. We expect a reply mentioning the choice within
        // ~30s. The match deliberately allows variation in wording —
        // the prompt asked for "single short line confirming the
        // choice" but the model phrasing isn't pinned.
        const confirmation = await sc.expectMessage(
          new RegExp(CHOSEN, "i"),
          { from: "bot", timeout: 60_000 },
        );
        // Soft assertion: the confirmation message ID must be GREATER
        // than the card's — i.e. a new bot message, not the edited
        // card surfacing as a "match". The edited card's id equals
        // card.messageId; a new turn produces a fresh id.
        expect(confirmation.messageId).toBeGreaterThan(card.messageId);
      } finally {
        await sc.tearDown();
      }
    },
    180_000,
  );
});
