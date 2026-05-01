# Skills in switchroom

Switchroom agents use Claude Code's [skills system](https://code.claude.com/docs/skills). A skill is a `<name>/SKILL.md` directory whose frontmatter tells Claude when to invoke it. This page explains where switchroom looks for skills, how they get installed into agents, and what's bundled vs operator-managed.

## Three skill populations

Switchroom distinguishes three populations, each living in a different place:

| Population | Where they live | When they get installed | Audience |
|---|---|---|---|
| **Switchroom-bundled fleet skills** | `<repo>/skills/` (with `switchroom-` name prefix) | Auto-symlinked into every agent's `.claude/skills/` on `scaffoldAgent` and `reconcileAgent` (see `installSwitchroomSkills` in `src/agents/scaffold.ts`) | Every fleet agent |
| **Switchroom-bundled developer skills** | `<repo>/skills/` (without `switchroom-` prefix — e.g. `buildkite-*`, `file-bug`, `telegram-test-harness`, `humanizer*`, `token-helpers`) | NOT auto-installed; a developer agent (e.g. one working on switchroom itself) opts in via `defaults.skills:` or per-agent `skills:` in switchroom.yaml | Switchroom developers + power-user operators |
| **User-managed personal skills** | `~/.switchroom/skills/` (or wherever `switchroom.skills_dir` points) | Symlinked into agents that name them in `defaults.skills` or `agents.<name>.skills`. See `syncGlobalSkills` in `src/agents/scaffold.ts` | Fleet agents — calendar, garmin, doctor-appointments, etc. — anything personal to the operator |

### Why the split

Different populations answer different questions:

- "What does *every* agent need?" → bundled fleet skills (the `switchroom-*` ones — only when meta-agents need them; see caveat below)
- "What does a *developer* working on switchroom need?" → bundled developer skills (read in dev contexts, not auto-injected into fleet agents)
- "What does *this user's* fleet need beyond the defaults?" → user-managed personal skills

## Foreman opt-in for bundled `switchroom-*` skills

The 6 bundled `switchroom-*` operator skills are role-gated — only agents with `role: "foreman"` in their config get them auto-symlinked into `.claude/skills/`. Default `assistant` role (the implicit default for fleet agents) gets none of them.

```yaml
agents:
  clerk:
    topic_name: "General"
    # role omitted → assistant → no operator skills auto-installed
  foreman:
    topic_name: "Fleet manager"
    role: foreman   # → operator skills auto-installed
```

Reconcile honors role flips both ways: `assistant → foreman` installs the symlinks, `foreman → assistant` retracts them (only switchroom-installed symlinks; never real dirs the operator placed manually).

The 6 bundled operator skills:

- `switchroom-architecture` — explains how switchroom works internally
- `switchroom-cli` — runs CLI operations
- `switchroom-health` — health check + diagnostics
- `switchroom-install` — installs switchroom on a fresh machine
- `switchroom-manage` — manage the fleet
- `switchroom-status` — show running agents

A fleet agent like `clerk` doing user-facing tasks never needs to call `switchroom-install` or `switchroom-manage`, so the assistant default keeps their tool list focused. A foreman bot or developer agent (`role: foreman`) gets the operator surface for free.

## What gets bundled vs what doesn't

Current `<repo>/skills/` inventory:

| Skill | Population | Notes |
|---|---|---|
| `switchroom-architecture` | foreman-only (auto when `role: foreman`) | Operator skill |
| `switchroom-cli` | foreman-only (auto when `role: foreman`) | Operator skill |
| `switchroom-health` | foreman-only (auto when `role: foreman`) | Operator skill |
| `switchroom-install` | foreman-only (auto when `role: foreman`) | Operator skill |
| `switchroom-manage` | foreman-only (auto when `role: foreman`) | Operator skill |
| `switchroom-status` | foreman-only (auto when `role: foreman`) | Operator skill |
| `humanizer` | developer (opt-in) | Strips AI-writing patterns from replies; opt in via `defaults.skills` |
| `humanizer-calibrate` | developer (opt-in) | Builds a personal voice template; companion to `humanizer` |
| `buildkite-*` (8 skills) | developer (opt-in) | Switchroom CI work; not for fleet agents |
| `file-bug` | developer (opt-in) | Files structured bug reports; switchroom dev workflow |
| `telegram-test-harness` | developer (opt-in) | Guidance for writing Telegram tests against the harness |
| `token-helpers` | developer (opt-in) | OAuth token refresh for Google Calendar / MS Graph |

Real fleet agents (clerk, klanker, etc.) load their personal skills from `~/.switchroom/skills/` — that directory holds calendar, compass, coolify, doctor-appointments, fully-kiosk, garmin, and similar. **The repo doesn't track those** — they're operator-managed.

## Configuring skills per agent

In `switchroom.yaml`:

```yaml
defaults:
  # Skills every agent gets (unioned with per-agent `skills:`).
  # Names resolve against ~/.switchroom/skills/ (or switchroom.skills_dir).
  skills: [humanizer, humanizer-calibrate]

agents:
  clerk:
    # Per-agent additions. Unioned with defaults.skills.
    skills: [calendar, doctor-appointments]
```

Skills declared but not present in the resolved skills directory produce a warning (not a hard failure) — the rest of the scaffold continues.

## Adding a new skill

For a fleet skill (one specific user wants on their agents):

1. Create the skill directory at `~/.switchroom/skills/<name>/SKILL.md` with proper frontmatter
2. Add `<name>` to `defaults.skills` (everyone) or `agents.<name>.skills` (one agent)
3. Run `switchroom agent reconcile <agent>` to apply

For a switchroom-bundled developer skill (everyone working on switchroom benefits):

1. Create the skill directory at `<repo>/skills/<name>/SKILL.md`
2. Open a PR

For a switchroom-bundled foreman skill (auto-installed when `role: foreman`):

1. Create the skill directory at `<repo>/skills/switchroom-<name>/SKILL.md`
2. Document it in the table above
3. Open a PR

For a switchroom-bundled fleet-default skill (every agent regardless of role):

1. **Don't auto-install.** Add it as a developer-pool skill instead and let operators opt in via `defaults.skills`. Auto-injecting into every agent's tool list adds cognitive overhead per turn for users who'll never call it. The `role: foreman` opt-in is the right escape hatch for the operator-skill case.

## Related code

- `src/agents/scaffold.ts:installSwitchroomSkills` — auto-install of `switchroom-*` skills
- `src/agents/scaffold.ts:syncGlobalSkills` — user-managed skill symlinking from `skills_dir`
- `src/config/schema.ts` — `defaults.skills` + `agents.<name>.skills` schema
- `examples/switchroom.yaml` — example config showing both forms
