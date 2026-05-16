# Session Optimization

Strategies for managing context and tokens in long-running switchroom agents.

## Context Budget

Every turn includes fixed-cost components:

- **CLAUDE.md** — loaded every turn. Keep under 800 words.
- **SOUL.md** — loaded every turn. Keep under 500 words.
- **MCP tool descriptions** — ~100-200 tokens each.
- **Hindsight auto-recall** — ~500 tokens of relevant memories per turn.
- **Conversation history** — accumulates until compaction.

## Three Layers of Continuity

Switchroom agents have three mechanisms that survive restarts and compaction:

1. **Handoff briefing** — the default since switchroom #362. Every restart starts a **fresh** `claude` session; a compact summary of the prior session (written to `<agentDir>/.handoff.md` by the Stop hook) plus a live briefing assembled from recent Telegram messages, Hindsight recall, and today's daily memory file (`<agentDir>/.handoff-briefing.md`) is merged into `--append-system-prompt` so the new session wakes up oriented. The full transcript is *not* replayed.

   To opt into transcript-replay continuity instead, set `session_continuity.resume_mode` per agent in switchroom.yaml:

   - `handoff` — default. Fresh session every restart, briefing injected.
   - `auto` — pass `--continue` only when the JSONL transcript exists, is under the size cap (`session_continuity.resume_max_bytes`, default 2 MB), and is fresher than `session.max_idle` if set, else a hardcoded 7-day fallback (the schema gives `session.max_idle` no default; the 7-day floor lives in `start.sh` as `${SWITCHROOM_SESSION_MAX_IDLE_SECS:-604800}`).
   - `continue` — always pass `--continue`. Flaky on large transcripts; only use if you know your sessions stay small.
   - `none` — fresh every time, no briefing.

2. **Hindsight memory** — auto-retain fires every 10 turns, saving the full transcript to a semantic bank. Auto-recall fires every turn, bringing back relevant memories. Important facts survive compaction and restart because they're stored externally.

3. **Telegram history** — SQLite buffer of every inbound/outbound message. `get_recent_messages` lets the agent recover recent chat context after a restart, regardless of resume mode.

## Session Freshness Policy

`session.max_idle` and `session.max_turns` are the freshness knobs in switchroom.yaml:

```yaml
defaults:
  session:
    max_idle: 2h      # under resume_mode: auto, force fresh after 2h of inactivity
    max_turns: 50     # rotate to a fresh session after 50 user turns
```

In `auto` mode the boot check inspects the previous session's last-modified time and turn count and decides whether to pass `--continue`. In `handoff` mode (the default) every restart is fresh by construction; `session.max_idle` does not gate `--continue` because `--continue` is never passed. Hindsight auto-recall brings back relevant context regardless of mode.

## Sub-Agent Cost Optimization

Route implementation work to cheaper models via sub-agents:

```yaml
defaults:
  model: claude-opus-4-7
  subagents:
    worker:
      model: sonnet
      background: true
      isolation: worktree
```

The main agent (Opus) handles planning and review. `@worker` (Sonnet) handles implementation in the background at ~5x lower token cost. The main agent stays available for new requests.

## Tool Budget

- Restrict tools per agent: `tools.deny: [Bash, Edit, Write]` saves ~500 tokens.
- Only enable MCP servers the agent uses.
- The switchroom MCP server (~800 tokens for 8 tools) replaces Bash access for agent management.

## Compaction

Claude Code auto-compacts at ~83.5% of the context window (~835k tokens on the 1M Opus model). This is handled transparently:

- **Micro-compaction** selectively summarizes old tool results.
- **Full compaction** produces a structured summary of intent, changes, and pending work.
- **CLAUDE.md is sacred** — never compacted, always in the system prompt.
- **Hindsight is the safety net** — anything compaction loses can be recalled from the memory bank.

With the 1M context window on Opus 4.6, most conversations won't hit compaction in a single session.
