# Vault Broker — ACL model and access guide

The vault broker runs as the `switchroom-vault-broker` container (a
`docker compose` singleton in the `switchroom` project) and
authenticates connecting clients by the socket path the connection
arrived on (`/run/switchroom/broker/<agent>/sock`, a broker-controlled
per-agent socket), not by parsing systemd cgroups. Cron is the in-agent
`agent-scheduler` sidecar (since Phase 4 — see
[scheduling.md](scheduling.md)); there are no
`switchroom-<agent>-cron-N.service` systemd units. The ACL contract —
"only declared `secrets:`, only the scheduled run for that agent" — and
the per-agent `secrets:` allowlist drive what each scheduled task can
read.

**Scope / see also:** this is the **broker internals** doc (ACL model, path-as-identity contract, socket layout). For day-to-day operator use, see [vault.md](vault.md); for the security/threat model and auth-path selection, see [vault-security.md](vault-security.md); for boot-time auto-unlock setup and recovery, see [auto-unlock.md](auto-unlock.md).

## What is the vault broker?

The vault broker is a long-running container that holds the decrypted
vault in memory and serves secrets to authorised **switchroom agents'
scheduled runs** over a per-agent Unix socket. It avoids re-prompting
for the vault passphrase on every scheduled run.

The broker is **not** a general-purpose secret server.  It only serves a
scheduled run's declared `secrets[]` keys for the agent that owns the
socket — it does not serve interactive shells, Claude Code sessions, or
arbitrary scripts.

## Who can read from the broker?

| Caller context | Broker access |
|---|---|
| Scheduled run for `agent-<name>` (via that agent's bound socket) | Allowed if the requested key is in `schedule[N].secrets` |
| Interactive shell (`switchroom vault get`) | **Denied** — use `--no-broker` |
| Claude Code / agent session | **Denied** — use `--no-broker` |
| Any other caller | **Denied** |

Identity is **path-as-identity**: compose binds one socket per agent at
`/run/switchroom/broker/<agent>/sock`, chowned to that agent's UID at
mode 0600 at bind time. The broker derives the calling agent's name from
that bind path via `socketPathToAgent` (`src/vault/broker/peercred.ts`).
Because the path is broker-controlled — never sent by the caller — it
cannot be forged from userspace.

## Why are agents denied?

The broker's ACL is misconfiguration protection, not a security boundary
(see `docs/architecture.md`).  Allowing arbitrary agent sessions to read the
vault would mean any skill or sub-agent could exfiltrate any secret.  A
scheduled run receives only the keys explicitly listed in its
`schedule[N].secrets` allowlist.

> The CLI's denial string and some legacy ACL internals still say
> "switchroom cron unit" — that vocabulary predates the Phase 4
> cron-fold-in. It now means "a scheduled run dispatched by the
> in-agent `agent-scheduler` sidecar", identified by the per-agent
> socket bind path.

Agent sessions are expected to receive secrets as environment variables
injected by the cron job itself, not by querying the broker at runtime.

## The `--no-broker` escape hatch

For one-off interactive reads — debugging, scripting, manual key inspection —
pass `--no-broker` to bypass the broker entirely and decrypt the vault file
directly with your passphrase:

```sh
switchroom vault get my-key --no-broker
```

This prompts for the vault passphrase (or reads `SWITCHROOM_VAULT_PASSPHRASE`
from the environment) and reads the vault file directly.  It does not require
the broker to be running.

## Recognising a broker denial in script output

When a script or sub-process calls `switchroom vault get` and the broker
denies the request, the CLI writes a clearly-prefixed error to **stderr**:

```
VAULT-BROKER-DENIED [DENIED]: caller is not a switchroom cron unit; use 'switchroom vault get --no-broker' for interactive access
Hint: run 'switchroom vault get --no-broker <key>' for interactive (non-cron) access.
```

Exit code is **2** for an ACL denial, **3** for a locked broker.

Scripts that capture subprocess output should grep stderr for the
`VAULT-BROKER-DENIED` prefix to detect and surface this error rather than
swallowing it.

## Format hints (`--format` / `--expect`)

Vault entries can carry an optional format annotation set at write time:

```sh
# Store a PEM private key and annotate it
switchroom vault set my-key --format pem < key.pem

# Store a 32-byte raw seed (base64-encoded)
switchroom vault set my-key --format base64-raw-seed < seed.b64
```

Allowed format values: `pem`, `base64-raw-seed`, `base64`, `json`, `string`
(default).

At read time, consumers can declare what they expect:

```sh
switchroom vault get my-key --expect pem
```

If the stored format does not match `--expect`, the CLI writes a
`VAULT-FORMAT-MISMATCH` warning to stderr and continues (warn-and-proceed).
Pass `--strict-format` to turn the mismatch into a hard exit-4 failure.

## Configuring secrets for cron access

In `switchroom.yaml`, list the vault keys each scheduled run is allowed to
read:

```yaml
agents:
  myagent:
    schedule:
      - cron: "0 8 * * *"
        prompt: "Run the daily job"
        secrets:
          - my-api-key
          - other-token
```

The broker enforces this list exactly: `switchroom-myagent-cron-0.service` may
read `my-api-key` and `other-token` but nothing else.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `VAULT-BROKER-DENIED [DENIED]: caller is not a switchroom cron unit` | Running interactively or in an agent session | Add `--no-broker` |
| `broker locked and stdin is not a TTY` | Broker running but not yet unlocked | Unlock with `switchroom vault broker unlock` or wait for the next passphrase prompt |
| `broker socket not found` | Broker daemon not running | Start with `switchroom vault broker start` |
| `VAULT-FORMAT-MISMATCH` | Stored format differs from `--expect` | Re-store with correct `--format`, or convert the value |
