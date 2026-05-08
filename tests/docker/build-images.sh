#!/usr/bin/env bash
# Phase 1b helper — build all 5 images locally with the :phase1b-test tag
# so tests/docker/e2e.test.ts can find them. CI does the same via the
# multi-arch workflow at .github/workflows/docker-images.yml.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAG="${SWITCHROOM_DOCKER_TAG:-phase1b-test}"

echo "[build-images] running npm build (emits dist/ bundles required by COPY directives)"
( cd "$ROOT" && npm run build )

echo "[build-images] base"
docker buildx build -t "switchroom/base:${TAG}" -f "$ROOT/docker/Dockerfile.base" --load "$ROOT"

for img in agent broker kernel scheduler; do
  echo "[build-images] ${img}"
  docker buildx build \
    --build-arg "BASE_IMAGE=switchroom/base:${TAG}" \
    -t "switchroom/${img}:${TAG}" \
    -f "$ROOT/docker/Dockerfile.${img}" \
    --load \
    "$ROOT"
done

echo "[build-images] done. Sizes:"
docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}' | grep ":${TAG}" | sort
