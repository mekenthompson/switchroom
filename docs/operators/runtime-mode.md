# Runtime mode — Docker vs systemd

Switchroom can run its agent fleet in one of two runtimes:

- **Docker** — each agent runs in its own container, brought up by a
  generated `docker-compose.yml`. This is the default on Linux as of
  Phase 3b-3.
- **systemd** (legacy) — each agent runs as a `switchroom-<name>` user
  unit on the host. This is what every Switchroom install used before
  Phase 3b and remains supported.

The active runtime is recorded in `~/.switchroom/runtime-mode`, which
contains a single line: `docker` or `host`.

## How `switchroom up` chooses

`switchroom up` looks at four inputs and picks one of the two
runtimes:

| Platform | Marker        | Systemd installed? | Flag        | Runtime | Marker after |
| -------- | ------------- | ------------------ | ----------- | ------- | ------------ |
| Linux    | _absent_      | no                 | _none_      | docker  | `docker`     |
| Linux    | _absent_      | yes                | _none_      | host*   | _unchanged_  |
| Linux    | _absent_      | any                | `--legacy`  | host    | `host`       |
| Linux    | `docker`      | any                | _ignored_   | docker  | _unchanged_  |
| Linux    | `host`        | any                | _ignored_   | host    | _unchanged_  |
| non-Linux| any           | any                | any         | host    | _unchanged_  |

*The "Linux + systemd installed + no flag" row also prints a one-time
advisory:

```
You're on the legacy systemd runtime.
Run `switchroom migrate to-docker` to move to the Docker runtime,
or `switchroom up --legacy` to silence this notice.
```

The advisory keeps firing on every `up` until the operator either
migrates or explicitly opts in with `--legacy` (which writes
`runtime-mode = host` and silences future advisories).

## Choosing a runtime

Pick **Docker** if:

- You're on a fresh Linux host and don't have a strong reason
  otherwise.
- You want hard-isolated agents — each in its own container with its
  own UID, no shared sockets across agents.
- You want easier upgrades (`docker compose pull && switchroom up`
  vs systemd unit reconciliation).

Pick **systemd** if:

- You're already running on systemd and not ready to migrate.
- You're on a host without Docker and don't want to install it.
- Your environment forbids container runtimes (compliance,
  policy).

## Migrating between runtimes

Use `switchroom migrate to-docker` (Phase 3b-2) to move from systemd to
Docker. It runs preflight checks, generates compose, brings the docker
fleet up, stops + disables the systemd units, and writes
`runtime-mode = docker`. On any failure it rolls back automatically and
leaves you on the original runtime.

`switchroom migrate to-host` reverses the above.

## The `--legacy` opt-out

`switchroom up --legacy` forces the systemd path even on a fresh Linux
host where Docker would otherwise be the default. Use it when:

- You're scripting an install on a host where Docker isn't available.
- You see the legacy advisory but explicitly want to keep using
  systemd for the foreseeable future — `--legacy` writes the marker so
  the advisory stops firing.

`--legacy` is Linux-only (other platforms always use the systemd path
today; macOS Docker support is Phase 3d).

## Doctor: runtime-coexistence check

`switchroom doctor` includes a `runtime coexistence` check (Phase
3b-3) that warns when the marker says one runtime but the host still
has the other one's state in place — e.g. `runtime-mode = docker` but
`switchroom-*` systemd units are still enabled.

This is **a warning, not a failure**. Coexistence is legitimate during
a migration window — operators bring the new runtime up before tearing
the old one down. If the warning persists after migration:

- **`runtime-mode = docker` + systemd units enabled** → run
  `systemctl --user disable --now 'switchroom-*'` to clear the
  legacy state. (Or re-run `switchroom migrate to-docker` so the
  finalize step takes care of it.)
- **marker absent + systemd units enabled** → run
  `switchroom up --legacy` to pin the marker and silence the
  ambiguity, or run `switchroom migrate to-docker` to flip.
