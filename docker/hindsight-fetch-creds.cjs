#!/usr/bin/env node
// switchroom-hindsight credential fetcher.
//
// Single-shot fetch from the auth-broker UDS at $SOCKET (default
// /run/switchroom/auth-broker/sock). Writes the returned
// credentials.json shape to $CRED_FILE (default
// /run/claude-creds/.credentials.json) atomically (temp + rename).
//
// Used in two places:
//   1. docker/hindsight-entrypoint.sh — boot-time fetch BEFORE exec.
//   2. docker/hindsight-entrypoint.sh background refresh loop —
//      re-runs every $SWITCHROOM_HINDSIGHT_REFRESH_S seconds so the
//      tmpfs dotfile doesn't go stale (broker refreshes the canonical
//      creds every ~60 min; this loop keeps the consumer mirror within
//      that window).
//
// Exits 0 on success, non-zero on any failure. Each failure path
// prints a stable prefix so journalctl / docker logs grep cleanly.
//
// Wire shape (mirrors src/auth/broker/protocol.ts):
//   request:  { v: 1, op: "get-credentials", id: <uuid> } + "\n"
//   response: { v: 1, id, ok: true|false, data?: { credentials, account, expiresAt }, error? }
//
// Atomic write: tmp file alongside the destination (same tmpfs), then
// rename(2). POSIX guarantees the rename is atomic on the same fs, and
// the claude SDK opens the dotfile fresh on every invocation — readers
// either see the full old bytes or the full new bytes, never a torn
// write mid-rename.

"use strict";
const net = require("net");
const fs = require("fs");
const crypto = require("crypto");

const SOCKET = process.env.SOCKET || "/run/switchroom/auth-broker/sock";
const CRED_FILE = process.env.CRED_FILE || "/run/claude-creds/.credentials.json";
const LABEL = process.env.LABEL || "boot"; // "boot" | "refresh" — appears in stderr
const TIMEOUT_MS = parseInt(process.env.TIMEOUT_MS || "10000", 10);

const log = (msg) => {
  process.stderr.write(`switchroom-hindsight-fetch[${LABEL}]: ${msg}\n`);
};

const id = crypto.randomUUID();
const req = JSON.stringify({ v: 1, op: "get-credentials", id }) + "\n";

let settled = false;
const fail = (msg, code = 1) => {
  if (settled) return;
  settled = true;
  log(msg);
  try { sock.destroy(); } catch (_e) { /* ignore */ }
  process.exit(code);
};

const sock = net.connect(SOCKET);
let buf = "";

sock.setTimeout(TIMEOUT_MS);
sock.on("timeout", () => fail(`auth-broker request timed out after ${TIMEOUT_MS}ms`));
sock.on("error", (err) => fail(`auth-broker connection error: ${err.message}`));
sock.on("connect", () => sock.write(req));

sock.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  const nl = buf.indexOf("\n");
  if (nl < 0) return;
  // Stop reading further data — broker sends exactly one frame per request.
  sock.removeAllListeners("data");
  const line = buf.slice(0, nl);
  let resp;
  try { resp = JSON.parse(line); }
  catch (err) { return fail(`unparseable broker response: ${err.message}`); }
  if (!resp || resp.ok !== true) {
    const errCode = resp && resp.error ? resp.error.code : "UNKNOWN";
    const errMsg = resp && resp.error ? resp.error.message : "no error body";
    return fail(`broker returned error ${errCode}: ${errMsg}`);
  }
  if (!resp.data || !resp.data.credentials) {
    return fail("broker response missing data.credentials");
  }
  const tmp = `${CRED_FILE}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(resp.data.credentials, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, CRED_FILE);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* tmp already cleaned */ }
    return fail(`could not write ${CRED_FILE}: ${err.message}`);
  }
  settled = true;
  sock.end();
  process.exit(0);
});

sock.on("close", () => {
  if (!settled) fail("auth-broker connection closed before response");
});
