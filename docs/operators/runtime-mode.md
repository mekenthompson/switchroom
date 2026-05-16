# Runtime mode — Docker on Linux

Switchroom runs its agent fleet as Docker containers brought up by a
generated `docker-compose.yml`. This is the only supported production
runtime.

The canonical lifecycle command is **`switchroom update`** — it pulls
images, runs `apply`, recreates changed containers, and runs a focused
`doctor` sweep, in one operator step:

```sh
switchroom update              # pull + apply + recreate + doctor
switchroom update --check      # dry-run: print the plan, exit 0
```

`switchroom apply` (scaffold every agent + write the compose file from
`switchroom.yaml`) is also available standalone for a scaffold-only
change.

Raw `docker compose` is a **debugging fallback only**:

```sh
switchroom apply
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
```

> ⚠️ Do **not** routinely use raw `docker compose up -d
> --remove-orphans` for fleet bring-up. It bypasses the operator
> restart-marker, so the agents' boot cards render as a *crash* (and
> notify the fleet) instead of a clean restart. Use `switchroom
> update` (or `switchroom agent restart`) for normal operation; reach
> for raw compose only when diagnosing the compose layer itself.

See [`install.md`](./install.md) for the full operator install flow
(curl one-liner, prerequisites, GHCR auth, dev-time `--build-local`
mode, upgrade procedure). Linux is the only release-validated production
target; macOS (Docker Desktop) is supported for development.
