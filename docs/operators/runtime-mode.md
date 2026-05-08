# Runtime mode — Docker on Linux

Switchroom v0.7+ runs its agent fleet as Docker containers brought up by
a generated `docker-compose.yml`. This is the only supported production
runtime. The legacy systemd path was removed in v0.7 (see
[`migration-v0.7.md`](./migration-v0.7.md)).

```sh
switchroom apply
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
```

`switchroom apply` scaffolds every agent and writes the compose file
derived from your `switchroom.yaml`. The CLI deliberately does not call
`docker` for you — operators control the bring-up.

## Installing from GHCR

The Docker runtime pulls its 5 fleet images from
`ghcr.io/switchroom/switchroom-{base,agent,broker,kernel,scheduler}`.
See [`install.md`](./install.md) for the operator install flow
(`git clone` + `bun install` + `switchroom setup` + `switchroom apply` +
`docker compose ... up -d`), upgrade procedure, and the dev-time
`--build-local` mode.

## Production runtime declaration

Linux is the only supported production runtime. macOS (Docker Desktop)
is tracked as Phase 3.5 and not yet validated for production use.
