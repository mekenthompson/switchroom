#!/bin/sh
# switchroom/hindsight entrypoint shim.
#
# RFC H §4.8 — ephemeral consumer pattern. The auth-broker binds a
# per-consumer UDS at /run/switchroom/auth-broker/hindsight/sock on
# the broker side; the hindsight compose project bind-mounts the
# `auth-broker-hindsight-sock` named volume into this container at
# /run/switchroom/auth-broker/, so the socket is reachable here as
# /run/switchroom/auth-broker/sock (the consumer's single-socket
# view of its own bind).
#
# Boot flow:
#   1. Wait up to ${WAIT_TIMEOUT_S} for the broker socket to appear
#      (broker may still be starting on the host).
#   2. Run hindsight-fetch-creds.cjs once (LABEL=boot) — fetches creds,
#      writes the tmpfs dotfile.
#   3. Spawn a background refresh loop that re-runs the fetcher every
#      ${REFRESH_S} seconds (LABEL=refresh). RFC H §4.8 step 6:
#      "Hindsight re-fetches via get-credentials after its tmpfs copy
#      ages out." The broker refreshes its canonical creds at the
#      60-min threshold; this loop runs at half that by default
#      (1800s = 30 min) so we stay safely ahead of access-token
#      expiry while not hammering the broker.
#   4. Export CLAUDE_CONFIG_DIR so the claude-agent-sdk picks up the
#      credentials.
#   5. exec into the upstream CMD ("$@"), preserving PID 1 + signal
#      handling so docker's --restart unless-stopped backs off cleanly.
#      The refresh loop survives the exec as a sibling shell process;
#      it dies when the container dies.
#
# Env-var knobs (all have safe defaults; tests override):
#   SWITCHROOM_AUTH_BROKER_SOCKET   broker socket path
#                                   default /run/switchroom/auth-broker/sock
#   SWITCHROOM_HINDSIGHT_CRED_DIR   where to write the dotfile
#                                   default /run/claude-creds
#   SWITCHROOM_HINDSIGHT_WAIT_S     socket-wait timeout in seconds
#                                   default 60
#   SWITCHROOM_HINDSIGHT_REFRESH_S  refresh-loop interval in seconds
#                                   default 1800 (30 min)
#                                   set to 0 to disable the loop (test only)
#
# Fail-loud — every step has an explicit exit. We never boot hindsight
# with empty/missing credentials; better to crash-loop with a clear
# log line than 500 every request.
set -eu

SOCKET="${SWITCHROOM_AUTH_BROKER_SOCKET:-/run/switchroom/auth-broker/sock}"
CRED_DIR="${SWITCHROOM_HINDSIGHT_CRED_DIR:-/run/claude-creds}"
CRED_FILE="${CRED_DIR}/.credentials.json"
WAIT_TIMEOUT_S="${SWITCHROOM_HINDSIGHT_WAIT_S:-60}"
REFRESH_S="${SWITCHROOM_HINDSIGHT_REFRESH_S:-1800}"
FETCHER="${SWITCHROOM_HINDSIGHT_FETCHER:-/usr/local/lib/switchroom/hindsight-fetch-creds.cjs}"

log() { echo "switchroom-hindsight-entrypoint: $*" >&2; }

# 1. Wait for the broker socket. The broker may still be starting on
# the host when this container boots (no cross-project depends_on).
i=0
while [ ! -S "${SOCKET}" ]; do
  i=$((i + 1))
  if [ "${i}" -ge "${WAIT_TIMEOUT_S}" ]; then
    log "auth-broker socket ${SOCKET} did not appear within ${WAIT_TIMEOUT_S}s; giving up"
    exit 1
  fi
  sleep 1
done

# 2. Cred dir.
mkdir -p "${CRED_DIR}"
chmod 0700 "${CRED_DIR}"

# 3. Boot-time fetch. The fetcher exits non-zero on any error; we
# refuse to boot hindsight with broken or missing credentials.
SOCKET="${SOCKET}" CRED_FILE="${CRED_FILE}" LABEL=boot node "${FETCHER}" || {
  log "boot credential fetch failed; refusing to boot hindsight"
  exit 1
}

# Sanity-check the file landed (defense-in-depth — the fetcher already
# exits non-zero on failure, but a stale layer / mount weirdness could
# still leave the dotfile missing).
[ -s "${CRED_FILE}" ] || {
  log "${CRED_FILE} is missing or empty after boot fetch; refusing to boot hindsight"
  exit 1
}

# 4. Background refresh loop. Survives the exec below as a sibling
# shell process — when the container dies (SIGTERM to PID 1), the
# shell dies with it. Disabled when REFRESH_S=0 (test mode) or when
# the fetcher is missing (defence in depth; should never happen in
# a real container).
if [ "${REFRESH_S}" -gt 0 ] && [ -f "${FETCHER}" ]; then
  (
    while sleep "${REFRESH_S}"; do
      SOCKET="${SOCKET}" CRED_FILE="${CRED_FILE}" LABEL=refresh node "${FETCHER}" || true
      # Best-effort: a transient broker outage shouldn't kill the loop.
      # The next tick retries. Hindsight keeps running on the previous
      # successfully-fetched credentials until the loop catches up.
    done
  ) &
  log "credential refresh loop started (interval=${REFRESH_S}s, pid=$!)"
fi

export CLAUDE_CONFIG_DIR="${CRED_DIR}"

# 5. Hand off to upstream start-all.sh.
exec "$@"
