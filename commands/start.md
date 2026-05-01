---
description: Start a switchroom agent (or all agents) via systemd
argument-hint: "[agent-name]"
allowed-tools: [Bash]
---

# Start switchroom agent(s)

The user invoked: `/switchroom:start $ARGUMENTS`

## What to do

If `$ARGUMENTS` names an agent, start only that one. If empty, start everything in the configured fleet. Both paths go through the canonical CLI — never poke `systemctl --user` directly unless the CLI is unavailable.

```bash
# Single agent
switchroom agent start "$ARGUMENTS"

# All agents
switchroom update              # reconcile + (re)start every agent
```

After starting, verify:

```bash
switchroom agent list
```

Report which agents flipped to running, their PIDs, and uptime. If any failed to start, fetch the last 20 journal lines for the offender:

```bash
switchroom agent logs <name> --lines 20
```

Surface the failure cause in plain language. Do not silently retry — failed starts mean a config or auth problem the user needs to see.

## Prerequisites

`switchroom` must be on `PATH`. If not, route to `/switchroom:setup` first. If the user has no config (`~/.switchroom/switchroom.yaml` missing), `/switchroom:setup` is also the right entry point.
