#!/usr/bin/env bash
# Phase 0 ACL matrix driver.
# Drives the spike against whatever Docker engine modes are available
# locally and emits structured rows the matrix doc consumes.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
RESULTS_DIR="${HERE}/results"
mkdir -p "$RESULTS_DIR"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

run_env() {
  local env_label="$1"
  local docker_host="$2"   # may be empty for default
  local out="${RESULTS_DIR}/${env_label}-${TS}.log"

  echo "============================================================"
  echo "ENV: $env_label  DOCKER_HOST=${docker_host:-<default>}"
  echo "============================================================"
  {
    echo "## env=$env_label DOCKER_HOST=${docker_host:-<default>} at $TS"
    if [ -n "$docker_host" ]; then export DOCKER_HOST="$docker_host"; else unset DOCKER_HOST; fi

    echo "### docker version"
    docker version --format 'client={{.Client.Version}} server={{.Server.Version}}' 2>&1 || true
    echo "### docker info security"
    docker info --format '{{.SecurityOptions}}' 2>&1 || true
    echo "### docker info rootless"
    docker info --format 'rootless={{.SecurityOptions}} cgroup={{.CgroupDriver}}/{{.CgroupVersion}}' 2>&1 || true

    cd "$HERE"

    echo "### compose down (clean slate)"
    docker compose down -v --remove-orphans 2>&1 || true

    echo "### compose build"
    if ! docker compose build 2>&1; then
      echo "RESULT: build-failed"
      return 1
    fi

    echo "### compose up -d (alice+bob+broker)"
    if ! docker compose up -d broker agent-alice agent-bob 2>&1; then
      echo "RESULT: up-failed"
      docker compose logs 2>&1 || true
      return 1
    fi

    # Give the broker a moment to bind sockets.
    sleep 2
    echo "### broker logs (post-start)"
    docker compose logs broker 2>&1 | tail -40

    echo "### in-container fs view (alice)"
    docker compose exec -T agent-alice ls -la /run/switchroom/broker 2>&1 || true
    docker compose exec -T agent-alice ls -la /run/switchroom/broker/alice 2>&1 || true
    echo "### in-container fs view (bob)"
    docker compose exec -T agent-bob   ls -la /run/switchroom/broker 2>&1 || true
    docker compose exec -T agent-bob   ls -la /run/switchroom/broker/bob   2>&1 || true

    echo "### >>> AGENT-ALICE CLIENT"
    docker compose exec -T agent-alice node /opt/agent/agent-client.mjs 2>&1
    local alice_rc=$?
    echo "### alice client exit=$alice_rc"

    echo "### >>> AGENT-BOB CLIENT"
    docker compose exec -T agent-bob node /opt/agent/agent-client.mjs 2>&1
    local bob_rc=$?
    echo "### bob client exit=$bob_rc"

    echo "### >>> TMUX INTERRUPT TEST (alice)"
    docker compose exec -T agent-alice /opt/agent/test-tmux-interrupt.sh 2>&1
    local tmux_rc=$?
    echo "### tmux test exit=$tmux_rc"

    echo "### >>> CROSS-MOUNT (HOSTILE) TEST"
    # Spin up the misconfigured-bob container (compose `hostile` profile).
    # Even with both socket dirs visible, fs perms on alice's dir
    # (0700 owned by uid 10001) must block bob (uid 10002) from
    # connecting to alice's socket.
    if docker compose --profile hostile up -d agent-bob-misconfigured 2>&1; then
      sleep 1
      echo "### hostile container fs view"
      docker compose exec -T agent-bob-misconfigured ls -la /run/switchroom/broker 2>&1 || true
      docker compose exec -T agent-bob-misconfigured ls -la /run/switchroom/broker/alice 2>&1 || true
      echo "### hostile attempt: bob (10002) connects to alice's socket"
      docker compose exec -T agent-bob-misconfigured node /opt/agent/agent-client.mjs 2>&1
      local hostile_rc=$?
      echo "### hostile client exit=$hostile_rc (nonzero == cross-mount blocked, which is the desired outcome)"
    else
      echo "### hostile up failed"
      local hostile_rc=99
    fi

    echo "### compose down -v"
    docker compose --profile hostile down -v --remove-orphans 2>&1 || true

    echo "### SUMMARY env=$env_label alice_rc=$alice_rc bob_rc=$bob_rc tmux_rc=$tmux_rc hostile_rc=$hostile_rc"
  } 2>&1 | tee "$out"
  echo "log: $out"
}

# Discover which environments are reachable.
echo ">>> Phase 0 matrix run at $TS"
echo ">>> uname: $(uname -a)"
echo ">>> id: $(id)"
echo ">>> docker context ls"
docker context ls 2>&1 || true

# 1. Linux rootful (default).
run_env "linux-rootful" "" || true

# 2. Linux rootless — only if a rootless context or systemd --user docker is present.
ROOTLESS_HOST=""
if systemctl --user is-active docker.service >/dev/null 2>&1; then
  ROOTLESS_HOST="unix:///run/user/$(id -u)/docker.sock"
elif [ -S "/run/user/$(id -u)/docker.sock" ]; then
  ROOTLESS_HOST="unix:///run/user/$(id -u)/docker.sock"
fi
if [ -n "$ROOTLESS_HOST" ]; then
  run_env "linux-rootless" "$ROOTLESS_HOST" || true
else
  echo ">>> SKIP linux-rootless: no rootless docker socket detected at /run/user/$(id -u)/docker.sock"
fi

echo ">>> done. results in $RESULTS_DIR"
