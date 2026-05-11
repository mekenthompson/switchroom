/**
 * Tests for `preferOperatorSocket` — the helper that routes grant-
 * management RPCs (list_grants / mint_grant / revoke_grant) through
 * the operator socket when `SWITCHROOM_VAULT_BROKER_OPERATOR_SOCK` is
 * set in env (i.e. on admin-flagged agents per #1019 Option 1's
 * compose.ts mount).
 *
 * Without this rerouting, `/vault audit` on an admin agent fails
 * with broker server's "Grant management ops are operator-only;
 * agent-bound listeners cannot mint, list, or revoke grants"
 * (`src/vault/broker/server.ts:1493`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preferOperatorSocket } from "./client.js";

const SAVED_ENV = {
  operatorSock: process.env.SWITCHROOM_VAULT_BROKER_OPERATOR_SOCK,
};

beforeEach(() => {
  delete process.env.SWITCHROOM_VAULT_BROKER_OPERATOR_SOCK;
});

afterEach(() => {
  if (SAVED_ENV.operatorSock !== undefined) {
    process.env.SWITCHROOM_VAULT_BROKER_OPERATOR_SOCK = SAVED_ENV.operatorSock;
  } else {
    delete process.env.SWITCHROOM_VAULT_BROKER_OPERATOR_SOCK;
  }
});

describe("preferOperatorSocket", () => {
  it("sets opts.socket from SWITCHROOM_VAULT_BROKER_OPERATOR_SOCK when env is set", () => {
    // fails when: the env var stops being consulted — grant-mgmt
    // RPCs from admin agents revert to the per-agent socket and
    // get the "operator-only" rejection that #1019 Option 1 fixed.
    process.env.SWITCHROOM_VAULT_BROKER_OPERATOR_SOCK =
      "/run/switchroom/broker/operator/sock";
    const result = preferOperatorSocket();
    expect(result.socket).toBe("/run/switchroom/broker/operator/sock");
  });

  it("returns opts unchanged when env is NOT set (non-admin agents)", () => {
    // fails when: the helper always returns a socket — non-admin
    // agents would lose the runtime-aware default resolution
    // (legacy host socket vs operator vs per-agent path) and
    // their grant-mgmt calls would crash with an undefined path.
    const result = preferOperatorSocket();
    expect(result.socket).toBeUndefined();
  });

  it("respects an explicit caller-supplied opts.socket even when env IS set", () => {
    // fails when: env unconditionally wins — tests + special-case
    // host callers (e.g. a CLI that points at a specific test
    // socket) lose control of routing. Explicit caller-pinning
    // is a more specific signal than env, so it should win.
    process.env.SWITCHROOM_VAULT_BROKER_OPERATOR_SOCK =
      "/run/switchroom/broker/operator/sock";
    const result = preferOperatorSocket({ socket: "/tmp/explicit-test.sock" });
    expect(result.socket).toBe("/tmp/explicit-test.sock");
  });

  it("preserves other BrokerClientOpts fields when adding socket", () => {
    // fails when: a refactor returns just `{ socket }` instead of
    // spreading the caller's opts. The agent-token discovery
    // (`agentSlug`) and timeout overrides would silently drop.
    process.env.SWITCHROOM_VAULT_BROKER_OPERATOR_SOCK =
      "/run/switchroom/broker/operator/sock";
    const result = preferOperatorSocket({
      timeoutMs: 5000,
      agentSlug: "test-harness",
    });
    expect(result.socket).toBe("/run/switchroom/broker/operator/sock");
    expect(result.timeoutMs).toBe(5000);
    expect(result.agentSlug).toBe("test-harness");
  });

  it("handles undefined opts argument gracefully", () => {
    // fails when: opts is unsafely destructured — most callers in
    // the codebase invoke listGrantsViaBroker(agent) with no opts
    // at all, so the helper must handle undefined cleanly.
    process.env.SWITCHROOM_VAULT_BROKER_OPERATOR_SOCK =
      "/run/switchroom/broker/operator/sock";
    const result = preferOperatorSocket(undefined);
    expect(result.socket).toBe("/run/switchroom/broker/operator/sock");
  });
});
