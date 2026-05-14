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
#   2. Call `get-credentials` over the UDS — NDJSON, one frame
#      request + one frame response (mirrors src/auth/broker/client.ts).
#   3. Write the `data.credentials` payload (the full credentials.json
#      shape) to ${CRED_FILE}. Atomic via temp+rename inside the same
#      tmpfs dir — POSIX rename(2) on tmpfs is atomic for the open()
#      that the claude SDK does on each invocation.
#   4. Export CLAUDE_CONFIG_DIR so the claude-agent-sdk inside hindsight
#      picks up the credentials.
#   5. exec into the upstream CMD ("$@"), preserving PID 1 + signal
#      handling so docker's --restart unless-stopped backs off cleanly.
#
# Env-var knobs (all have safe defaults; tests override):
#   SWITCHROOM_AUTH_BROKER_SOCKET   broker socket path
#                                   default /run/switchroom/auth-broker/sock
#   SWITCHROOM_HINDSIGHT_CRED_DIR   where to write the dotfile
#                                   default /run/claude-creds
#   SWITCHROOM_HINDSIGHT_WAIT_S     socket-wait timeout in seconds
#                                   default 60
#
# Fail-loud — every step has an explicit exit. We never boot hindsight
# with empty/missing credentials; better to crash-loop with a clear
# log line than 500 every retain.
set -eu

SOCKET="${SWITCHROOM_AUTH_BROKER_SOCKET:-/run/switchroom/auth-broker/sock}"
CRED_DIR="${SWITCHROOM_HINDSIGHT_CRED_DIR:-/run/claude-creds}"
CRED_FILE="${CRED_DIR}/.credentials.json"
WAIT_TIMEOUT_S="${SWITCHROOM_HINDSIGHT_WAIT_S:-60}"

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

# 2. Make the cred dir.
mkdir -p "${CRED_DIR}"
chmod 0700 "${CRED_DIR}"

# 3+4. Fetch credentials and write the dotfile. Node is on PATH because
# the upstream hindsight image ships it for the Control Plane.
#
# The fetcher is a small Node program embedded here. It:
#   - Connects to ${SOCKET}.
#   - Sends one `get-credentials` NDJSON frame.
#   - Reads one NDJSON response, parses {ok, data, error}.
#   - On ok, writes data.credentials to ${CRED_FILE} via temp+rename.
#   - Exits 0 on success, non-zero on any failure (each path logs).
#
# We pass the socket/dest paths via argv (not env) so the Node program
# has a single source of truth and doesn't re-read env that the shell
# already resolved.
SOCKET="${SOCKET}" CRED_FILE="${CRED_FILE}" node -e '
"use strict";
const net = require("net");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const socketPath = process.env.SOCKET;
const credFile = process.env.CRED_FILE;
const id = crypto.randomUUID();
const req = JSON.stringify({ v: 1, op: "get-credentials", id }) + "\n";

const sock = net.connect(socketPath);
let buf = "";
let settled = false;

const fail = (msg) => {
  if (settled) return;
  settled = true;
  console.error("switchroom-hindsight-entrypoint: " + msg);
  try { sock.destroy(); } catch (_e) {}
  process.exit(1);
};

sock.setTimeout(10000);
sock.on("timeout", () => fail("auth-broker request timed out after 10s"));
sock.on("error", (err) => fail("auth-broker connection error: " + err.message));
sock.on("connect", () => sock.write(req));

sock.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  const nl = buf.indexOf("\n");
  if (nl < 0) return;
  const line = buf.slice(0, nl);
  let resp;
  try { resp = JSON.parse(line); }
  catch (err) { return fail("unparseable broker response: " + err.message); }
  if (!resp || resp.ok !== true) {
    const code = resp && resp.error ? resp.error.code : "UNKNOWN";
    const msg = resp && resp.error ? resp.error.message : "no error body";
    return fail("broker returned error " + code + ": " + msg);
  }
  if (!resp.data || !resp.data.credentials) {
    return fail("broker response missing data.credentials");
  }
  const tmp = credFile + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(resp.data.credentials, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, credFile);
  } catch (err) {
    return fail("could not write " + credFile + ": " + err.message);
  }
  settled = true;
  sock.end();
  process.exit(0);
});

sock.on("close", () => {
  if (!settled) fail("auth-broker connection closed before response");
});
' || {
  log "credential fetch failed; refusing to boot hindsight"
  exit 1
}

# Sanity-check the file landed (defense-in-depth — the Node program
# already exits non-zero on failure, but a stale layer / mount weirdness
# could still leave the dotfile missing).
[ -s "${CRED_FILE}" ] || {
  log "${CRED_FILE} is missing or empty after fetch; refusing to boot hindsight"
  exit 1
}

export CLAUDE_CONFIG_DIR="${CRED_DIR}"

# 5. Hand off to upstream start-all.sh.
exec "$@"
