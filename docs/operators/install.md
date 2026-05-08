# Operator install — Docker fleet from GHCR

Switchroom publishes its container images to GitHub Container Registry
(GHCR) at `ghcr.io/switchroom/switchroom-{base,agent,broker,kernel,scheduler}`.
The supported install path on Linux pulls those images and brings the
fleet up via `docker compose`. No `docker build` on the operator's host.

## Prerequisites

- Linux (Ubuntu 24.04 LTS canonical; other distros work).
- Docker Engine 24+ with the compose v2 plugin (`docker compose ...`).
- Bun (used for the `switchroom` CLI itself — the agent runtime is in
  containers, but the CLI runs on the host).

## Install

```sh
# 1. Get the source (the CLI ships from this repo).
git clone https://github.com/switchroom/switchroom.git ~/code/switchroom
cd ~/code/switchroom
bun install
bun run build

# 2. Generate per-host config + first-run wiring.
switchroom setup           # interactive wizard

# 3. Generate the compose file from your switchroom.yaml.
#    Writes ~/.switchroom/compose/docker-compose.yml.
switchroom compose generate

# 4. Bring the fleet up yourself with docker compose.
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
```

`switchroom compose generate` only writes the compose file — it does
not call `docker`. Operators control the bring-up so the CLI never has
to second-guess your docker setup, daemon socket, or rootless config.

## Image refs

The generated compose pins each service to a tagged GHCR ref:

```
ghcr.io/switchroom/switchroom-broker:latest
ghcr.io/switchroom/switchroom-kernel:latest
ghcr.io/switchroom/switchroom-scheduler:latest
ghcr.io/switchroom/switchroom-agent:latest
```

`:latest` floats with the canonical repo's `main`. To pin to a specific
release tag, pass `--image-tag v0.6.5` to whichever generator step you
use, or set `imageTag` directly when calling `generateCompose()`
programmatically. (CLI-level `--image-tag` plumbing is a follow-up; for
v0.6 the default `:latest` is the supported path.)

## Dev-time: building locally

When you're iterating on the Dockerfiles themselves (or on the source
that gets baked into the images via `npm run build`), you don't want
`docker compose up` to pull a stale GHCR image. Use `--build-local`:

```sh
cd ~/code/switchroom
switchroom compose generate --build-local        # context = cwd
# or
switchroom compose generate --build-local /alt/checkout/path

docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d --build
```

This emits `build:` blocks instead of `image:` refs in the generated
compose. Pass `--build` to `docker compose up` to actually rebuild. The
production path (no flag) is unaffected.

## Upgrading

```sh
cd ~/code/switchroom
git pull
bun install
bun run build
switchroom compose generate
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
```

## Troubleshooting

- **First `up` is slow** — `docker compose up -d` pulls 5 images
  (~1-2 GB total) on a fresh host. Subsequent `up` calls only pull
  changed layers.
- **`unauthorized` on pull** — the published images are public; if you
  see auth errors, you're either pointing at a private fork or your
  Docker daemon is configured with a stale GHCR credential. `docker
  logout ghcr.io` clears it.
- **`docker compose up` hangs** — usually compose waiting for a
  `depends_on` healthcheck. Inspect with `docker compose -p switchroom
  ps` in another terminal.

## Related

- `runtime-mode.md` — Docker is the supported production runtime; the
  legacy systemd path is reached via `switchroom agent` lifecycle verbs.
- `docs/proposed/docker-images.yml` — the GHCR build/push workflow.
  Note: as of this PR the workflow file is staged at `docs/proposed/`
  rather than `.github/workflows/` because the OAuth token used to land
  changes lacks the `workflow` scope. An operator with a workflow-scoped
  token must `git mv` it into place to activate publishing:

  ```sh
  git mv docs/proposed/docker-images.yml .github/workflows/docker-images.yml
  git commit -m "ci: enable docker-images workflow"
  git push
  ```

  After the workflow lands, the next push to `main` and any future `v*`
  tag will publish images that downstream operators can pull.
