/**
 * Regression tests for #1053: `getViaBrokerStructured` must forward
 * the agent's capability token in the wire payload.
 *
 * Pre-fix: an agent with a freshly-minted grant (via Telegram
 * approval card flow) had its `.vault-token` file written, but the
 * CLI's `switchroom vault get` and the cascade's vault-reference
 * resolver both used `getViaBrokerStructured(key, opts)` without
 * forwarding the token. The broker's grant code path
 * (server.ts:994-1028) was therefore never invoked — every get
 * fell through to the peercred ACL, which still denied the key.
 *
 * Net effect (from gymbro): Telegram approval card → operator
 * passphrase → broker mints token → `.vault-token` written → agent
 * runs `switchroom vault get fatsecret/client_id` → broker returns
 * VAULT-BROKER-DENIED: not in ACL. The approval flow looked like
 * it worked but the agent could still not read the key.
 *
 * Post-fix: getViaBrokerStructured accepts `token` on its opts and
 * forwards it on the wire. Broker validates via validateGrant and
 * bypasses ACL when the grant authorizes the key.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { getViaBrokerStructured, putViaBroker } from "./client.js";
import {
  encodeResponse,
  errorResponse,
  entryResponse,
  type BrokerRequest,
} from "./protocol.js";

/**
 * Fake broker that records every inbound request and replies with a
 * canned response. Lets us assert what the client puts on the wire
 * without spinning up the full broker.
 */
function startFakeBroker(handler: (req: BrokerRequest) => unknown) {
  let socketPath: string;
  let tmpDir: string;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-client-token-"));
  socketPath = path.join(tmpDir, "fake.sock");

  const requests: BrokerRequest[] = [];
  const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        try {
          const req = JSON.parse(line) as BrokerRequest;
          requests.push(req);
          const resp = handler(req);
          socket.write(encodeResponse(resp as never));
          socket.end();
        } catch (e) {
          socket.write(encodeResponse(errorResponse("INTERNAL", String(e))));
          socket.end();
        }
      }
    });
  });
  return new Promise<{
    socketPath: string;
    requests: BrokerRequest[];
    stop: () => Promise<void>;
  }>((resolve) => {
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        requests,
        stop: () =>
          new Promise<void>((r) => {
            server.close(() => {
              try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
              } catch {
                /* ignore */
              }
              r();
            });
          }),
      });
    });
  });
}

describe("getViaBrokerStructured: forwards capability token (#1053)", () => {
  let broker: Awaited<ReturnType<typeof startFakeBroker>>;

  beforeEach(async () => {
    broker = await startFakeBroker((req) => {
      if (req.op === "get") {
        return entryResponse({ kind: "string", value: `value-of-${req.key}` });
      }
      return errorResponse("BAD_REQUEST", `unhandled op: ${req.op}`);
    });
  });

  afterEach(async () => {
    await broker.stop();
  });

  it("includes `token` on the wire when opts.token is set", async () => {
    // fails when: the CLI's `vault get` writes the token file (after
    // a Telegram approval card mint) but the wire payload doesn't
    // carry it — the broker's grant path is unreachable and the
    // agent gets DENIED on the peercred ACL anyway. This was the
    // gymbro bug class.
    const result = await getViaBrokerStructured("fatsecret/client_id", {
      socket: broker.socketPath,
      token: "vg_abc123.deadbeefcafe",
    });
    expect(result.kind).toBe("ok");
    expect(broker.requests).toHaveLength(1);
    const req = broker.requests[0]!;
    expect(req.op).toBe("get");
    expect((req as { key: string }).key).toBe("fatsecret/client_id");
    expect((req as { token?: string }).token).toBe("vg_abc123.deadbeefcafe");
  });

  it("omits `token` when no token is provided (back-compat with peercred-only get)", async () => {
    // The legacy path-as-identity / peercred get still works for
    // agents that don't have a grant yet. The token field should be
    // absent from the wire entirely (not "" / not null) so a
    // forward-compat broker parser doesn't accidentally hit the
    // grant-validation branch on a null/empty token.
    const result = await getViaBrokerStructured("legacy_key", {
      socket: broker.socketPath,
    });
    expect(result.kind).toBe("ok");
    expect(broker.requests).toHaveLength(1);
    const req = broker.requests[0]!;
    expect("token" in req).toBe(false);
  });

  it("regression: putViaBroker still forwards token + passphrase (sanity, no behaviour change here)", async () => {
    // Sanity guard so a future refactor of the put helper doesn't
    // drop the token alongside this PR's get-side change.
    await broker.stop();
    broker = await startFakeBroker((req) => {
      if (req.op === "put") {
        return { ok: true, put: true, key: (req as { key: string }).key };
      }
      return errorResponse("BAD_REQUEST", `unhandled op: ${req.op}`);
    });
    const result = await putViaBroker(
      "k",
      { kind: "string", value: "v" },
      { socket: broker.socketPath, token: "vg_xyz.beef", passphrase: "operator-pass" },
    );
    expect(result.kind).toBe("ok");
    const req = broker.requests[0]!;
    expect((req as { token?: string }).token).toBe("vg_xyz.beef");
    expect((req as { passphrase?: string }).passphrase).toBe("operator-pass");
  });
});
