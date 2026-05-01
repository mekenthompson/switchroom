---
description: Show running switchroom agents, uptime, and overall fleet health
argument-hint: ""
allowed-tools: [Bash]
---

# Switchroom status

The user invoked: `/switchroom:status`

## What to do

Run the canonical status command and present the output. This is the same surface the `switchroom-status` skill describes — keep them in sync.

```bash
switchroom agent list --json 2>/dev/null || switchroom agent list
```

If the JSON form succeeds, parse it and present per-agent: name, running state, uptime, model, last error (if any). If only the human form is available, paste it back verbatim and summarise.

Follow up with a fleet health check when relevant:

```bash
switchroom version          # versions + boot self-test summary
```

If anything looks wedged — a process restarted in the last minute, an agent stuck "starting", a vault that won't unlock — point the user at `/switchroom:setup` (for first-run gaps), `switchroom-health` skill (for "something is broken" diagnostics), or `switchroom doctor` (for a structured self-test).

## Prerequisites

`switchroom` must be on `PATH`. If not, route to `/switchroom:setup`.
