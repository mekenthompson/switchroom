---
status: rfc — draft, awaiting sign-off
serves: `know-what-my-agent-is-doing.md`
supersedes: nothing (extends `reference/status-card-design.md` with TDD verification)
relates: #709 #776 #782 #788 #64 #757
---

# Sub-agent visibility — TDD verification + design RFC

## TL;DR

Four open issues (#709, #776, #782, #788) all report the same UX failure: a user dispatches background work, the parent turn replies in seconds, the pinned progress card unpins, the background worker runs invisibly for minutes, the user types "status?". The recurrence log spans 2026-04-21 → 2026-05-07 across at least three agents (clerk, klanker, finn).

The design exists (`reference/status-card-design.md` v2). The implementation is *mostly* in place: two-zone renderer, fleet-state with `isBackgroundDispatch`, `hasLiveBackground` defer-gate. But no UAT scenario exercises the background-dispatch path end-to-end against real Telegram, so we have no idea whether the design's promises actually hold.

This RFC proposes:

1. **TDD-first.** Write the failing UAT scenarios that pin the JTBD's named acceptance criteria (§AC below). Run them. The 2026-05-07 "status?" incident is the failure they encode.
2. **Diagnose only what fails.** If a scenario passes, the corresponding issue is stale and can close.
3. **Fix gap-by-gap with the scenario as the regression test.** No speculative refactor.

## The job we're failing

From `reference/know-what-my-agent-is-doing.md`:

> Sub-agent work is visible in the same place as parent work — including
> background sub-agents that outlive the turn that spawned them. The user
> never has to hunt for it, and never loses sight of a background member
> just because the parent turn replied (the #64 fix).

The JTBD's "Status-ask rate" anti-signal is explicit:

> The user never feels the need to ask "status?", "what are you doing?",
> "still there?", "any update?". If they do, the product is failing at
> its core job. Any time this happens it is a product-defect signal, not
> a feature request, and it should be captured as one.

The recurrence log on #709 / #776 / #788 is exactly that signal firing
three+ times in two weeks. Resolving the issues = driving that count to
zero with a regression-locked test.

## The four issues collapsed

| Issue | Headline | Symptom |
|---|---|---|
| #709 | "Background sub-agents have no progress card — turn-scoped pin lifecycle drops them" | Pin unpins at parent `turn_end`; bg worker runs silently for 17 min. |
| #776 | "RCA: progress card silent during background sub-agent work, user forced to ask 'status?'" | Card pinned but fleet zone doesn't update with bg worker's tool calls. |
| #782 | "RCA: progress surface silent during background `Agent` runs" | Two parallel `Agent(run_in_background: true)` dispatches; no visible surface between dispatch and completion. |
| #788 | "RCA: background sub-agents have no trackable status card surface" | ~30 min of background work, no per-step visibility. |

One root cause family, four symptom reports. Treat as one epic.

## Current implementation survey

What's already wired (verified by reading on `main` 2026-05-12):

- `telegram-plugin/fleet-state.ts` — `FleetMember` with `isBackgroundDispatch` flag (line 48). `hasLiveBackground(fleet)` predicate.
- `telegram-plugin/progress-card-driver.ts:1855,1921` — driver registers fleet members on `sub_agent_started`, derives bg flag from parent's `Agent` tool_use args (`run_in_background: true` → `cs.backgroundParentToolUseIds` correlation).
- `telegram-plugin/progress-card-driver.ts:1108` — deferred-completion gate: `if (hasLiveBackground(cs.fleet)) return`. Card stays pinned past parent `turn_end`.
- `telegram-plugin/two-zone-card.ts` — fleet zone renders every member (cap 5 + "N more"). Header phase resolver yields 🌀 Background when parent done + fleet still running (PR #1039).
- `telegram-plugin/subagent-watcher.ts` — 1Hz JSONL polling, drives `sub_agent_tool_use` → fleet member's `lastTool`/`lastActivityAt` updates.
- Heartbeat re-flushes the card every N seconds while live, so the elapsed counter ticks.

What's NOT wired (the missing piece this RFC closes):

- **End-to-end test against real Telegram exists for *foreground* card lifecycle only** (`progress-card-dm.test.ts`). Nothing exercises:
  - background dispatch + continue (JTBD UAT prompt #8)
  - heavy fleet 6+ parallel (UAT prompt #9)
  - stuck detection (UAT prompt #10)
  - done-semantics with bg still running (UAT prompt #11)

Without those scenarios, the design's correctness is theoretical. The 2026-05-07 incident is evidence that *something* in the chain still doesn't deliver — but without a repro, we'd be guessing which gap.

## Acceptance criteria (from `status-card-design.md` + JTBD)

Numbered ACs — each maps 1:1 to a UAT scenario in §Scenarios:

- **AC-1** — *Background-dispatch-and-continue.* Operator sends a DM that causes the agent to dispatch a background sub-agent. Parent replies; parent `turn_end` fires. The pinned progress card MUST stay pinned for at least 30 s past parent reply, with the fleet zone showing the running bg sub-agent (id6 chip + activity).

- **AC-2** — *Done semantics.* While the bg sub-agent runs (status = `background`), the header MUST render as 🌀 Background, never ✅ Done. After the bg sub-agent terminates (`sub_agent_turn_end`), the header MUST flip to ✅ Done.

- **AC-3** — *Live activity.* While the bg sub-agent is running, the card edits MUST land at ≥ 1 edit per 30 s wall-clock as the worker fires tools — i.e. the elapsed counter visibly advances and the fleet row's `last activity` age stays fresh.

- **AC-4** — *Stuck escalation.* If a fleet member emits no JSONL event for > 60 s, its row glyph flips from ↻ to ⚠ with label `idle <duration>`. If every running member is stuck, header escalates to ⚠ Stalled. Any subsequent JSONL event de-escalates.

- **AC-5** — *Heavy fleet HTML safety.* 6+ parallel sub-agents — render output is balanced HTML, < 4096 bytes, fleet zone caps at 5 rows + `+ N more`. No `<blockquote>` 400 in the gateway log.

- **AC-6** — *Originating-turn pinning.* If a new parent turn starts while a bg sub-agent from the prior turn is still running, the prior turn's card stays pinned and live-updating. The new turn gets its own card. Cards do not get cross-wired.

## TDD plan

### Phase 1 — write failing scenarios

Create `telegram-plugin/uat/scenarios/bg-sub-agent-dispatch-dm.test.ts` (AC-1 + AC-2 + AC-3 in one scenario, since they share setup).

```ts
describe("uat: background sub-agent stays visible on parent card", () => {
  it(
    "parent dispatches bg Agent, replies, card stays pinned with fleet activity for ≥30s",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        // Prompt that reliably triggers the Agent tool with
        // run_in_background:true. The prompt is the load-bearing
        // contract for this test: it must produce a measurable
        // background dispatch every time.
        //
        // See §"Background-dispatch prompt" below for the exact
        // wording and why it works.
        await sc.sendDM(BG_DISPATCH_PROMPT);

        // AC-1: card pinned within 5s of inbound.
        const card = await sc.expectPinnedCard({ timeout: 10_000 });
        expect(card.messageId).toBeGreaterThan(0);

        // Parent reply arrives quickly — usually before the bg worker
        // does anything. We wait for it as a signal that parent
        // turn_end fired (i.e. without the defer-gate, the card
        // WOULD unpin here).
        await sc.expectMessage(/dispatch|background|started/i, {
          from: "bot",
          timeout: 30_000,
        });

        // AC-2: header is 🌀 Background, NOT ✅ Done, while bg runs.
        // Poll for up to 30 s; assert we observe the Background phase
        // at least once and never observe Done while bg is in flight.
        const bgObserved = await sc.waitForCardPhase(card, "working", {
          timeout: 30_000,
        });
        // (waitForCardPhase needs a 'background' or generic-non-done
        // mode — see §"Phase observation widening" below for the
        // assertions.ts change this requires.)
        expect(bgObserved.text).toMatch(/🌀|Background/);
        expect(bgObserved.text).not.toMatch(/✅|Done/);

        // AC-3: card edits land regularly while bg runs. Snapshot the
        // card body twice with a 15s gap; the elapsed counter or
        // fleet `last activity` age MUST differ — i.e. the card is
        // *being updated*, not just sitting there.
        const t1 = await sc.expectPinnedCard({ timeout: 5_000 });
        await new Promise((r) => setTimeout(r, 15_000));
        const t2 = await sc.expectPinnedCard({ timeout: 5_000 });
        expect(t2.text).not.toBe(t1.text);

        // Final: bg completes and header flips to ✅ Done.
        const done = await sc.waitForCardPhase(card, "done", {
          timeout: 120_000,
        });
        expect(done.text).toMatch(/✅|Done/);
      } finally {
        await sc.tearDown();
      }
    },
    180_000, // 30s settle + 30s bg-dispatch + 30s observation + 120s bg-finish + slack
  );
});
```

### Phase 2 — run + diagnose

For each AC that fails, file a sub-issue with the exact failure mode. The scenario's failure message identifies which AC tripped, which means each diagnosis is bounded:

- `expectPinnedCard` timeout → card never pinned → look at pin manager + delay_ms
- `expectMessage` timeout → bot didn't reply at all → look at MCP/gateway/agent
- Phase observation shows `Done` while bg should be running → defer-gate bug → look at `hasLiveBackground` correlation
- `t2.text === t1.text` → card not being re-edited → look at heartbeat + subagent-watcher
- Final `waitForCardPhase("done")` timeout → defer-gate never released → look at terminal-state propagation

### Phase 3 — heavy-fleet + stuck scenarios

Once AC-1/2/3 are green, add:

- `bg-heavy-fleet-dm.test.ts` (AC-5) — prompt spawns 6+ parallel sub-agents, scrape rendered HTML, assert balanced tags + size cap + "N more" footer.
- `bg-stuck-detection-dm.test.ts` (AC-4) — prompt spawns a sub-agent that does one tool call then sleeps > 60 s. Assert row glyph flips to ⚠ within 90 s.

### Phase 4 — close stale issues

When each AC has a green scenario locked in:
- #709, #776, #782, #788 close as "verified by `bg-sub-agent-dispatch-dm.test.ts` covering AC-1/2/3" + the linked test.

## Background-dispatch prompt (load-bearing contract)

The scenarios need a DM prompt that reliably gets `test-harness` to call the `Agent` tool with `run_in_background: true`. Options ranked:

1. **Direct instruction (recommended).**
   ```
   Use the Agent tool with subagent_type "general-purpose" and
   run_in_background: true to dispatch a worker that: runs `sleep 2`
   then `sleep 3` then `sleep 5`, then writes "done" to /tmp/bg-uat-${ts}.txt.
   Reply briefly that you've dispatched the worker.
   ```
   Pros: deterministic, sub-agent emits 3 visible tool calls over ~10 s.
   Cons: prompt is meta — agent is being told to use a specific tool.

2. **Naturalistic task that should obviously delegate.**
   ```
   Spawn a background worker that takes about 60 seconds to count
   from 1 to 30 (use sleep + echo). I want to see the worker
   progressing on the status card.
   ```
   Pros: closer to real-user phrasing.
   Cons: less deterministic. Models sometimes inline the sleeps in the parent.

Use option 1. The test is asserting that *the visibility infra works*, not that the LLM is good at choosing to delegate. The prompt's job is to set up the scenario reliably; the LLM's job is just to obey it.

## Phase observation widening

`assertions.ts:waitForCardPhase` today knows: `"boot" | "working" | "done" | "error"`. To assert AC-2 we want either:

- a new phase `"background"` recognising 🌀 Background header, OR
- a non-equality variant `waitForCardPhaseNot('done')`.

The cleaner shape is the new phase. `detectPhase` in `assertions.ts` would gain a regex branch matching `/🌀|⏸/ Background/`. ~5 LOC.

## Risks + open questions

- **Test-harness model nondeterminism.** Even option 1 of the dispatch prompt depends on the LLM following instructions. Mitigation: the prompt is direct enough that model failure (no dispatch at all) shows up as `expectMessage(/dispatch.../) timeout` — clearly distinguishable from infra failure (`expectPinnedCard` timeout, fleet not updating, etc).
- **Concurrent sub-agent JSONL paths.** When Claude Code spawns a background `Agent`, *where* does its JSONL land? Need to verify `subagent-watcher` polls the right directory. This is a known-but-unverified contract; the scenario surfaces it as a side-effect.
- **Heartbeat cadence vs UAT poll cadence.** `expectPinnedCard` polls pin updates at the driver's MTProto cadence; the heartbeat flushes at e.g. 5 s. A 15 s gap between snapshots is generous enough not to flake.
- **No isolation between scenarios** until #866 Phase 2b. The bg-scenario could leak state into the next run. Mitigation: existing `spinUp` settle (8 s) + unpin path from #1031 handles this.

## What this RFC does NOT decide

- Whether to extract bg-sub-agent rendering into a separate card (the alternative shape mentioned in #788's "per-agent cards" branches). The status-card v2 spec deliberately rejects that — same card, fleet zone — and there's no evidence yet that the shared-card design is the problem.
- Whether to add a Telegram-side "tap to see worker output" affordance. Nice-to-have; not in scope until AC-1..6 are green.
- Whether to surface bg sub-agent activity in chat (e.g. as periodic "still working: X done so far" messages). The JTBD explicitly anti-patterns "narrating every tool call as a new chat message" — card-zone surface is correct.

## Sequencing

| Step | Cost | Owner | Gate |
|---|---|---|---|
| 1. Add `"background"` phase to `assertions.ts:detectPhase`. | ~10 LOC. | — | unit test in `tests/uat-assertions.test.ts`. |
| 2. Write `bg-sub-agent-dispatch-dm.test.ts` (AC-1/2/3). | ~150 LOC. | — | runs against real Telegram. |
| 3. Run it. Diagnose first failure (if any). | variable | — | passing scenario. |
| 4. Iterate fix → re-run scenario until green. | variable | — | scenario green 3 runs in a row (cross-scenario settling). |
| 5. Write `bg-heavy-fleet-dm.test.ts` (AC-5). | ~80 LOC. | — | scenario green. |
| 6. Write `bg-stuck-detection-dm.test.ts` (AC-4). | ~100 LOC. | — | scenario green. |
| 7. Close #709 / #776 / #782 / #788 with links to the scenarios. | — | — | — |

## Why this beats "just open a PR"

Without the UAT scenarios as regression gates, the next refactor to `progress-card-driver.ts` will silently re-introduce one of these failures. The 2026-05-05 occurrence specifically post-dated PR #720 (which claimed to close #709). The fix without the regression test is a 50/50 bet.

TDD inverts that: red test → minimum diff to green → test locks the contract. The 2026-05-07 incident is the test we never wrote.
