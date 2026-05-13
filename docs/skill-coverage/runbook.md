# Skill-coverage harness — live-run runbook

How to take the harness landed in #1216 from "passes unit tests" to "produces a checked-in scorecard against a real agent."

The harness lives in `tests/skill-coverage/`. The audit + inventory in this directory are the spec; the runbook is the operator's how-to.

## Prereqs

1. A switchroom agent container is **running** and you have **agent-uid read access** to its state dir.

   The agent's session JSONL lives at `~/.switchroom/agents/<name>/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl`. The dir is owned by the per-agent UID (10001–10999) at mode 0775 with no group expansion — your interactive shell user (typically `kenthompson`) **cannot read it**.

   Three workable invocation modes:

   - **Mode A — run inside the agent.** `switchroom agent attach <name>` → from the agent's tmux session run `bun tests/skill-coverage/cli.ts <name> --go --agent-cwd=$PWD`. Highest fidelity; you ARE the agent so perms are satisfied.
   - **Mode B — sudo from host as the agent UID.** `sudo -u "#$(stat -c %u ~/.switchroom/agents/<name>)" bun tests/skill-coverage/cli.ts <name> --go --agent-cwd=...`. Works from a host worktree if your `sudo` accepts the `#UID` lookup form. Note: `sudo-rs` (the Rust port shipped on some recent Ubuntu) rejects `#UID` with `user '#NNNN' not found`; use the C `sudo` at `/usr/bin/sudo.ws` (if installed), `su -s /bin/bash -c '...'` against a named agent user, or fall back to Mode A.
   - **Mode C — bind-mount the projects dir host-readable** (compose change, follow-up RFC). Out of scope for this runbook; tracked as a known follow-up.

   The gateway socket at `~/.switchroom/agents/<name>/telegram/gateway.sock` is also agent-uid owned but is reachable from any process that can `connect()` — only the JSONL read needs the perms dance.

2. The harness corpus is current — regenerate after any edit to `fixtures/skills.json`:
   ```bash
   bun tests/skill-coverage/corpus/generate-corpus.ts --seed=1
   ```
3. The agent should be **idle** when you start. The harness queues probes sequentially and waits for `turn_end` between each; if the agent is mid-turn from a user message, the first observed `turn_end` will be that turn, not yours.

## Cost / blast-radius warning

Each probe is a real Claude Code turn against the user's Claude Pro/Max subscription. Default corpus = ~19 probes/skill × 25 in-scope skills = ~475 turns. At a wall-clock average of ~45s/turn that's ~6 wall-hours and ~475 turn-quota debits.

`harness/inject.ts` injects each probe with a synthetic `chatId` (`-1001000000000`), so the gateway routes the synthesized turn through its normal pipeline but the reply lands in an inert chat the bot isn't a member of — the agent's real bound Telegram chat does **not** see the probes. Slice runs are safe to fire against an agent that an operator is actively using; the only collision is the agent being busy mid-turn (see "Prereqs").

## Live run

**Preferred path — MTCute UAT runner** (`telegram-plugin/uat/runners/skill-coverage.ts`). Drives a real Telegram user account against the agent's bot via mtcute, sends each probe, then reads which skills fired from the agent's host-readable `tool-labels-<session>.jsonl` sidecar (written by the PreToolUse hook at `telegram-plugin/hooks/tool-label-pretool.mjs`). Telegram is the inbound channel; the sidecar is the observation surface. No JSONL tailing of agent-uid-owned `session.jsonl`, no inject_inbound socket.

Prereqs for this path are the standard UAT prereqs (see `telegram-plugin/uat/SETUP.md`):

- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_UAT_DRIVER_SESSION` in the repo-root `.env`.
- Test bot is wired to the target agent and reachable via the username you'll pass to `--agent`.
- Target agent has been restarted since this branch landed so (a) the PreToolUse hook emits Skill sidecar rows and (b) `Skill` lives in `permissions.allow` (see "Skill pre-approval" below).
- Agent's `~/.switchroom/agents/<name>/telegram/` directory is host-readable (the sidecar files land here at mode 0644 — readable to any host user). No agent-uid sudo dance required.

```bash
cd /path/to/switchroom

# Full run, deterministic corpus:
bun telegram-plugin/uat/runners/skill-coverage.ts \
  --agent test-harness:@your_test_bot

# Slice for sanity-check first (recommended):
bun telegram-plugin/uat/runners/skill-coverage.ts \
  --agent test-harness:@your_test_bot \
  --skills switchroom-cli,switchroom-status,docx \
  --limit-per-skill 2
```

**Fallback path — inject_inbound runner** (`tests/skill-coverage/cli.ts`). Original design; works but requires agent-uid read on `~/.switchroom/agents/<name>/.claude/projects/`. Use one of the three modes (A/B/C above) to satisfy perms.

```bash
bun tests/skill-coverage/cli.ts <agent-name> \
  --agent-cwd=$HOME/.switchroom/agents/<agent-name> \
  --gateway-socket=$HOME/.switchroom/agents/<agent-name>/telegram/gateway.sock \
  --go
```

### Skill pre-approval

Probes will stall if the agent's `permissions.allow` doesn't include the bare `Skill` tool — every Skill invocation otherwise hits an approval prompt that the harness can't dismiss. The scaffold's `DEFAULT_READ_ONLY_PREAPPROVED_TOOLS` includes `Skill` since the same PR that introduced the MTCute runner; for older agents either `switchroom agent restart <name>` to refresh the scaffold or hand-edit `~/.switchroom/agents/<name>/.claude/settings.json` to add `"Skill"` to `permissions.allow`.

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
5. **Host-readable session JSONL (Mode C).** Until the per-agent state dir gets a more permissive bind (or a sidecar relays session events to a host-visible NDJSON), the harness can't be run by an unprivileged host user without sudo. Cleanest fix is probably a small sidecar that fanouts `SessionEvent`s to `/var/log/switchroom/<name>/sessions.jsonl` (already host-mounted, already used by `agent-scheduler.log`). RFC TBD.
