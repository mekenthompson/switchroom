# Skill-coverage harness — live-run runbook

How to take the harness landed in #1216 from "passes unit tests" to "produces a checked-in scorecard against a real agent."

The harness lives in `tests/skill-coverage/`. The audit + inventory in this directory are the spec; the runbook is the operator's how-to.

## Prereqs

1. A switchroom agent container is **running** and you have host-side read access to its bind mounts:
   - gateway socket at `~/.switchroom/agents/<name>/telegram/gateway.sock`
   - session JSONL dir at `~/.claude/projects/<name>/` (host-side mirror of `/state/.claude/` inside the agent)
2. The harness corpus is current — regenerate after any edit to `fixtures/skills.json`:
   ```bash
   bun tests/skill-coverage/corpus/generate-corpus.ts --seed=1
   ```
3. The agent should be **idle** when you start. The harness queues probes sequentially and waits for `turn_end` between each; if the agent is mid-turn from a user message, the first observed `turn_end` will be that turn, not yours.

## Cost / blast-radius warning

Each probe is a real Claude Code turn against the user's Claude Pro/Max subscription. Default corpus = ~19 probes/skill × 25 in-scope skills = ~475 turns. At a wall-clock average of ~45s/turn that's ~6 wall-hours and ~475 turn-quota debits.

`harness/inject.ts` injects each probe with a synthetic `chatId` (`-1001000000000`), so the gateway routes the synthesized turn through its normal pipeline but the reply lands in an inert chat the bot isn't a member of — the agent's real bound Telegram chat does **not** see the probes. Slice runs are safe to fire against an agent that an operator is actively using; the only collision is the agent being busy mid-turn (see "Prereqs").

## Live run

```bash
cd /path/to/switchroom

# Full run, every in-scope skill, deterministic seed:
bun tests/skill-coverage/cli.ts <agent-name> \
  --agent-cwd=$HOME/.switchroom/agents/<agent-name> \
  --gateway-socket=$HOME/.switchroom/agents/<agent-name>/telegram/gateway.sock \
  --go

# Slice to a few skills first to sanity-check:
bun tests/skill-coverage/cli.ts <agent-name> \
  --skills=switchroom-cli,switchroom-status,docx \
  --limit-per-skill=4 \
  --agent-cwd=... --gateway-socket=... --go
```

The runner emits three artifacts at `tests/skill-coverage/out/skill-coverage.{run.json,scorecard.json,scorecard.md}` (override the base with `--out=<path>`):

- `<outBase>.run.json` — full `RunRecord` (every probe's raw events when `--debug-raw-events`, else just outcomes). Forensic source of truth.
- `<outBase>.scorecard.json` — machine-readable scorecard (precision/recall/F1 per skill + aggregate).
- `<outBase>.scorecard.md` — same data as a human-readable markdown table; this is the file to check in.

## Reading the scorecard

A skill passes the goal threshold when:
- Trigger F1 ≥ 0.9
- Execution success ≥ 0.95 (v1: "the target skill fired"; v2 swaps in an artifact-shape judge — see follow-up #1)

`scorecard.md` lists every skill below threshold with the failing metric and a sample probe that misfired. Use the failing probe text to:
1. Decide if the skill's description is wrong (NEEDS-FIX → open a description-fix PR like #1217)
2. Decide if the *probe* is unfair (e.g. the indirect "symptom" phrasing is too oblique even for a human reader) — fix the seed in `corpus/seeds/<skill>.yaml`
3. Decide if there's a missing skill (audit §4 lists 6 known gaps)

## Iteration loop

```
   ┌───────────────────────────────┐
   │  bun cli.ts <agent> --go      │
   │  → tests/skill-coverage/out/  │
   │      scorecard.{json,md}      │
   └──────────────┬────────────────┘
                  ▼
        Any skill below threshold?
            ├── no  → commit scorecard, done.
            └── yes →
                  ┌─→ description issue?  →  edit SKILL.md, PR
                  ├─→ probe-quality issue? → edit corpus/seeds/<skill>.yaml
                  └─→ missing-skill gap?   → /skills new (skill-creator)
                                              then re-run.
```

Cap at 3 iterations per skill, then escalate.

## Known follow-ups (tracked in #1216 PR body)

1. **execSuccess judge.** v1 returns true whenever the target skill fired. Until v2 lands, a "pass" on execution only means *invocation*, not *correct delivery*. Worth wiring before claiming a green scorecard.
2. **LLM-driven paraphrase pass.** The current corpus is rule-based templates + curated YAML seeds. The trigger-poor cohort (`humanizer-calibrate`, `webapp-testing`, `mcp-builder`) needs LLM-generated paraphrases to fairly probe their NL surface — same `ProbeRecord` interface, different generator backend.
3. **Per-skill cost budget.** No throttling today; the runner is sequential but unbounded. For a paid-quota live run, add a `--max-probes=N` cap and prioritize skills below threshold from the previous run.
4. **Domain-gap skills.** Audit §4 named 6 gaps (vault unlock, broker socket recovery, `/restart` troubleshooting, agent-scheduler debugging, progress-card editing, hostd ops). These need authoring before they appear in a scorecard.
