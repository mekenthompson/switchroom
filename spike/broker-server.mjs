#!/usr/bin/env node
// Phase 0 spike broker. Listens on per-agent unix sockets:
//   /run/switchroom/broker/<agent>/sock
// On accept, getsockname() returns the bound socket path; the agent
// identity is derived from the path component <agent>. ACL is path-derived.
//
// Wire protocol: newline-delimited JSON request, single JSON response.
//   { op: "read", key: "<key>" }
//   -> { ok: true, value: "..." } | { ok: false, error: "...", reason: "..." }

import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const ROOT = "/run/switchroom/broker";
const AGENTS = (process.env.AGENTS || "alice,bob").split(",").map((s) => s.trim()).filter(Boolean);

// Stub secret store. Each secret is owned by exactly one agent.
// ACL: agent X may read keys "<X>-*"; everything else is denied.
const SECRETS = {
  "alice-secret": "alice-treasure",
  "alice-config": "alice-config-blob",
  "bob-secret": "bob-treasure",
  "bob-config": "bob-config-blob",
};

function checkAclByAgent(agent, key) {
  // Path-derived agent identity → ACL decision.
  if (typeof agent !== "string" || !agent) {
    return { allow: false, reason: "no agent identity resolved" };
  }
  if (!Object.prototype.hasOwnProperty.call(SECRETS, key)) {
    return { allow: false, reason: `unknown key '${key}'` };
  }
  const expectedOwner = key.split("-", 1)[0];
  if (expectedOwner !== agent) {
    return { allow: false, reason: `key '${key}' not in ACL for ${agent}` };
  }
  return { allow: true };
}

function socketPathToAgent(sockPath) {
  // /run/switchroom/broker/<agent>/sock → <agent>
  const parts = sockPath.split(path.sep).filter(Boolean);
  // expect ['run','switchroom','broker','<agent>','sock']
  const idx = parts.indexOf("broker");
  if (idx >= 0 && parts.length >= idx + 3 && parts[idx + 2] === "sock") {
    return parts[idx + 1];
  }
  return null;
}

// Look up agent UIDs from /etc/passwd inside this container.
function lookupUid(name) {
  const passwd = fs.readFileSync("/etc/passwd", "utf8");
  for (const line of passwd.split("\n")) {
    const f = line.split(":");
    if (f[0] === name) return parseInt(f[2], 10);
  }
  throw new Error(`no such user: ${name}`);
}

function ensureSocketDir(agent) {
  const dir = path.join(ROOT, agent);
  fs.mkdirSync(dir, { recursive: true });
  const uid = lookupUid(agent);
  // Per-agent dir is chowned to that agent's UID, mode 0700.
  // The broker (root) can still write the socket inside it; the
  // bind-mount of just this subdir into agent X's container means
  // only agent X can `connect()` to the socket from inside the fleet.
  fs.chownSync(dir, uid, uid);
  fs.chmodSync(dir, 0o700);
  return dir;
}

function listenForAgent(agent) {
  const dir = ensureSocketDir(agent);
  const sockPath = path.join(dir, "sock");
  try { fs.unlinkSync(sockPath); } catch {}

  const server = net.createServer((conn) => {
    const bound = server.address(); // string (UDS path)
    const resolvedAgent = socketPathToAgent(bound);

    // SO_PEERCRED forensics — capture peer uid for the matrix's informational column.
    let peerUid = -1;
    try {
      // Node has no built-in SO_PEERCRED; fall back to a best-effort
      // marker. We log the bound path which is the authoritative identity.
      peerUid = conn._handle && conn._handle.fd != null ? -1 : -1;
    } catch {}

    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let req;
      try { req = JSON.parse(line); }
      catch (e) {
        conn.end(JSON.stringify({ ok: false, error: "bad-json" }) + "\n");
        return;
      }
      const decision = checkAclByAgent(resolvedAgent, req.key);
      let resp;
      if (decision.allow) {
        resp = { ok: true, agent: resolvedAgent, key: req.key, value: SECRETS[req.key], boundSocket: bound, peerUid };
      } else {
        resp = { ok: false, agent: resolvedAgent, key: req.key, error: "acl-deny", reason: decision.reason, boundSocket: bound, peerUid };
      }
      conn.end(JSON.stringify(resp) + "\n");
    });
  });

  server.listen(sockPath, () => {
    // Make the socket inode itself accessible only to the owning agent.
    fs.chmodSync(sockPath, 0o660);
    fs.chownSync(sockPath, lookupUid(agent), lookupUid(agent));
    process.stdout.write(`broker: listening for ${agent} on ${sockPath} (bound=${server.address()})\n`);
  });
  return server;
}

const servers = AGENTS.map(listenForAgent);

function shutdown() {
  for (const s of servers) { try { s.close(); } catch {} }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
