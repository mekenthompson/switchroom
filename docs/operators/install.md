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

# 3. Apply the config: scaffold agents + write docker-compose.yml.
#    Writes ~/.switchroom/compose/docker-compose.yml.
switchroom apply

# 4. Bring the fleet up yourself with docker compose.
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
```

`switchroom apply` only scaffolds + writes the compose file — it does
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
release tag, set `imageTag` directly when calling `generateCompose()`
programmatically (CLI-level `--image-tag` plumbing is a follow-up).

## Dev-time: building locally

When you're iterating on the Dockerfiles themselves (or on the source
that gets baked into the images via `npm run build`), you don't want
`docker compose up` to pull a stale GHCR image. Use `--build-local`:

```sh
cd ~/code/switchroom
switchroom apply --build-local        # context = cwd
# or
switchroom apply --build-local /alt/checkout/path

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
switchroom apply
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
```

## Troubleshooting

- **First `docker compose up` is slow** — pulls 5 images
  (~1-2 GB total) on a fresh host. Subsequent `up` calls only pull
  changed layers.
- **`unauthorized` on pull** — the published images are public; if you
  see auth errors, you're either pointing at a private fork or your
  Docker daemon is configured with a stale GHCR credential. `docker
  logout ghcr.io` clears it.
- **`docker compose up` hangs** — usually compose waiting for a
  `depends_on` healthcheck. Inspect with `docker compose -p switchroom
  ps` in another terminal.

<a id="ghcr-auth"></a>
## GHCR auth

Switchroom's container images are intended to be public on
`ghcr.io/switchroom/...`. If you've forked the repo, or if the org's
package visibility is set to private, anonymous `docker pull` will
return `401 Unauthorized`. The fix is to authenticate Docker against
GHCR with a personal access token that has `read:packages` scope. The
easiest path uses the GitHub CLI:

```sh
# Mint a token with read:packages scope (interactive, one-time).
gh auth login --hostname github.com --scopes read:packages

# Hand the token to docker. -u must be your GitHub username.
gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
```

Subsequent `docker compose pull` calls will reuse the credential cached
in `~/.docker/config.json`. To clear it: `docker logout ghcr.io`.

If you don't have `gh` available, mint a classic PAT via the GitHub
web UI (Settings → Developer settings → Personal access tokens →
`read:packages`) and pipe it into `docker login ghcr.io -u <user> --password-stdin` directly.

## Related

- `runtime-mode.md` — Docker is the only supported runtime in v0.7+.
- `migration-v0.7.md` — upgrading from the v0.6 systemd runtime.
- `docs/proposed/docker-images.yml` — the GHCR build/push workflow.
