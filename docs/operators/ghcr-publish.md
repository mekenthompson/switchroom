# GHCR publishing — operator guide

Phase 3a-3 of the Docker migration ships two pieces:

1. A multi-arch GHCR build/push workflow (staged as
   `docs/proposed/docker-images.yml` — see "Manual install" below).
2. A digest-pin mode in the compose generator
   (`src/agents/compose.ts`) so production deploys can target immutable
   image refs instead of floating `:latest` / `:edge` tags.

## Workflow file location

The workflow YAML lives at `docs/proposed/docker-images.yml` in this PR
because the bot OAuth token used to land the change does not carry the
`workflow` scope GitHub requires for writes under `.github/workflows/`.
Once the PR is merged, an operator with a workflow-scoped token must
move the file:

```bash
git checkout main && git pull
git mv docs/proposed/docker-images.yml .github/workflows/docker-images.yml
git commit -m "ci: enable docker-images workflow"
git push
```

The workflow then activates on the next push to `main` or tag matching
`v*`.

## What the workflow does

- **Triggers:** push to `main`, push of a `v*` tag, or pull request
  against `main`. PRs build only (no push) so a Dockerfile typo can't
  poison the registry.
- **Matrix:** five images (`base`, `agent`, `broker`, `kernel`,
  `scheduler`), each from `docker/Dockerfile.<name>`.
- **Multi-arch:** `linux/amd64` + `linux/arm64` via QEMU + Buildx.
- **Tags on push to main:** `:edge` and `:sha-<short>`.
- **Tags on `v*` tag push:** `:<version>` and `:latest`.
- **Cache:** `type=gha` scoped per image, `mode=max` on writes — so
  iterative pushes only rebuild changed layers.
- **Auth:** the workflow uses `GITHUB_TOKEN` with `packages: write`. No
  PAT required.

## Pulling a digest from GHCR

After a successful publish, capture the immutable digest for each
image:

```bash
docker buildx imagetools inspect \
  ghcr.io/switchroom/switchroom-agent:edge \
  --format '{{json .Manifest.Digest}}'
```

Repeat for `base`, `broker`, `kernel`, `scheduler`.

## Pinning compose to digests

The compose generator accepts a `ghcrDigests` option:

```ts
import { generateCompose } from "@switchroom/agents/compose";

const yaml = generateCompose({
  config,
  ghcrDigests: {
    agent:     "sha256:...",
    broker:    "sha256:...",
    kernel:    "sha256:...",
    scheduler: "sha256:...",
  },
});
```

When provided, each service's `image:` is rewritten from
`ghcr.io/switchroom/switchroom-<name>:<tag>` to
`ghcr.io/switchroom/switchroom-<name>@sha256:<digest>`. Partial maps
are tolerated — any image without a pin falls back to the legacy
tag-based ref.

Digests must match `^sha256:[0-9a-f]{64}$`; malformed values throw at
generation time rather than failing later inside `docker compose up`.

## Why pin?

`:latest` and `:edge` move every push to main. Two hosts pulling the
same tag minutes apart can end up running different code. `@sha256:...`
is content-addressed — once published, it never changes, and a
production rollout that worked yesterday will work the same way today.
