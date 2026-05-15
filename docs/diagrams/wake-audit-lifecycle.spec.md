# wake-audit-lifecycle — diagram spec

Status: needs-revision
(The committed `wake-audit-lifecycle.jpg` collapses ≥4 distinct boot
mechanisms into one box labelled "start.sh sources env · SWITCHROOM_PENDING_*".
That misrepresents the current boot. Regenerate to this spec.)

Source of truth in code:
- `profiles/_base/start.sh.hbs:253` ("Session resume policy") — `SWITCHROOM_RESUME_MODE`: handoff default / auto / continue / none
- `profiles/_base/start.sh.hbs:322` ("Session-mode signal") — `SWITCHROOM_SESSION_MODE` (continue|handoff|fresh|cold) for the greeting panel
- `profiles/_base/start.sh.hbs:349` ("Pending-turn signal") — `.pending-turn.env` → `SWITCHROOM_PENDING_TURN` (sourced + `rm`, fires once)
- `profiles/_base/start.sh.hbs:375` ("Wake audit sentinel") — `.wake-audit-pending` written every boot into `$TELEGRAM_STATE_DIR`
- `profiles/_base/start.sh.hbs:402` ("Session handoff briefing") — handoff merge into `--append-system-prompt` (handoff-briefing.sh invoked at `:432-434`)
- `src/cli/handoff.ts` + `src/agents/handoff-summarizer.ts` — Stop-hook `.handoff.md` (LLM session summary)
- `handoff-briefing.sh` — `.handoff-briefing.md` (live: Telegram tail + Hindsight recall + today's daily memory)
- `skills/switchroom-runtime/SKILL.md:83-118` — the 3-signal check + `.wake-audit-last-completed` conversation-aware dedup (name-referenced at `start.sh.hbs:396`)

Headline: "Things die. Switchroom comes back, with receipts." (unchanged)
Footer:   "Guardrail against silent dropped work — fires less than once a week on a healthy system." (unchanged)

## Nodes

1. `Crash or kill` · watchdog · SIGTERM · timeout · OOM · cord
2. `Fresh boot` · start.sh · (default `handoff` mode → no `--continue`) · brass
3. `Boot inputs` — render as three small stacked sub-cards feeding box 4, NOT one env line:
   - 3a `SWITCHROOM_PENDING_TURN` · prior turn was in flight at kill (ended_via=restart/sigterm/timeout); consumed once
   - 3b `.wake-audit-pending` sentinel · written *every* boot; durable file, survives N deferred turns
   - 3c handoff briefing · `.handoff.md` (Stop-hook LLM summary) and/or `.handoff-briefing.md` (live-assembled); merged into `--append-system-prompt`
4. `Wake audit` · 3-signal check: owed reply? · orphan sub-agent? · open todo? · brass
5a. `All clean` · no owed replies · no orphans · stay silent · teal
5b. `Found work` · owed reply / orphan sub-agent → surface and ask · cord
6. `First turn acknowledges` · (a) start over · (b) summarize and continue · (c) drop · brass

## Edges

- 1 → 2 → 4 · primary-flow
- 3a, 3b, 3c → 4 · "feeds" · leader (three inputs converge on the audit)
- 4 → 5a · primary-flow ; 4 → 5b · primary-flow
- 5a → 6 ; 5b → 6 · primary-flow
- Note callout: 3b complements 3a — sentinel also catches long silent
  restarts, watchdog-killed sub-agents, and messages that landed while
  the gateway was down (`start.sh.hbs:382-386`).

## Style notes

Inherits v3. The change vs the current JPG is structural: split the old
single "boot env" box into the 3a/3b/3c input stack and add the handoff
branch (absent today). Keep the 5-card left-to-right rhythm and rotations.
