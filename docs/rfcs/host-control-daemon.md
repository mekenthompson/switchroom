# RFC C: Host-control daemon (`switchroom-hostd`)

Status: Draft v2 (incorporates first-round review)
Author: Ken (via Claude pair-design)
Date: 2026-05-13

## 1. Summary

A new host-side singleton daemon, `switchroom-hostd`, that exposes a
narrow, audited subset of operator-only verbs (`switchroom apply`,
`switchroom agent restart`, `switchroom update [--check|--apply]`,
`switchroom upgradestatus`) to agent containers via a Unix-domain
socket. Agents reach it through a per-agent socket mount that mirrors
the vault-broker / approval-kernel model: bind-time path-as-identity,
admin-gated verbs, peercred for audit attribution, no wire-payload
identity. The gateway's existing `spawnSwitchroomDetached` shell-out
goes away for the verbs the daemon supports; the docker-availability
guard (#926) is replaced by an unconditional daemon-availability check
that points the operator at `systemctl status switchroom-hostd` on the
unhappy path.

This closes the long-tracked "true self-modification" gap from #1164:
an in-container agent can stage a code change in its own worktree
(`repos:` pattern), open a PR, get review, and then — after merge —
ask the daemon to deploy the change to the running fleet. Today step 4
forces the operator out of Telegram and onto the host shell.

## 2. Motivation

The survey (this session) catalogued **six detached spawns and ~46
synchronous shell-outs** the gateway issues per session, all targeting
`switchroom <verb>`. They divide into three classes:

1. **Read-only**, no host privilege needed (`agent list`, `topics list`,
   `memory search`, `auth list`, `update --check`, `upgradestatus`,
   `issues list`, …). The in-container CLI already handles these fine
   because `SWITCHROOM_CONFIG` is mounted `:ro` and these verbs don't
   touch the running fleet.

2. **Per-agent self-restart** (`/restart`, `/new`, `/reset` → `agent
   restart <self>`). Today: detached spawn via `spawnSwitchroomDetached`,
   `systemd-run --user --scope` cgroup-escape, restart marker + sweep.
   These work on systemd hosts but the cgroup-escape is a load-bearing
   prerequisite that won't translate to non-systemd installs. Docker
   hosts get partial coverage; everything else falls through.

3. **Fleet mutation** (`update --apply`, `apply`, `agent restart <other>`,
   `agent start/stop`, future: `vault rotate`, `image refresh`). Needs
   docker reach and write access to `~/.switchroom/compose/`. Today
   `/update apply` is the only one with a docker-availability guard
   (#926); the others would fail opaquely if attempted from inside the
   sandbox.

Class (1) is already handled. The daemon's job is (2) and (3).

Two adjacent forces:

- **`bind_mounts:` (#1166) was scoped at the wrong layer for dogfood.**
  Klanker doesn't need host-source-tree access; `repos:` gives it an
  in-container worktree of switchroom. What klanker still cannot do
  is *deploy* its merged change. That's a host-control problem, not a
  filesystem-reach problem. See §13 for the rectification.

- **The cgroup-escape pattern is fragile.** `systemd-run --scope` is
  a Linux-systemd-specific workaround for a structural problem
  (gateway-child lifecycle coupling). A daemon that owns its own
  process supervision (its own systemd unit, or a separate compose
  service with `restart: unless-stopped`) eliminates the workaround.

## 3. Goals and non-goals

**Goals**:

- Move per-agent self-restart and fleet-mutation verbs off the
  `spawnSwitchroomDetached` path and onto a daemon RPC.
- Make the operator's "happy path" for code self-modification fully
  in-Telegram: agent opens PR → reviewer approves → operator (or
  admin agent) taps `/update apply` → daemon runs the deploy →
  card edits to reflect new fleet state.
- Re-use the broker/kernel trust model verbatim: bind-time
  path-as-identity, admin-gating in server config, peercred for
  audit, no wire identity claim.
- Audit every verb invocation to `~/.switchroom/host-control-audit.log`,
  same NDJSON shape as `vault-audit.log`.

**Non-goals**:

- Replacing the *read-only* verbs (class 1). They work today via
  `/state/config/switchroom.yaml:ro` + `SWITCHROOM_CONFIG`.
- Granting non-admin agents any host-control capability. The trust
  posture is identical to admin-gated vault grant-management: if you
  trusted the agent enough to set `admin: true`, this is the next
  privilege; if not, it gets nothing.
- Wire compatibility with the broker. Daemons share a wire *shape*
  (NDJSON, framed) but the protocol vocabularies are distinct;
  callers route by socket path.
- Becoming a generic RPC shim. The verb set is closed and
  enumerated. Operators who want a new verb file an RFC.

## 4. Threat model

Same baseline as the broker (`docs/vault.md:227`): ACL is
misconfiguration protection, not a security boundary. Same-UID
compromise of the host operator is game-over. The daemon defends
against:

- A non-admin agent accidentally invoking a fleet-mutating verb.
- A misconfigured agent attempting to restart another agent without
  the operator's intent.
- Replay of stale verb invocations across a daemon restart.
- An attacker on the network reaching the daemon (it doesn't listen
  on the network; UDS-only).

It does **not** defend against:

- The host operator being compromised. The daemon runs as the
  operator and inherits whatever they can do.
- A compromised admin agent. By policy `admin: true` is a trust
  declaration: if the agent is compromised, the operator's recovery
  path is `switchroom vault lock` + `docker compose down` from the
  host, same as today. The daemon doesn't expand or shrink that
  recovery posture.

## 5. Design

### 5.1 Process model

`switchroom-hostd` is a **Bun-runnable Node module** at
`src/host-control/server.ts`, bundled to
`dist/host-control/server.js`. It runs as a long-lived process owned
by the operator UID.

**v1 supports systemd hosts only.** The daemon is installed as a
`switchroom-hostd.service` user unit by `switchroom setup`
(idempotent, additive). `ExecStart=/usr/bin/env bun
/path/to/dist/host-control/server.js`. Restart=on-failure.

**Why not a compose sidecar in v1.** Reviewer-flagged
(load-bearing): if the daemon runs as part of the same compose
project as the agents, then `update_apply` → `docker compose up -d
--remove-orphans` recreates the daemon mid-flight and the in-progress
update gets killed. That's the same cgroup-escape problem
`gateway.ts:6919–6976` works around with `systemd-run --scope`, just
moved one layer up. A compose-only mode also can't satisfy `switchroom
apply`'s `sudo` self-elevation (per CLAUDE.md "Operator update" §) —
there is no host `sudo` inside a container. v1 therefore declares
compose-only hosts **out of scope** and the gateway falls back to the
existing detached-spawn path with a clear stderr note. A v2
host-helper (a detached host-side process spawned by the daemon that
survives the compose recreate, talking back to the daemon over a
second UDS) is the path to compose-mode support, but it lands its own
RFC.

The daemon does not depend on docker being present; it shells out to
the `switchroom` CLI on the host. On a non-docker install the daemon
still works (it just can't do `update --apply`'s docker-image-pull
step; that path returns a clean error pointing at `switchroom update
--rebuild` instead).

### 5.2 Socket layout (mirrors broker)

```
/run/switchroom/hostd/
  <agent-A>/sock      mode 0660, owner agent-A UID
  <agent-B>/sock      mode 0660, owner agent-B UID
  operator/sock       mode 0600, owner operator UID
```

Same path-as-identity contract as the broker:
`socketPathToIdentity()` parses the bound listen-path, returns
`{kind: "agent", name}` or `{kind: "operator"}`. Reserved name
`"operator"` enforced via `RESERVED_AGENT_NAMES` (already extant in
`src/vault/broker/peercred.ts:84`; extend that set or add a
host-control-local copy).

**Host vs container paths.** Two viewpoints, the same socket file:

- **Host side** (where the daemon binds): `~/.switchroom/hostd/<name>/sock`,
  parent dir mode 0700 owned by operator UID; socket mode 0660 owned
  by the agent UID.
- **Agent-container side** (what the in-container client opens):
  `/run/switchroom/hostd/<name>/sock`, the canonical in-container
  path mirroring the broker's `/run/switchroom/broker/<name>/sock`
  shape.

A compose-emitted bind mount couples the two: `~/.switchroom/hostd/<name>/`
on the host → `/run/switchroom/hostd/<name>/` inside the agent.
Path-as-identity parsing happens on the daemon's bind path
(host-side), so an agent cannot forge identity by renaming its
in-container view. Mirrors the broker pattern at
`src/agents/compose.ts:742-743`.

### 5.3 Wire protocol

NDJSON, max 64 KiB per frame, same framer as `src/vault/broker/protocol.ts`.

```jsonc
// request
{
  "op": "agent_restart",          // verb
  "args": { "name": "klanker", "reason": "user-requested via /restart" },
  "request_id": "f7…",            // client-generated; daemon echoes in response
  "idempotency_key": "f7…-1"      // optional; daemon dedupes within 60s
}

// response — single frame, then connection closes
{
  "request_id": "f7…",
  "result": "started",            // "started" | "completed" | "denied" | "error"
  "exit_code": 0,
  "stdout_tail": "…",             // last 4 KiB; for ack/error UI
  "stderr_tail": "…",
  "duration_ms": 320,
  "audit_id": "2026-05-13T01:23:45.123Z#hostd"
}
```

Verb set (v1, closed):

| Verb | Args | Effect | Trust |
|---|---|---|---|
| `agent_restart` | `name`, `reason`, `force?` | runs `switchroom agent restart <name> [--force]` on host | self → any agent; cross-agent → admin |
| `agent_start` | `name` | `switchroom agent start <name>` | admin |
| `agent_stop` | `name` | `switchroom agent stop <name>` | admin |
| `update_check` | (none) | `switchroom update --check`, returns plan | admin |
| `update_apply` | `skip_images?`, `rebuild?` | `switchroom update --apply [flags]` | admin + operator-attest (see §5.4) |
| `apply` | `non_interactive: true` (forced) | `switchroom apply --non-interactive` | admin + operator-attest |
| `upgrade_status` | (none) | `switchroom update --status` | any |
| `reconcile` | `agent?` | `switchroom reconcile [<agent>]` | admin |
| `get_status` | `request_id` | look up an in-flight or recently-completed mutation by id; returns the same response shape as the original call | matches the gate of the *original* call |

Anything not in this table is rejected with `result: "denied",
error: "verb not in v1 allowlist"`. New verbs land via RFC + table
addition.

**`get_status` in v1, not streamed progress.** Reviewer-flagged
(load-bearing): the long-running verbs (`update_apply` at 20–60s,
`apply` at 5–20s) return `result: "started"` within ~50ms, then run
detached. Without a query mechanism, the gateway can't tell whether a
verb succeeded, failed fast, or is still running — a regression
versus today's `notifyDetachedFailure` (`gateway.ts:7776`) which
catches non-zero exits within ~5s. `get_status` closes the gap:
gateway polls every ~2s for `started`-result verbs, drives the
progress card UI from the response. Cheaper to implement than
streamed-progress frames and lower protocol-complexity. Streamed
frames may still land in v2 if poll-driven UX proves choppy.

### 5.4 Auth model

Three layers, layered fail-closed:

1. **Path-as-identity** (always). Agent identity comes from the bind
   path. Operator socket is mode-0600 + UID-checked.
2. **Verb-allowlist** (always). The verb must be in the v1 table.
3. **Per-verb gate** (per row). Three gate types:
   - **`any`** — no extra check. (Only `upgrade_status` today: it's
     read-only and already exposed to non-admin agents via the
     gateway's `/upgradestatus` handler.)
   - **`admin`** — `config.agents[name].admin === true`. Reuses the
     broker's `isAdminAgent` check (`src/vault/broker/server.ts:1613-1615`).
   - **`admin + operator-attest`** — admin AND the request carries
     a valid operator-passphrase attestation. Reuses the broker's
     existing plaintext-forward pattern verbatim (see the
     "Attestation" paragraph immediately below, and
     `src/vault/broker/server.ts:1668` for the existing reference
     implementation). No new RPCs are added to the broker for the
     daemon's needs.

For `agent_restart` self-targeting (`args.name === caller.identity.name`),
the gate downgrades to `any` — matches the gateway's current behavior
(`/restart` self-targeting works without admin).

The daemon never has the vault passphrase. Attestation reuses the
existing **gateway → broker plaintext-forward** pattern (see
`src/vault/broker/server.ts:1668`, the `vault_request_save` path):
the gateway already caches the operator passphrase after `/vault
unlock` and forwards it on the wire when an admin agent invokes a
privileged verb. The daemon does the same forward over its own
admin-client connection to the broker (mounted at
`/run/switchroom/broker/hostd/sock`). Wrong passphrase → explicit
`DENIED` audit row, exactly mirroring the broker's existing mismatch
path at `server.ts:1668-1695`. No new broker RPCs are added; no
passphrase fingerprint is introduced (an earlier draft sketched a
`status`-op fingerprint, but it would have widened the broker's
same-UID attack surface to offline guessing — struck in favour of
plaintext-forward).

**Trust-loop sanity.** A compromised in-container actor that can
already drive the broker via the agent's vault-request flow can
already attest if `/vault unlock` was recent — that's the existing
envelope, not new surface. The daemon does not enlarge it: it just
exposes a *different* operation set behind the same gate. Recovery
posture (`switchroom vault lock` from the host) is unchanged.

To prevent a name-collision footgun, `hostd` is added to
`RESERVED_AGENT_NAMES` in `src/vault/broker/peercred.ts:84` so an
operator cannot name an agent `hostd` and clash with the daemon's
broker-client socket path.

### 5.5 Audit

Every accepted or denied request appends one NDJSON row to
`~/.switchroom/host-control-audit.log`, sample:

```jsonc
{
  "ts": "2026-05-13T01:23:45.123Z",
  "op": "update_apply",
  "caller": {"kind": "agent", "name": "klanker"},
  "peer_uid": 10042,
  "peer_cgroup": "switchroom-klanker.service",
  "args": {"skip_images": false, "rebuild": false},
  "result": "completed",
  "exit_code": 0,
  "duration_ms": 18420,
  "request_id": "f7…",
  "method": "passphrase-attest"
}
```

Tail consumable by `switchroom audit hostd` (new verb) and by the
admin agents' `/audit hostd` Telegram command (mirrors `/vault audit`).

Log rotation inherits `vault-audit.log`'s policy verbatim
(`logrotate.d/switchroom-vault-audit` per `docs/vault-broker.md` —
size-trigger rotation, retain N generations). The setup helper
installs an analogous `logrotate.d/switchroom-host-control-audit`
fragment.

### 5.6 Gateway integration

The gateway grows one new module
(`telegram-plugin/gateway/host-control-client.ts`) that exposes:

```ts
export async function hostd<T>(op: HostdVerb, args: HostdArgs[op]): Promise<HostdResponse<T>>
```

The six detached spawns (`spawnSwitchroomDetached` callsites for
`agent restart`, `update apply`, `apply`, etc., per the survey) get
replaced with `await hostd("agent_restart", {...})`. The function is
async-but-fast: the daemon returns "started" within ~50ms for
long-running verbs, then the gateway's existing restart-marker /
greeting-card plumbing takes over.

The `isDockerReachable()` guard is replaced by `isHostdReachable()`:
probe `/run/switchroom/hostd/<self>/sock` for socket-presence. On
miss, the error message points operators at `systemctl --user status
switchroom-hostd` (systemd) or `docker compose ps switchroom-hostd`
(compose) instead of "use the host shell".

## 6. Compose / installer changes

`src/agents/compose.ts`:

- **Per-agent socket-volume emission only.** A volume
  `hostd-<name>-sock` per admin agent, alongside `broker-` and
  `kernel-`. Mounted into the agent at `/run/switchroom/hostd/<name>/sock`.
  No singleton container is emitted in v1 — the daemon runs as a
  systemd user unit on the host (see §5.1), not inside compose,
  so the volumes are bound on the host filesystem at
  `~/.switchroom/hostd/<name>/sock` and the agent end of the bind
  references the host path.
- The daemon (running on the host) requires `CAP_CHOWN` and
  `CAP_FOWNER` equivalents to bind per-agent sockets and chown them
  to the agent UID — running as the operator UID handles this on a
  typical desktop install (operator owns `~/.switchroom`), but the
  systemd unit declares `AmbientCapabilities=CAP_CHOWN
  CAP_FOWNER` so a non-root operator can still chown across UIDs.
  Mirrors the broker's `cap_add: [CHOWN, FOWNER, DAC_READ_SEARCH,
  DAC_OVERRIDE]` declared at `src/agents/compose.ts:549-552`.
- Healthcheck (compose-level, for the per-agent socket-presence
  invariant the broker / kernel already pin): `ls
  ~/.switchroom/hostd/*/sock 2>/dev/null | head -1 | grep -q .`,
  emitted on the agent service itself (the daemon has no compose
  service in v1).

`switchroom setup` grows a one-shot step that installs the systemd
unit on systemd hosts. Idempotent; safe to re-run. On non-systemd
hosts (rare), setup prints a clean error pointing at the v2 RFC and
leaves `host_control.enabled` false — existing behavior unchanged.

## 7. Migration / cutover

Phased, behind `host_control.enabled` config flag (default
**false** for v1 to keep existing installs unchanged):

1. **Phase 1** (this RFC, opt-in). Daemon ships. Behaviour is
   determined **strictly** by `host_control.enabled`:
   - **`enabled: true`** → all supported verbs go through the
     daemon. **No silent fallback.** If the daemon is unreachable
     the call returns a clean operator-visible error
     ("`switchroom-hostd` unreachable; check `systemctl --user
     status switchroom-hostd`"). This preserves the §5.5 audit
     guarantee — every privileged call lands in the daemon's audit
     log or fails loudly, never quietly routes around it.
   - **`enabled: false`** (default) → gateway uses the existing
     `spawnSwitchroomDetached` path unchanged. The two code paths
     are *configuration-toggled*, not *fallback-chained*. This
     keeps the detached-spawn path exercised in CI (the default)
     while opt-in operators get the daemon's stronger audit
     posture.

   Reviewer-flagged (load-bearing): an earlier draft proposed
   "prefer daemon, fall back to spawn on socket-miss." Struck —
   silent fallback means a flaky daemon would route privileged
   calls through the un-audited path that §5.5 promises is gone,
   and the audit log would have invisible gaps. Hard fail is the
   right shape.

2. **Phase 2** (v0.9, default-on). Flip the default to `enabled:
   true`. `spawnSwitchroomDetached` is still selectable but
   emits a deprecation warning on every invocation. Operators
   who don't want the daemon explicitly opt out.

3. **Phase 3** (v0.10, removal). Detached-spawn code path
   removed. `host_control.enabled: false` becomes a setup-time
   hard error pointing at the upgrade docs.

Rollback at any phase: set `host_control.enabled: false` and
restart. The detached-spawn path is preserved through phase 2; only
phase 3 makes downgrade harder.

## 8. Alternatives considered

- **Docker socket into admin agents.** Rejected: explicitly
  denylisted in `BIND_MOUNT_EXACT_DENY` (#1166); the daemon centralizes
  the same capability behind audit and verb allowlist instead.
- **SSH-back-to-host.** Adds a key-management surface, a network
  hop, and an SSH daemon dependency. Doesn't mesh with the
  bind-time identity contract (SSH gives wire-payload identity:
  the agent could claim any user).
- **Extend the broker to host verbs.** Tempting (one daemon, one
  socket). Rejected: the broker's threat model assumes it speaks
  vault secrets; mixing host-mutation verbs into the same process
  expands the blast radius of a broker bug and conflates two
  audit streams. Two daemons, two audits.
- **Host-shell-on-rails (no daemon, just a wrapper).** Doesn't
  solve the cgroup-escape problem; doesn't audit; doesn't gate.
- **Sub-process-only (no socket; agents `docker exec` into a host
  helper).** Requires docker socket in agents; same denylist
  problem as bullet 1.

## 9. Open questions

1. **Daemon binary distribution.** Bundled into the existing
   switchroom CLI (one binary, multiple entrypoints) or a separate
   `switchroom-hostd` binary? Leaning bundled — same release
   surface, same version pin, same telemetry — but the survey
   shows the broker and kernel are separate entrypoints. Match
   that pattern or break it?

2. **Long-running verb feedback.** `update_apply` takes 20-60s.
   Single-frame response means the gateway sits and waits. Should
   the wire protocol grow streamed-progress frames (one per stage:
   `pulling`, `recreating`, `health-checking`, `done`) so the
   gateway can edit the progress card in real time? Probably yes,
   but adds protocol complexity — defer to v2 unless the UX is
   visibly bad in v1 testing.

3. **Idempotency window.** Tied to the gateway's existing
   restart-marker debounce at `gateway.ts:7836` / `:7976` — currently
   15s. The daemon's `idempotency_key` cache uses the **same** 15s
   value so a double-tap that gets debounced at the gateway layer
   doesn't slip through to the daemon and vice versa. If the gateway
   debounce gets tuned, the daemon constant follows. (Earlier draft
   said 60s — struck; layer-divergence was the reviewer's
   correction.)

4. **Operator-attest cache.** The broker caches the operator
   passphrase after `/vault unlock`. Does the daemon get its own
   cache, or does every privileged verb re-attest through the
   broker? Re-attest is simpler and more auditable; daemon caching
   is faster. Lean re-attest; revisit if latency hurts.

5. **Multi-host fleets.** Out of scope today (switchroom is
   single-host). If switchroom ever fans out to multiple hosts,
   the daemon's "operator UID" assumption breaks. Note for the
   future, don't design for it now.

## 10. Verdict / next steps

If accepted:

1. Implement `src/host-control/server.ts` + `src/host-control/client.ts`
   + `src/host-control/protocol.ts`, mirroring the broker's file
   layout.
2. Wire compose: emit per-agent `hostd-<name>-sock` bind mounts on
   admin-flagged agents (host source: `~/.switchroom/hostd/<name>/`;
   container target: `/run/switchroom/hostd/<name>/`). **No** compose
   singleton — the daemon is a systemd user unit on the host. Earlier
   draft step said "new singleton + per-agent socket volumes"; the
   singleton half is struck for v1 (see §5.1 for why; compose-mode
   support is deferred to a v2 host-helper RFC).
3. Replace the six `spawnSwitchroomDetached` callsites in the
   gateway behind the `host_control.enabled` flag.
4. Add `switchroom audit hostd` verb + Telegram `/audit hostd`.
5. Tests: unit (verb gates, idempotency, allowlist), integration
   (host daemon + in-agent client round-trip with a fake CLI binary),
   e2e (admin agent triggers `update_apply`, verifies the deploy lands).

Effort estimate: **~180–240 agent minutes** for v1 (skinny verb
set, opt-in flag, hard-fail-when-enabled, `get_status` query verb,
systemd-host only). v2 (compose-mode support via a host-helper +
streamed-progress frames if poll UX is choppy): another **~60–90
agent minutes**.

## 11. Relation to #1166 (bind_mounts)

See §13 below for the rectification. Short version: bind_mounts
stays as a *general* primitive (shared collab dirs, RW config-edit
case) but the dogfood framing in `docs/configuration.md` is wrong
and gets rewritten to point at `repos:` + this daemon. Keep, don't
revert.
