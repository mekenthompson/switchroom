---
description: Stop a switchroom agent (or all agents) without uninstalling
argument-hint: "[agent-name]"
allowed-tools: [Bash]
---

# Stop switchroom agent(s)

The user invoked: `/switchroom:stop $ARGUMENTS`

## What to do

If `$ARGUMENTS` names an agent, stop only that one. If empty, ask the user whether they really mean *all* agents — stopping the whole fleet is a heavier action than stopping one.

```bash
# Single agent
switchroom agent stop "$ARGUMENTS"

# All agents (after confirmation)
for a in $(switchroom agent list --names 2>/dev/null); do
  switchroom agent stop "$a"
done
```

After stopping, run `switchroom agent list` and confirm the targets are no longer active. Mention to the user that stopped agents stay configured — `/switchroom:start <name>` brings them back. If they want to remove an agent permanently, that's `switchroom agent remove`, not stop.

## Prerequisites

Same as `/switchroom:start` — `switchroom` must be on `PATH`. Otherwise route to `/switchroom:setup`.
