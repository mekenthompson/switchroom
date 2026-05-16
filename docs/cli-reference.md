# CLI reference — supplementary verbs

The top-level CLI reference lives in the project [`README.md`](../README.md#cli-reference).
This page documents verbs that have no dedicated doc and don't fit the
README's setup/agent/auth/workspace groupings. Synopsis + behaviour +
common usage for each; grounded in `src/cli/*.ts`.

## `switchroom worktree` — git worktree isolation for parallel agents

Multiple agents (and sub-agents) can run concurrently on one host and
touch the same repo. Working directly on a repo's primary checkout
collides — mid-edit files, branch switches under another agent's feet,
half-staged commits clobbered. `switchroom worktree` is the supported
way to hand each task its own isolated git worktree on a fresh branch,
with a registry so stale ones get reaped instead of accumulating.

```sh
switchroom worktree claim <repo> [--task <name>] [--agent <name>] [--json]
switchroom worktree list [--json]
switchroom worktree release <id> [--json]
switchroom worktree reap [--dry-run] [--json]
```

- **`claim <repo>`** — claim a worktree for a repo (alias or absolute
  path). Prints the worktree **id**, **branch**, and **path**. `--task`
  becomes the branch suffix so the branch name says what it's for;
  `--agent` associates the claim with an agent so the registry shows
  who owns it.
- **`list`** — every active claim, with repo, branch, path, owning
  agent, and heartbeat age (claims that stop heart-beating are
  candidates for the reaper). `fresh` means the heartbeat is under
  120s old.
- **`release <id>`** — release a claim by id. If the underlying `git
  worktree remove` fails (e.g. dirty tree) the registry entry is still
  cleaned up and the result is reported as *partial* so it doesn't leak.
- **`reap`** — remove stale / orphaned worktrees (no heartbeat for
  >10 min). `--dry-run` prints what *would* be reaped without acting —
  always sanity-check with `--dry-run` first on a shared host.

Typical flow for a non-trivial change on a shared box:

```sh
ID=$(switchroom worktree claim switchroom --task fix-card --agent clerk --json | jq -r .id)
# ...work in the printed path, commit, push, open PR...
switchroom worktree release "$ID"
```

*Grounded in:* `src/cli/worktree.ts`, `src/worktree/{claim,release,list,reaper}.ts`.

## `switchroom web` — local monitoring dashboard

```sh
switchroom web [--port <n>] [--bind <host>]
```

Starts the browser dashboard for watching the fleet (Summary / Agents /
Accounts / System / Google / Schedule / Approvals tabs). Default port
`8080`, default bind `127.0.0.1` (localhost-only). Binding to a
network-reachable host prints a short-lived access token the browser
must present. Full tab-by-tab behaviour is documented under "Web
dashboard" in [`docs/telegram-features.md`](telegram-features.md#web-dashboard).

*Grounded in:* `src/cli/web.ts`, `src/web/server.ts`.

## `switchroom issues` — per-agent issue sink

A per-agent sink that surfaces *silent* failures (the CLI said
success, something is actually broken) to Telegram instead of leaving
them buried in a log. Occurrences coalesce by `source+code` so a
flapping failure doesn't spam the chat.

```sh
switchroom issues record --source <s> --code <c> [--detail <text>] [--agent <name>]
switchroom issues list [--severity <level>] [--include-resolved] [--json]
switchroom issues resolve [fingerprint] [--source <s> --code <c>]
switchroom issues prune
```

- **`record`** — record (or coalesce into) an issue occurrence.
  Mostly called by switchroom internals and hooks, not by hand.
- **`list`** — current issues from the sink; `--severity` filters to
  at-or-above a level, `--include-resolved` also shows cleared ones.
- **`resolve`** — mark an issue (by fingerprint, or all matching a
  `--source`/`--code`) resolved.
- **`prune`** — drop entries per the retention rules.

*Grounded in:* `src/cli/issues.ts`.

## `switchroom agent perf` — per-agent cache-hit telemetry

```sh
switchroom agent perf <name> [--last <n>] [--full] [--json]
```

Reads the agent's latest session JSONL and reports prompt-cache
telemetry (`cache_read` / `cache_creation` tokens per assistant turn).
Defaults to the last 20 assistant turns; `--last <n>` widens the
window, `--full` analyses every turn in the JSONL. Use it to see
whether an agent is actually getting cache hits (a low cache-read ratio
means the prompt prefix is churning and burning quota).

*Grounded in:* `src/cli/perf.ts`.

## `switchroom versions` — manifest-vs-installed drift (hidden)

```sh
switchroom versions
```

Prints the pinned dependency manifest (switchroom + dependents like
hindsight, broker protocol) against what's actually installed, and
highlights drift. The verb is **hidden** from `--help` because it's
easily confused with `switchroom version` (singular — running-agent
health summary); a follow-up may rename it to `drift` or fold it into
`switchroom doctor`. Until then it's still callable by name.

*Grounded in:* `src/cli/versions.ts`.

## Internal / host-side verbs (not for everyday use)

- **`switchroom handoff <agent>`** *(hidden)* — summarises the agent's
  last session into a handoff briefing (`.handoff.md`) and a topic line
  (`.handoff-topic`). Run automatically by the Stop hook for
  cross-session continuity; not something you invoke by hand. Flags:
  `--timeout`, `--max-turns`, `--model`. *Grounded in:* `src/cli/handoff.ts`.
- **`switchroom hostd <install|status|uninstall|audit>`** — manage
  `switchroom-hostd`, the host-control daemon for admin agents (RFC C).
  `install` writes `~/.switchroom/hostd/docker-compose.yml` and brings
  the hostd container up (it lives in a *separate* compose project from
  the agent fleet by design); `status` shows daemon state + bound
  sockets; `uninstall` stops the container but leaves the compose file
  for re-install; `audit` tails/filters the privileged-verb call log
  (`--tail`, `--agent`, `--op`, `--error`). Since recent `switchroom
  update` runs refresh hostd automatically — the manual `install` path
  is the fallback for debugging a stuck daemon. *Grounded in:*
  `src/cli/hostd.ts`.
