# Runtime mode — Docker vs systemd

Switchroom can run its agent fleet in one of two runtimes:

- **Docker** — each agent runs in its own container, brought up by a
  generated `docker-compose.yml`. This is the default on Linux.
- **systemd (legacy)** — each agent runs as a `switchroom-<name>` user
  unit on the host. Pass `--legacy` to opt in.

## Choosing

```sh
switchroom up           # Linux: Docker; non-Linux: systemd
switchroom up --legacy  # always systemd
```

That's it. There is no marker file, no advisory, no `switchroom migrate`
command. The flag is read fresh on every invocation.

## Production runtime declaration (v0.6)

Linux is the only supported production runtime. macOS and Windows can
run the fleet under Docker Desktop on a best-effort basis for development
and demo use, but are not the supported production target.
