#!/usr/bin/env node
// Phase 0 spike agent client. Connects to its own broker socket
// and exercises:
//   1. allow path  — request a key in its ACL
//   2. deny path   — request a key in another agent's ACL
//   3. cross-mount — if /run/switchroom/broker/<other>/sock exists in this
//                    container's namespace, attempt to connect; expected
//                    to FAIL at connect() because of fs perms (mode 0700,
//                    owned by other agent), proving the dir-perms layer.

import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const SELF = process.env.AGENT_NAME || "alice";
const OTHER = process.env.OTHER_AGENT || (SELF === "alice" ? "bob" : "alice");

const SELF_SOCK = `/run/switchroom/broker/${SELF}/sock`;
const OTHER_SOCK = `/run/switchroom/broker/${OTHER}/sock`;

function rpc(sock, req, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const c = net.createConnection(sock);
    let buf = "";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try { c.destroy(); } catch {}
      resolve(result);
    };
    const t = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    c.on("connect", () => c.write(JSON.stringify(req) + "\n"));
    c.on("data", (d) => { buf += d.toString("utf8"); });
    c.on("end", () => {
      clearTimeout(t);
      const line = buf.split("\n")[0];
      try { finish({ kind: "ok", resp: JSON.parse(line) }); }
      catch (e) { finish({ kind: "bad-resp", raw: buf }); }
    });
    c.on("error", (e) => { clearTimeout(t); finish({ kind: "error", code: e.code, message: e.message }); });
  });
}

function inspect(p) {
  try {
    const s = fs.statSync(p);
    return { exists: true, mode: (s.mode & 0o777).toString(8), uid: s.uid, gid: s.gid };
  } catch (e) {
    return { exists: false, code: e.code };
  }
}

const out = { agent: SELF, other: OTHER, uid: process.getuid(), gid: process.getgid(), tests: [] };

console.log(`# agent-client running as ${SELF} (uid=${process.getuid()})`);
console.log(`# self sock dir: ${path.dirname(SELF_SOCK)} -> ${JSON.stringify(inspect(path.dirname(SELF_SOCK)))}`);
console.log(`# self sock:     ${SELF_SOCK} -> ${JSON.stringify(inspect(SELF_SOCK))}`);
console.log(`# other sock dir: ${path.dirname(OTHER_SOCK)} -> ${JSON.stringify(inspect(path.dirname(OTHER_SOCK)))}`);
console.log(`# other sock:    ${OTHER_SOCK} -> ${JSON.stringify(inspect(OTHER_SOCK))}`);

const tests = [
  { name: "allow-own-key",   sock: SELF_SOCK,  req: { op: "read", key: `${SELF}-secret` },  expect: "ok" },
  { name: "deny-own-unknown", sock: SELF_SOCK,  req: { op: "read", key: `nonexistent-key` }, expect: "deny" },
  { name: "deny-other-key",  sock: SELF_SOCK,  req: { op: "read", key: `${OTHER}-secret` }, expect: "deny" },
  { name: "cross-mount-attempt", sock: OTHER_SOCK, req: { op: "read", key: `${OTHER}-secret` }, expect: "connect-fails" },
];

for (const t of tests) {
  const r = await rpc(t.sock, t.req);
  let pass = false;
  if (t.expect === "ok")   pass = r.kind === "ok" && r.resp?.ok === true;
  if (t.expect === "deny") pass = r.kind === "ok" && r.resp?.ok === false && r.resp?.error === "acl-deny";
  if (t.expect === "connect-fails") pass = r.kind === "error" && (r.code === "EACCES" || r.code === "ENOENT" || r.code === "EPERM" || r.code === "ECONNREFUSED");
  out.tests.push({ ...t, result: r, pass });
  console.log(`# test ${t.name}: pass=${pass} result=${JSON.stringify(r)}`);
}

const allPass = out.tests.every((t) => t.pass);
console.log(JSON.stringify({ summary: { agent: SELF, allPass, count: out.tests.length, passed: out.tests.filter(x=>x.pass).length }, tests: out.tests }, null, 2));
process.exit(allPass ? 0 : 1);
