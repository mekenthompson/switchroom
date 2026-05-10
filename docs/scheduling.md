# Scheduled Tasks

Switchroom runs scheduled tasks via an **in-container scheduler sibling** that lives inside every agent container alongside the gateway. At fire time the sibling injects a synthesized inbound turn into the agent's running session — so cron-triggered work appears in the agent's transcript and Hindsight context as ordinary turns tagged `<channel source="cron">`, not as out-of-band one-shot processes. Surviving host reboots is handled by docker's restart policy plus an at-least-once boot replay (see below).

## Quick Start

```yaml
defaults:
  schedule:
    - cron: "0 8 * * 1-5"
      prompt: "Morning briefing: today's calendar, top priorities, and blockers"
    - cron: "0 20 * * 0"
      prompt: "Weekly review: summarize this week's progress and next week's goals"
```

Run `switchroom agent create <name>` or `switchroom agent reconcile <name>` to materialize the schedule into the agent container. The change takes effect after the next `switchroom agent restart <name>`.

## How It Works

Each agent's container runs a small `agent-scheduler` sidecar (started by `start.sh` as a sibling of the telegram-plugin gateway). The sidecar:

1. Reads its own agent's `schedule:` block from `/state/config/switchroom.yaml` (the cascade-resolved file bind-mounted read-only into every container).
2. Registers each `cron:` expression with `node-cron`.
3. On fire, synthesizes an `InboundMessage` envelope tagged `meta.source="cron"`, `meta.schedule_index`, `meta.prompt_key`.
4. Sends an `inject_inbound` IPC message to the gateway socket inside the same container; the gateway forwards the inbound to the bridge, which delivers it to the agent's running claude session.
5. Audits each fire to `/state/agent/scheduler.jsonl` (one row per fire, append-only).

The scheduler itself never reads secrets — the agent resolves any vault refs the prompt needs via the broker socket once the turn starts.

### At-least-once replay

When an agent container restarts (image pull, OOM bounce, host reboot), any cron fires that would have happened during the downtime are replayed on boot — bounded to the past 30 minutes by default (`SWITCHROOM_AGENT_SCHEDULER_REPLAY_MIN`). The scheduler reads its own JSONL audit log, finds the most-recent past minute each cron expression matched, and replays any minute that has no successful audit row within ±90 s.

This is `at-least-once`, not `exactly-once` — a fire that's started but interrupted before audit-write may replay. The window is intentionally small so a long outage doesn't resurrect yesterday's morning briefing.

## Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `cron` | Yes | — | Standard 5-field cron expression |
| `prompt` | Yes | — | The prompt that becomes the synthesized turn's text |
| `model` | No | inherits agent | Model for this task. Honored if you wire it through the prompt; the scheduler does not pass `--model` separately because cron now runs in the agent's existing session |
| `secrets` | No | `[]` | Vault keys this task may read. See [configuration.md#vault-broker-linux-only](configuration.md#vault-broker-linux-only) |

### Cron Expression Examples

| Expression | Meaning |
|---|---|
| `0 8 * * *` | Every day at 8:00 AM |
| `0 8 * * 1-5` | Weekdays at 8:00 AM |
| `0 20 * * 0` | Sundays at 8:00 PM |
| `0 9,17 * * *` | 9:00 AM and 5:00 PM daily |
| `0 */3 * * *` | Every 3 hours |

## How cron tasks deliver to Telegram

Because cron fires arrive as ordinary inbound turns in the running session, the agent's normal reply path runs — `mcp__switchroom-telegram__reply` (or `stream_reply`) writes to the chat the same way it does for a user-typed message. Markdown→HTML conversion, smart chunking, and sanitization are identical. If the agent decides the prompt has nothing meaningful to say, no reply is sent — a silent run is correct behaviour, not an error.

This replaces the pre-v0.8 flow (singleton `switchroom-cron` container running `docker exec agent-<name> claude -p ...`), which created a fresh isolated process per fire and had no awareness of the running session.

## Cascade Behavior

Schedule entries are **concatenated** across cascade layers (defaults first, then profile, then agent):

```yaml
defaults:
  schedule:
    - cron: "0 8 * * 1-5"
      prompt: "Global morning briefing"

agents:
  coach:
    schedule:
      - cron: "0 7 * * *"
        prompt: "Daily check-in: sleep, energy"
```

The coach agent gets BOTH schedules: the global 8 AM briefing AND its own 7 AM check-in.

## Cron fires and the agent session

Pre-v0.8, scheduled tasks ran as **isolated** one-shot `claude -p` calls — no session, no transcript, no memory. Post-fold-in, fires arrive in the running session, so:

- The fire **does** consume context in the agent's conversation (it's just another turn).
- The fire **sees** the agent's recent conversation history and Hindsight memories.
- The fire **uses** the agent's configured model (`--model` is no longer per-task).
- The fire is **rendered** in the transcript as a `<channel source="cron">` turn so the agent (and operator) can tell it apart from human messages.

Trade-off: scheduled tasks now share session context (better for "remember what we discussed yesterday morning" follow-ups), at the cost of cron fires consuming token budget. For agents that need pure isolation (e.g. an audit role), a separate agent dedicated to scheduled tasks is the cleanest pattern.

If the agent is down at fire time, the in-container sidecar can't deliver — the boot-time replay window catches up to 30 minutes. Anything older than that is dropped: cron is not a queue.

## Managing the Scheduler

```bash
# Tail the agent's scheduler audit log (which task fired when)
tail -f ~/.switchroom/agents/<name>/scheduler.jsonl

# Tail the agent-scheduler supervisor's stderr/stdout
docker logs -f switchroom-<name>  # the agent-scheduler line is prefixed "agent-scheduler:"

# Restart the in-container scheduler (e.g. after editing switchroom.yaml + reconciling)
switchroom agent restart <name>

# Disable in-agent scheduling on a single container without removing the schedule
docker compose -p switchroom \
  -f ~/.switchroom/compose/docker-compose.yml \
  exec --env SWITCHROOM_INLINE_SCHEDULER=0 agent-<name> sh
```

## Comparison with Claude Code's Native Scheduling

| | Switchroom (in-agent scheduler) | Claude Code CronCreate | Claude Code Desktop |
|---|---|---|---|
| **Survives restart** | Yes (docker `restart: unless-stopped` + at-least-once replay) | No (session-scoped) | Yes (app must be open) |
| **Headless** | Yes | Yes | No (Desktop app only) |
| **Model selection** | Inherits agent's model | Inherits session | Per-task |
| **Context isolation** | Shares session | Shares session | Isolated |
| **Persistence bug** | No | Yes (#40228) | No |
