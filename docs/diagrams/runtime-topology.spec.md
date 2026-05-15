# runtime-topology — diagram spec

Status: new
Source of truth in code:
- `src/agents/compose.ts:733` — `vault-broker:` service block
- `src/agents/compose.ts:904` — `approval-kernel:` service block
- `src/agents/compose.ts:978` — `switchroom-auth-broker:` service block (ends ~1069)
- `src/agents/compose.ts:36-37` — `AGENT_UID_MIN=10001` / `AGENT_UID_MAX=10999`
- `src/agents/compose.ts:171` — `allocateAgentUid()` (deterministic name hash; range math `:185-186`)
- `src/agents/compose.ts:1167` — `network_mode: host` comment; emitted at `~:1174`
- `profiles/_base/start.sh.hbs` — `tini → start.sh → tmux → bash → claude` + 3 sidecars
- `src/cli/hostd.ts:50` — `HOSTD_COMPOSE_PROJECT = "switchroom-hostd"` (separate project)

Headline: "One box. Many agents. Three brokers, one host daemon."
Footer:   "Docker is distribution and isolation — `claude` runs unmodified inside."

## Nodes

Outer container A — `docker compose project=switchroom`:
- `vault-broker` · root singleton · per-agent UDS, machine-id auto-unlock · plain
- `approval-kernel` · root singleton · SQLite + per-agent UDS · plain
- `auth-broker` · root singleton · sole writer of per-agent `.credentials.json`, OAuth refresh loop, holds fleet `auth.active` · brass (highlight — newest, RFC H)
- `agent-<name> ✕ N` · per-agent UID 10001–10999, `network_mode: host` · dark card (the "guest" — it runs claude)
  - inner process tree: `tini` (PID 1) → `start.sh` → `tmux -L switchroom-<name>` → `bash -l` → `claude`
  - sidecars (siblings of tmux, forked by start.sh): `telegram-plugin gateway`, `autoaccept-poll`, `agent-scheduler` (cron, Phase 4)

Separate container B — `docker compose project=switchroom-hostd`:
- `hostd` · own compose project, `/var/run/docker.sock` mounted · plain
  - exists so `compose -p switchroom down` can't take out the daemon that runs `/update apply`

## Edges

- `vault-broker` → each `agent-<name>` · "per-agent sock, chowned to UID" · primary-flow
- `approval-kernel` → each `agent-<name>` · "per-agent sock" · primary-flow
- `auth-broker` → each `agent-<name>` · "writes .credentials.json (sole writer)" · primary-flow
- `agent gateway` → `hostd` · "UDS — /update apply, audit" · primary-flow
- Path-as-identity note (leader callout, not an edge): broker authorizes by bind-path `<agent>/sock`, never a wire payload.

## Style notes

Inherits the v3 recipe. Three broker cards are secondary (`+0.8°`); the
agent card is the dark-card exception (`#14171C`, `-1.2°`, focal). Draw
container A as a large rounded `--bone-2` group frame (no shadow) so the
brokers/agents read as "inside the same compose project"; `hostd` sits
outside it in its own thin frame. This supersedes the ASCII in CLAUDE.md
(which predates `auth-broker` and shows only two singletons).
