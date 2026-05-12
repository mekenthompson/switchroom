/**
 * Issue #1116 — subagent-watcher must not re-fire "✓ Worker done"
 * after the terminal-cleanup grace window elapses.
 *
 * Pre-fix repro (validated by RCA on `clerk` DM, 2026-05-12): once a
 * background sub-agent completed, `cleanupTerminalAgent` ran ~30s
 * later, deleting the agent's filePath from `knownFiles` and its row
 * from `registry`. The JSONL itself stayed on disk, so the next
 * `rescanSubagentDirs` poll rediscovered it, re-registered the agent
 * with `completionNotified=false`, read the terminal `turn_duration`
 * line, and emitted a fresh `✓ Worker done: …` notification. The loop
 * ran indefinitely — operator saw the same 4 sub-agents (30/2/15/105
 * tools) re-announcing completion every ~6 minutes.
 *
 * Post-fix invariant: each completed sub-agent emits exactly ONE
 * `✓ Worker done` notification for the lifetime of the gateway.
 *
 * As a side-benefit, this scenario also catches the original RFC's
 * "raw HTML tags rendered in card text" symptom (Bug C in the RCA):
 * any bot message containing a literal `<b>` / `<i>` / `<code>`
 * substring during the window is flagged. The watcher's own
 * notification path is HTML-correct on `main`, so this assertion is
 * a regression detector — if a future change starts leaking raw
 * tags via a fall-through send site, this scenario goes red.
 *
 * Requires the same env as the other DM scenarios (see SETUP.md §6)
 * and the test-harness override `progress_card.delay_ms: 1000` so a
 * short DM turn actually pins a card (SETUP.md §5).
 *
 * Time budget: the bg sub-agent does three ~20s sleeps (~60s total)
 * + we listen for an extra 75s post-completion (>30s grace +
 * generous rescan slack) to catch a rerun. Sum to ~240s plus settle.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

// Same Option-1 explicit-dispatch prompt as bg-sub-agent-dispatch-dm.test.ts
// — naming the tool + run_in_background flag keeps the model
// deterministic. The inner sleeps are shorter here (3×10s = ~30s
// background phase) so the outer budget stays sane: we only need
// the sub-agent to *complete* once. The duplicate-detection window
// is what makes the test meaningful, not the bg phase duration.
const BG_DISPATCH_PROMPT =
  `Use the Agent tool with subagent_type "general-purpose" and ` +
  `run_in_background: true to dispatch a worker with this exact task: ` +
  `"Run \`sleep 10\` via the Bash tool, then \`echo step1\`, then ` +
  `\`sleep 10\` again, then \`echo step2\`, then \`echo done\`. ` +
  `That's two separate Bash sleeps and three echoes." After ` +
  `dispatching, send a brief reply saying you've kicked off the ` +
  `background worker so I can watch the progress card.`;

const WORKER_DONE_RE = /✓\s*Worker done/;
const RAW_HTML_TAG_RE = /<\/?(b|i|code|pre|strong|em)>/i;

describe("uat: issue #1116 — subagent-watcher does not re-fire Worker done", () => {
  it(
    "emits exactly one ✓ Worker done per bg sub-agent and no raw HTML leaks",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        await sc.sendDM(BG_DISPATCH_PROMPT);

        // Wait for the bg sub-agent to complete — the watcher's
        // `✓ Worker done: …` notification is what we're locking
        // behaviour around. Generous timeout: parent ack + bg sleeps
        // + completion plumbing.
        const firstDone = await sc.expectMessage(WORKER_DONE_RE, {
          from: "bot",
          timeout: 120_000,
        });
        expect(firstDone.text).toMatch(WORKER_DONE_RE);

        // Snapshot bot-side messages observed after the first done.
        // Pre-fix the same notification re-fired every ~30s
        // (TERMINAL_CLEANUP_GRACE_MS + rescan). 75s gives us a
        // comfortable >2 grace windows worth of observation.
        const collected: Array<{ text: string; messageId: number }> = [];
        const observer = sc.driver
          .observeMessages(sc.botUserId)
          [Symbol.asyncIterator]();
        const deadline = Date.now() + 75_000;
        try {
          while (Date.now() < deadline) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            const winner = await Promise.race([
              observer.next(),
              new Promise<{ value?: undefined; done: true }>((resolve) =>
                setTimeout(() => resolve({ done: true }), remaining),
              ),
            ]);
            if (winner.done) break;
            const msg = winner.value;
            if (!msg) continue;
            // Only count bot-sent messages (filter out anything the
            // driver itself echoed in this window).
            if (msg.fromUserId === sc.driverUserId) continue;
            collected.push({ text: msg.text ?? "", messageId: msg.messageId });
          }
        } finally {
          // Closing the iterator unregisters the mtcute listeners.
          await observer.return?.();
        }

        // Invariant 1: no DUPLICATE Worker-done with the same shape
        // as the first one. We compare text rather than message_id
        // because the bug emits FRESH messages (not edits), so each
        // re-fire has a new message_id but identical text.
        const reruns = collected.filter((m) => WORKER_DONE_RE.test(m.text));
        expect(
          reruns,
          `Expected zero re-fires of "Worker done" in the ${75}s post-completion window, got ${reruns.length}: ${JSON.stringify(reruns.slice(0, 4).map((r) => r.text.slice(0, 80)))}`,
        ).toHaveLength(0);

        // Invariant 2: no raw HTML tags in any bot text — including
        // the original `firstDone` notification. Catches Bug C
        // (RCA's third symptom) as a regression detector.
        const allBotTexts = [firstDone.text, ...collected.map((m) => m.text)];
        for (const text of allBotTexts) {
          expect(
            text,
            `Raw HTML tag leaked into bot text: ${text.slice(0, 120)}`,
          ).not.toMatch(RAW_HTML_TAG_RE);
        }
      } finally {
        await sc.tearDown();
      }
    },
    // Outer budget: 120s wait-for-done + 75s observation window +
    // ~12s spinUp settle + slack. Round up.
    240_000,
  );
});
