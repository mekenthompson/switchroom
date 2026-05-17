# Switchroom vs OpenClaw: an OpenClaw alternative that works with Claude Pro/Max

If you came here because OpenClaw stopped working with your Claude subscription, Switchroom is built for the same use case with a different set of tradeoffs. The wedge is simple: Switchroom drives the **stock `claude` CLI** under your existing Pro/Max subscription. OpenClaw runs a custom runtime against your Anthropic API key.

## TL;DR

- **Switchroom uses your Claude Pro/Max subscription via OAuth.** OpenClaw requires an Anthropic API key and bills per token.
- **Switchroom runs the stock `claude` CLI.** OpenClaw runs a custom runtime that re-implements parts of Claude Code.
- **Switchroom inherits every upstream Claude Code feature the day it ships.** OpenClaw has to catch up.
- **Switchroom has a YAML config cascade** (defaults → profiles → per-agent). OpenClaw uses per-agent JSON/TOML files.

## Side-by-side

| | Switchroom | OpenClaw |
|---|---|---|
| Auth | Claude Pro/Max OAuth | Anthropic API key |
| Billing | Your existing subscription | Per-token API billing |
| Runtime | Stock `claude` CLI | Custom runtime |
| Channels | Telegram (enhanced fork with 15 MCP tools) | WhatsApp, Telegram, Slack |
| Memory | Hindsight (semantic, knowledge graph, mental models) | File-based |
| Scheduling | Cron syntax in YAML, fires across reboots | Built-in cron engine |
| Sub-agents | Native Claude Code sub-agents | Custom orchestration |
| Config | YAML with cascade + profiles | JSON/TOML per agent |
| Install | `switchroom setup` wizard | `docker compose up` |
| License | MIT | n/a |

## Why subscription auth matters

Claude Pro is $20/month and Claude Max is $100/month. For an always-on agent fleet, that's effectively flat-rate inference. API billing for the same workload, even with prompt caching, frequently runs higher for interactive/long-running agents, and you pay per response whether the output was useful or not.

Using OAuth also means:
- The same auth flow as the desktop app, so your account history and rate limits are unified.
- No API key sitting on a server that could leak.
- No separate billing relationship with Anthropic to manage.

## Why the stock `claude` CLI matters

OpenClaw re-implements Claude's agent loop in a custom runtime. That means when Anthropic ships a new Claude Code feature (sub-agents, skills, MCP improvements, memory tool, code execution) OpenClaw has to catch up. Switchroom inherits every upstream feature the day it lands, because each agent is literally the `claude` binary.

Examples of upstream features Switchroom gets for free:
- Native sub-agents (Plan, Explore, general-purpose)
- Claude-native skills
- MCP server support with all transports
- `--continue` for session continuity
- Hooks (PreToolUse, PostToolUse, Stop, UserPromptSubmit)

## What you actually get

Substrate aside, here's what the product promises:

- **Long-running service per agent.** Survives reboots, network drops, your laptop closing.
- **Auto-recovery on crash, with audit trail.** A watchdog catches stuck turns, captures a crash-pane snapshot for forensics, restarts the agent. The agent then runs a wake-audit on boot for owed replies and orphan sub-agents. No silent dropped work.
- **Per-agent isolated logs you can grep.** One process per agent, one log stream per agent.
- **Scheduled tasks that fire across reboots.** Cron syntax in YAML, per-task model selection, output to Telegram.
- **Live progress cards in Telegram.** Pinned per topic, every tool call visible. The headline UX.

## When OpenClaw might still be the right call

- You need WhatsApp or Slack channels today and don't want to wait for Switchroom to ship them.
- You specifically want API-key billing for compliance/procurement reasons.
- You need the custom runtime's behaviour for a feature Switchroom doesn't replicate.

## Migrating from OpenClaw

1. Install Switchroom: `git clone https://github.com/switchroom/switchroom.git ~/code/switchroom && cd ~/code/switchroom && bun install && bun link`
2. Run `switchroom setup`. The wizard handles OAuth login, Telegram bot registration, and the first agent.
3. Translate each OpenClaw agent's config into a block under `agents:` in `switchroom.yaml`. Most settings have a direct equivalent; see [configuration.md](configuration.md).
4. Bring your persona: the setup wizard prompts for each agent's name/style/boundaries, or paste your OpenClaw `SOUL.md` into the seeded `workspace/SOUL.md` afterwards. Like OpenClaw, **SOUL.md is your file** — switchroom seeds it once and never overwrites it on update (the root `CLAUDE.md` operating-manual *is* switchroom-managed, so its updates still reach you). Re-seed any time with `switchroom soul reset <agent>`.
5. Import memory: if you stored anything in OpenClaw's file-based memory, `switchroom memory` can ingest arbitrary text into a Hindsight bank.
6. Point your existing Telegram bot token at Switchroom (or create a new bot), and `switchroom agent start` each agent.

## See also

- [Configuration reference](configuration.md)
- [Telegram plugin features](telegram-plugin.md)
- [Sub-agents](sub-agents.md)
- [Compliance attestation](compliance-attestation.md)
