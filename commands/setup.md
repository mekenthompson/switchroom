---
description: Bootstrap switchroom from inside Claude Code — Phase 0 zero-to-daemon on-ramp (#84, #543)
argument-hint: ""
allowed-tools: [Bash, Read, Write]
---

# Switchroom — first-run bootstrap

This is the Phase 0 on-ramp for users who just ran `/plugin install switchroom@switchroom`. Walk them from "plugin installed" to "daemon running, first agent paired in Telegram" in one sitting. No silent steps. Confirm before each install. Reuse the existing CLI surface — do not reimplement.

## Step 0 — Detect current state

Before any install action, inventory what's already on the box. Run each, capture exit code:

```bash
. /etc/os-release 2>/dev/null && echo "OS: $PRETTY_NAME" || echo "OS: unknown"
uname -m
free -h | awk '/^Mem:/ {print "RAM: " $2}'
command -v bun >/dev/null && bun --version | sed 's/^/bun: /' || echo "bun: MISSING"
command -v node >/dev/null && node --version | sed 's/^/node: /' || echo "node: MISSING"
command -v claude >/dev/null && echo "claude: present" || echo "claude: MISSING"
command -v switchroom >/dev/null && switchroom --version 2>/dev/null | sed 's/^/switchroom: /' || echo "switchroom: MISSING"
command -v tmux >/dev/null && echo "tmux: present" || echo "tmux: MISSING"
test -f ~/.switchroom/switchroom.yaml && echo "config: present at ~/.switchroom/switchroom.yaml" || echo "config: MISSING"
```

Present the inventory back as a short bulleted summary. Then decide the path:

- **All present + config present + at least one agent unit running** → on-ramp is done. Hand off to `/switchroom:status` and stop.
- **All present + config present + no units** → skip to Step 3.
- **switchroom CLI present, no config** → skip to Step 2.
- **switchroom CLI missing** → Step 1.
- **Not Linux (macOS/WSL/etc.)** → stop. Switchroom needs Ubuntu 24.04 LTS or compatible Debian. Recommend a $6/mo VPS (Hetzner, DigitalOcean, Vultr).

## Step 1 — Install switchroom + dependencies

Confirm with the user before running anything that mutates the system. Switchroom's dependencies are `bun`, `node` 22+, `tmux`, the Claude Code CLI, and (optionally) `docker`. Recommend the one-liner — it is idempotent and source-readable:

```bash
curl -fsSL https://get.switchroom.ai | bash
```

If the user prefers manual control, walk them through the `switchroom-install` skill (it has the granular package list). After install, reload the shell or `source ~/.bashrc` so `switchroom` is on `PATH`, then verify:

```bash
switchroom --version
```

## Step 2 — Wire Telegram + scaffold first agent

Run the existing wizard. It handles BotFather walk-through, vault init, profile picker, and the first DM pairing without re-runs:

```bash
switchroom setup
```

Tell the user up front: the wizard will ask them to open BotFather in Telegram, paste the bot token back into the terminal, and DM `/start` to the new bot. Stay with them until the wizard prints "agent paired".

If the user wants a non-default persona, suggest passing `--profile <name>` once they pick one (the wizard's profile picker lists what is available).

## Step 3 — Start the daemon, confirm liveness

```bash
switchroom agent start <name>     # if a specific agent was just scaffolded
# or:
switchroom update                  # reconcile + restart everything
switchroom agent list              # uptime + state
```

Hand off to `/switchroom:status` for ongoing checks. Tell the user that from this point forward they talk to the agent in Telegram, not the terminal.

## Step 4 — Slash commands they get for free

Now that the plugin is installed, surface the other entry points:

- `/switchroom:status` — what is running and for how long
- `/switchroom:start <agent>` — start (or restart) a single agent
- `/switchroom:stop <agent>` — stop an agent

For deeper operations (logs, config edits, agent add, vault, doctor), point at the `switchroom-cli`, `switchroom-manage`, and `switchroom-health` skills — they are namespaced under the same plugin.

## Guardrails

- Never run `switchroom install` or `curl … | bash` without explicit user confirmation.
- Never skip the BotFather step. There is no fallback path that produces a working Telegram surface.
- If the user is on a tiny VPS (<2 GB RAM), warn them: switchroom + claude + a few agents will OOM. Recommend 4 GB+.
- If `claude` is missing, install it via `npm install -g @anthropic-ai/claude-code` — switchroom does not ship claude itself.
