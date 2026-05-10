/**
 * Tests for `putViaBroker` — agent-driven vault key rotation client.
 *
 * Strategy: stand up a fake broker server on a tmp socket that responds
 * with canned wire frames. We don't need a real VaultBroker here — the
 * client-side parsing + result-shape narrowing is the contract under
 * test. ACL gating is exercised by the server's existing ACL tests
 * (same `checkAclByAgent` logic that gates get); end-to-end is covered
 * by manual deploy verification.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { putViaBroker } from "./client.js";
import { decodeRequest } from "./protocol.js";

interface MockBroker {
  socketPath: string;
  /** Last request the mock saw. Used to assert wire-shape. */
  lastRequest: ReturnType<typeof decodeRequest> | null;
  close: () => Promise<void>;
}

function startMockBroker(reply: string): Promise<MockBroker> {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "put-test-"));
    const socketPath = path.join(tmpDir, "test.sock");
    const handle: MockBroker = {
      socketPath,
      lastRequest: null,
      close: () =>
        new Promise<void>((res) => {
          server.close(() => {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
            res();
          });
        }),
    };
    const server = net.createServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          const line = buf.slice(0, nl).trimEnd();
          try { handle.lastRequest = decodeRequest(line); } catch { /* */ }
          sock.write(reply);
          sock.end();
        }
      });
    });
    server.listen(socketPath, () => resolve(handle));
    server.on("error", reject);
  });
}

describe("putViaBroker", () => {
  let mock: MockBroker | null = null;

  afterEach(async () => {
    if (mock) { await mock.close(); mock = null; }
  });

  it("ok response → kind:'ok' and request carries the new entry", async () => {
    mock = await startMockBroker(
      JSON.stringify({ ok: true, put: true, key: "microsoft/ken-tokens" }) + "\n",
    );
    const result = await putViaBroker(
      "microsoft/ken-tokens",
      { kind: "string", value: "{\"access_token\":\"new\"}" },
      { socket: mock.socketPath },
    );
    expect(result.kind).toBe("ok");
    expect(mock.lastRequest).toEqual({
      v: 1,
      op: "put",
      key: "microsoft/ken-tokens",
      entry: { kind: "string", value: "{\"access_token\":\"new\"}" },
    });
  });

  it("DENIED response → kind:'denied' with code + msg propagated", async () => {
    mock = await startMockBroker(
      JSON.stringify({
        ok: false,
        code: "DENIED",
        msg: "agent 'klanker' has no schedule entries declaring 'secrets'",
      }) + "\n",
    );
    const result = await putViaBroker(
      "microsoft/ken-tokens",
      { kind: "string", value: "x" },
      { socket: mock.socketPath },
    );
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") {
      expect(result.code).toBe("DENIED");
      expect(result.msg).toContain("no schedule entries");
    }
  });

  it("UNKNOWN_KEY response → kind:'not_found' (broker won't introduce new keys)", async () => {
    // Specific-path: the broker refuses to write a key that doesn't exist
    // yet — agents can rotate, only operators can introduce. Calling code
    // surfaces this distinctly so the operator-fix hint can be printed.
    mock = await startMockBroker(
      JSON.stringify({
        ok: false,
        code: "UNKNOWN_KEY",
        msg: "Key not found: microsoft/new-token (broker put cannot introduce new keys; ask operator to set it once)",
      }) + "\n",
    );
    const result = await putViaBroker(
      "microsoft/new-token",
      { kind: "string", value: "x" },
      { socket: mock.socketPath },
    );
    expect(result.kind).toBe("not_found");
    if (result.kind === "not_found") {
      expect(result.code).toBe("UNKNOWN_KEY");
    }
  });

  it("LOCKED response → kind:'denied' with LOCKED code", async () => {
    // LOCKED is rolled into 'denied' from the caller's perspective —
    // both produce a hard "broker said no" return. The CLI distinguishes
    // them by the `code` field for messaging.
    mock = await startMockBroker(
      JSON.stringify({ ok: false, code: "LOCKED", msg: "Vault is locked" }) + "\n",
    );
    const result = await putViaBroker(
      "x",
      { kind: "string", value: "y" },
      { socket: mock.socketPath },
    );
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") expect(result.code).toBe("LOCKED");
  });

  it("BAD_REQUEST on kind mismatch (existing string ↔ new binary) → kind:'denied'", async () => {
    mock = await startMockBroker(
      JSON.stringify({
        ok: false,
        code: "BAD_REQUEST",
        msg: "kind mismatch: existing entry is 'string', new entry is 'binary'",
      }) + "\n",
    );
    const result = await putViaBroker(
      "microsoft/ken-tokens",
      { kind: "binary", value: "aGVsbG8=" },
      { socket: mock.socketPath },
    );
    expect(result.kind).toBe("denied");
    if (result.kind === "denied") {
      expect(result.code).toBe("BAD_REQUEST");
      expect(result.msg).toContain("kind mismatch");
    }
  });

  it("socket missing → kind:'unreachable' (no broker running)", async () => {
    const result = await putViaBroker(
      "x",
      { kind: "string", value: "y" },
      { socket: "/tmp/no-such-broker-sock.test" },
    );
    expect(result.kind).toBe("unreachable");
    if (result.kind === "unreachable") {
      expect(result.msg).toMatch(/socket not found|ENOENT/i);
    }
  });

  it("binary entry round-trips through the wire shape", async () => {
    mock = await startMockBroker(
      JSON.stringify({ ok: true, put: true, key: "ssh/key" }) + "\n",
    );
    const result = await putViaBroker(
      "ssh/key",
      { kind: "binary", value: "aGVsbG8gd29ybGQ=" },
      { socket: mock.socketPath },
    );
    expect(result.kind).toBe("ok");
    expect(mock.lastRequest).toEqual({
      v: 1,
      op: "put",
      key: "ssh/key",
      entry: { kind: "binary", value: "aGVsbG8gd29ybGQ=" },
    });
  });
});
