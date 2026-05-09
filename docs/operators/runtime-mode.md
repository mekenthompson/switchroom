# Runtime mode — Docker on Linux

Switchroom v0.7+ runs its agent fleet as Docker containers brought up by
a generated `docker-compose.yml`. This is the only supported production
runtime. The legacy systemd path was removed in v0.7 (see
[`migration-v0.7.md`](./migration-v0.7.md)).

Three commands cover the full lifecycle:

```sh
switchroom apply
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d --remove-orphans
```

`switchroom apply` scaffolds every agent and writes the compose file
derived from your `switchroom.yaml`. The CLI deliberately does not call
`docker` for you — operators control the bring-up.

See [`install.md`](./install.md) for the full operator install flow
(curl one-liner, prerequisites, GHCR auth, dev-time `--build-local`
mode, upgrade procedure). Linux is the only release-validated production
target; macOS (Docker Desktop) is supported for development.
