# Runtime mode — Docker vs systemd

Switchroom can run its agent fleet in one of two runtimes:

- **Docker** — each agent runs in its own container, brought up by a
  generated `docker-compose.yml`. This is the supported production
  runtime on Linux.
- **systemd (legacy)** — each agent runs as a `switchroom-<name>` user
  unit on the host. Reached via the `switchroom agent` lifecycle verbs
  (`switchroom agent start`, `switchroom agent restart`, ...).

## Docker

```sh
switchroom compose generate
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
```

`switchroom compose generate` writes the compose file derived from your
`switchroom.yaml`. The CLI deliberately does not call `docker` for you
— operators control the bring-up.

## Installing from GHCR

The Docker runtime pulls its 5 fleet images from
`ghcr.io/switchroom/switchroom-{base,agent,broker,kernel,scheduler}`.
See [`install.md`](./install.md) for the operator install flow
(`git clone` + `bun install` + `switchroom setup` + `switchroom compose
generate` + `docker compose ... up -d`), upgrade procedure, and the
dev-time `--build-local` mode.

## Production runtime declaration (v0.6)

Linux is the only supported production runtime. macOS and Windows can
run the fleet under Docker Desktop on a best-effort basis for development
and demo use, but are not the supported production target.
