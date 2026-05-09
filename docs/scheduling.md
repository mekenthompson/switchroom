# Scheduled Tasks

Switchroom runs scheduled tasks via the **`scheduler` container** — a singleton cron service in the docker fleet that dispatches one-shot `claude -p` calls into each agent container at the configured times and sends output to Telegram. Surviving host reboots is handled by docker's restart policy.

## Quick Start

```yaml
defaults:
  schedule:
    - cron: "0 8 * * 1-5"
      prompt: "Morning briefing: today's calendar, top priorities, and blockers"
    - cron: "0 20 * * 0"
      prompt: "Weekly review: summarize this week's progress and next week's goals"
      model: claude-opus-4-6    # override for important tasks
```

Run `switchroom agent create <name>` or `switchroom agent reconcile <name>` to register the schedule entries with the scheduler.

## How It Works

The `scheduler` container reads each agent's `schedule:` block from `~/.switchroom/switchroom.yaml` (and the cascade), converts every `cron:` expression to a `node-cron` schedule, and at fire time runs:

```
docker exec agent-<name> claude -p "<prompt>" --model <model> --no-session-persistence
```

against the live agent container. The agent's MCP tools (Telegram, Vault, etc.) are wired the same way they are for an interactive turn, so the dispatched task can call `mcp__switchroom-telegram__reply` directly. The scheduler itself never sees secret values — the agent resolves any vault refs through the broker socket.

## Configuration

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `cron` | Yes | — | Standard 5-field cron expression |
| `prompt` | Yes | — | The prompt sent to Claude |
| `model` | No | `claude-sonnet-4-6` | Model for this task |
| `secrets` | No | `[]` | Vault keys this task may read via the broker. See [configuration.md#vault-broker-linux-only](configuration.md#vault-broker-linux-only). |

> **`suppress_stdout` was removed in [#269](https://github.com/switchroom/switchroom/issues/269).** All cron tasks route their Telegram message through the MCP `reply` tool the agent already uses for interactive turns.

### How cron tasks deliver to Telegram

Cron-scheduled tasks run as one-shot `claude -p` invocations with no live Telegram session. The scheduler executes the configured `prompt` directly — there is no shell-level prompt wrapping, no `HEARTBEAT_OK` sentinel, and no stdout redirection. If the task has something to say, the model calls `mcp__switchroom-telegram__reply` itself; the scheduler captures stdout only to populate the audit-log `output_summary` column.

The MCP `reply` tool applies the same markdown→HTML conversion, smart chunking, and sanitization as a live session, so output renders identically regardless of trigger. If the task has nothing meaningful to deliver (data is dull, all signals nominal), the model can simply not call `reply` — a silent run is correct behaviour, not an error.

This replaces the previous flow (raw `claude -p` stdout piped through `curl ... -d parse_mode=HTML`), which produced broken markdown rendering on phones (literal `**asterisks**`) and the duplicate-message bug tracked in [#251](https://github.com/switchroom/switchroom/issues/251).

### Cron Expression Examples

| Expression | Meaning |
|---|---|
| `0 8 * * *` | Every day at 8:00 AM |
| `0 8 * * 1-5` | Weekdays at 8:00 AM |
| `0 20 * * 0` | Sundays at 8:00 PM |
| `0 9,17 * * *` | 9:00 AM and 5:00 PM daily |
| `0 */3 * * *` | Every 3 hours |

## Model Selection

Tasks default to `claude-sonnet-4-6` (cheap, fast). Override per-task for important work:

```yaml
schedule:
  - cron: "0 8 * * 1-5"
    prompt: "Quick morning check-in"
    # uses sonnet (default) — fast, cheap

  - cron: "0 20 * * 5"
    prompt: "End-of-week deep analysis: review all PRs, summarize decisions"
    model: claude-opus-4-6
    # uses opus — complex reasoning, worth the tokens
```

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

The coach agent gets BOTH schedules: the global 8am briefing AND its own 7am check-in.

## Independence from Agent Sessions

Scheduled tasks are **not** part of the running agent session. They:

- Run as fresh one-shot `claude -p` calls (no persistent session)
- Don't consume context in the main agent's conversation
- Fire even if the agent is down, restarting, or in a broken state
- Use their own model (Sonnet by default) regardless of the agent's model

This means a scheduled task won't see the agent's conversation history or Hindsight memories. It's a clean, isolated execution — ideal for briefings, reminders, and periodic checks.

## Managing the Scheduler

```bash
# Confirm the scheduler container is running
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml ps scheduler

# Tail the scheduler's fire log (which task fired when, exit codes)
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml logs -f scheduler

# Manually trigger a scheduled task by dispatching it directly into the agent
docker exec agent-<name> claude -p "<prompt>" --model claude-sonnet-4-6 --no-session-persistence

# Restart the scheduler (e.g. after editing switchroom.yaml + reconciling)
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml restart scheduler
```

## Comparison with Claude Code's Native Scheduling

| | Switchroom (scheduler container) | Claude Code CronCreate | Claude Code Desktop |
|---|---|---|---|
| **Survives restart** | Yes (docker `restart: unless-stopped`) | No (session-scoped) | Yes (app must be open) |
| **Headless** | Yes | Yes | No (Desktop app only) |
| **Model selection** | Per-task | Inherits session | Per-task |
| **Context isolation** | Fully isolated | Shares session | Isolated |
| **Persistence bug** | No | Yes (#40228) | No |
