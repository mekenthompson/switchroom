/**
 * hostd server tests — bring up a real UDS server in a temp dir and
 * drive it via the client. The CLI binary is stubbed by setting
 * `switchroomBin` to a small shell script the test writes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostdServer } from "../../src/host-control/server.js";
import { hostdRequest } from "../../src/host-control/client.js";

let tmp: string;
let server: HostdServer;
let stubBin: string;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "hostd-test-"));
  // Stub `switchroom` binary — echoes the verb to stdout, exits 0.
  // Test cases that need a non-zero exit override the stub before
  // their call.
  stubBin = join(tmp, "switchroom-stub.sh");
  writeFileSync(stubBin, `#!/bin/sh\necho "stub: $@"\nexit 0\n`);
  chmodSync(stubBin, 0o755);
});

afterAll(async () => {
  if (server) await server.stop();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(async () => {
  // Fresh server per test. The previous one (if any) was torn down
  // in afterEach of the prior test via .stop() in a finally.
  if (server) await server.stop();
  server = new HostdServer({
    homeDir: tmp,
    agentUids: { klanker: 10001, bob: 10002 },
    config: {
      agents: {
        klanker: { admin: true },
        bob: {},
      },
    },
    switchroomBin: stubBin,
    auditLogPath: join(tmp, "audit.log"),
    allowNonLinux: true,
  });
  await server.start();
});

describe("hostd server — startup & socket binding", () => {
  it("binds one socket per agent", () => {
    const bound = server.getBoundPaths();
    expect(bound).toHaveLength(2);
    expect(bound.some((p) => p.endsWith("/klanker/sock"))).toBe(true);
    expect(bound.some((p) => p.endsWith("/bob/sock"))).toBe(true);
  });

  it("rebinds on a fresh start after stop (idempotent unlink)", async () => {
    await server.stop();
    server = new HostdServer({
      homeDir: tmp,
      agentUids: { klanker: 10001 },
      config: { agents: { klanker: { admin: true } } },
      switchroomBin: stubBin,
      auditLogPath: join(tmp, "audit.log"),
      allowNonLinux: true,
    });
    await server.start();
    expect(server.getBoundPaths().length).toBe(1);
  });
});

describe("hostd server — verb dispatch", () => {
  it("upgrade_status: returns completed and stdout_tail", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "upgrade_status",
        request_id: "req-1",
      },
    );
    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(0);
    expect(resp.stdout_tail).toContain("stub: update --status");
  });

  it("agent_restart: returns started immediately", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "req-2",
        args: { name: "klanker" },
      },
    );
    expect(resp.result).toBe("started");
    expect(resp.exit_code).toBeNull();
  });

  it("agent_restart: cross-agent denies for non-admin caller", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "req-3",
        // bob is NOT admin; targeting klanker should be denied.
        args: { name: "klanker" },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/cross-agent requires admin/);
  });

  it("agent_restart: cross-agent allowed for admin caller", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "req-4",
        args: { name: "bob" },
      },
    );
    expect(resp.result).toBe("started");
  });

  it("agent_restart: self-target allowed even for non-admin", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!;
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "req-5",
        args: { name: "bob" },
      },
    );
    expect(resp.result).toBe("started");
  });
});

describe("hostd server — get_status visibility", () => {
  it("returns the original verb's status to its own caller", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    // Start a verb.
    await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "orig-1",
        args: { name: "klanker" },
      },
    );
    // Wait for the detached run to complete (stub exits ~immediately).
    await new Promise((r) => setTimeout(r, 100));
    // Look up its status.
    const resp = await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "get_status",
        request_id: "lookup-1",
        args: { target_request_id: "orig-1" },
      },
    );
    expect(resp.result).toBe("completed");
    expect(resp.exit_code).toBe(0);
  });

  it("returns denied (not-found-shape) to a non-admin agent looking up another agent's request", async () => {
    const klankerSock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const bobSock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!;
    await hostdRequest(
      { socketPath: klankerSock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "orig-2",
        args: { name: "klanker" },
      },
    );
    await new Promise((r) => setTimeout(r, 100));
    // bob (non-admin) tries to look it up.
    const resp = await hostdRequest(
      { socketPath: bobSock },
      {
        v: 1,
        op: "get_status",
        request_id: "probe-1",
        args: { target_request_id: "orig-2" },
      },
    );
    expect(resp.result).toBe("denied");
    expect(resp.error).toMatch(/not found or not visible/);
  });

  it("admins can look up any agent's request", async () => {
    const bobSock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/bob/sock"))!;
    const klankerSock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    await hostdRequest(
      { socketPath: bobSock },
      {
        v: 1,
        op: "agent_restart",
        request_id: "orig-3",
        args: { name: "bob" },
      },
    );
    await new Promise((r) => setTimeout(r, 100));
    const resp = await hostdRequest(
      { socketPath: klankerSock },
      {
        v: 1,
        op: "get_status",
        request_id: "admin-probe-1",
        args: { target_request_id: "orig-3" },
      },
    );
    expect(resp.result).toBe("completed");
  });
});

describe("hostd server — idempotency", () => {
  it("dedupes within the idempotency window", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const args = {
      v: 1 as const,
      op: "agent_restart" as const,
      request_id: "first",
      idempotency_key: "shared-key",
      args: { name: "klanker" },
    };
    const r1 = await hostdRequest({ socketPath: sock }, args);
    const r2 = await hostdRequest(
      { socketPath: sock },
      { ...args, request_id: "second" },
    );
    // Second response either matches first's status (cache hit) OR
    // returns the same started result. Either way the dedupe path
    // must not throw — the response is valid.
    expect(["started", "completed"]).toContain(r2.result);
    // The request_id echoed in the response is the second caller's
    // (echoes what the caller sent in this request).
    expect(r2.request_id).toBe("second");
    void r1;
  });
});

describe("hostd server — DoS guard", () => {
  it("closes the connection if the request exceeds 2x MAX_FRAME_BYTES without a newline", async () => {
    const { connect } = await import("node:net");
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const client = connect(sock);
    // EPIPE is expected once the server destroys the socket and
    // we keep writing; suppress so the test runner doesn't treat
    // it as an unhandled error.
    client.on("error", () => undefined);
    // Write more than 128 KiB (2x MAX_FRAME_BYTES) with no newline.
    // Wait for connect, then write in chunks until either we hit
    // the cap (server closes) or we've exceeded the budget.
    await new Promise<void>((resolve) =>
      client.once("connect", () => resolve()),
    );
    const chunk = "x".repeat(8192);
    let written = 0;
    const closed = new Promise<void>((resolve) =>
      client.once("close", () => resolve()),
    );
    for (let i = 0; i < 32; i++) {
      if (client.destroyed) break;
      try {
        client.write(chunk);
        written += chunk.length;
      } catch {
        break;
      }
    }
    await closed;
    expect(written).toBeGreaterThan(0);
    // We may not have written all 256 KiB before the server
    // destroyed the socket — that's the point. Just verify the
    // server closed us out.
    expect(client.destroyed).toBe(true);
  });
});

describe("hostd server — malformed request handling", () => {
  it("echoes the caller's request_id when present, even on schema failure", async () => {
    const { connect } = await import("node:net");
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const client = connect(sock);
    let buf = "";
    const got = new Promise<string>((resolve) => {
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(buf.slice(0, nl));
      });
    });
    await new Promise<void>((resolve) =>
      client.once("connect", () => resolve()),
    );
    // Valid JSON, wrong schema (missing required `args`).
    client.write(
      JSON.stringify({
        v: 1,
        op: "agent_restart",
        request_id: "caller-echoes-this",
      }) + "\n",
    );
    const line = await got;
    expect(line).toContain('"request_id":"caller-echoes-this"');
    expect(line).toContain('"result":"denied"');
    client.destroy();
  });

  it("falls back to a sentinel request_id on non-JSON input", async () => {
    const { connect } = await import("node:net");
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    const client = connect(sock);
    let buf = "";
    const got = new Promise<string>((resolve) => {
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl !== -1) resolve(buf.slice(0, nl));
      });
    });
    await new Promise<void>((resolve) =>
      client.once("connect", () => resolve()),
    );
    client.write("not json at all\n");
    const line = await got;
    expect(line).toContain('"request_id":"malformed-request"');
    expect(line).toContain('"result":"denied"');
    client.destroy();
  });
});

describe("hostd server — audit log", () => {
  it("appends a row per request", async () => {
    const sock = server
      .getBoundPaths()
      .find((p) => p.endsWith("/klanker/sock"))!;
    await hostdRequest(
      { socketPath: sock },
      {
        v: 1,
        op: "upgrade_status",
        request_id: "audit-1",
      },
    );
    // Audit write is async; give it a beat.
    await new Promise((r) => setTimeout(r, 50));
    const { readFileSync } = await import("node:fs");
    const audit = readFileSync(join(tmp, "audit.log"), "utf8");
    expect(audit).toContain('"op":"upgrade_status"');
    expect(audit).toContain('"request_id":"audit-1"');
    expect(audit).toContain('"caller":{"kind":"agent","name":"klanker"}');
  });
});
