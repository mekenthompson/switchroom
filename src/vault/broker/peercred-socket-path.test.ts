/**
 * Unit tests for `socketPathToAgent` — the Phase 2a socket-path-as-identity
 * helper that extracts the agent name from a per-agent broker socket path.
 *
 * Kept in its own file (rather than appended to peercred.test.ts) because
 * peercred.test.ts mocks `node:fs` at the module boundary; pure-string
 * tests don't need that machinery and shouldn't pay the per-suite reset
 * cost.
 */

import { describe, it, expect } from "vitest";
import {
  socketPathToAgent,
  socketPathToIdentity,
  isReservedAgentName,
  unlockSocketFor,
} from "./peercred.js";

describe("socketPathToAgent", () => {
  it("returns the agent name for a canonical /run/switchroom/broker/<agent>.sock path", () => {
    expect(socketPathToAgent("/run/switchroom/broker/alice.sock")).toBe("alice");
    expect(socketPathToAgent("/run/switchroom/broker/bob.sock")).toBe("bob");
  });

  it("supports hyphens, underscores, and digits in agent names", () => {
    expect(socketPathToAgent("/run/switchroom/broker/agent-1.sock")).toBe("agent-1");
    expect(socketPathToAgent("/run/switchroom/broker/my_agent.sock")).toBe("my_agent");
    expect(socketPathToAgent("/run/switchroom/broker/agent-a-b-c.sock")).toBe("agent-a-b-c");
    expect(socketPathToAgent("/run/switchroom/broker/agent42.sock")).toBe("agent42");
  });

  it("rejects non-canonical parent directories", () => {
    expect(socketPathToAgent("/tmp/broker/alice.sock")).toBeNull();
    expect(socketPathToAgent("/run/switchroom/kernel/alice.sock")).toBeNull();
    expect(socketPathToAgent("/run/switchroom/broker/sub/alice.sock")).toBeNull();
    expect(socketPathToAgent("/run/switchroom/broker.sock")).toBeNull();
  });

  it("rejects missing or wrong suffix", () => {
    expect(socketPathToAgent("/run/switchroom/broker/alice")).toBeNull();
    expect(socketPathToAgent("/run/switchroom/broker/alice.socket")).toBeNull();
    expect(socketPathToAgent("/run/switchroom/broker/.sock")).toBeNull();
  });

  it("rejects path-traversal attempts and weird shapes", () => {
    expect(socketPathToAgent("/run/switchroom/broker/../etc/passwd.sock")).toBeNull();
    expect(socketPathToAgent("/run/switchroom/broker//alice.sock")).toBeNull();
    expect(socketPathToAgent("/run/switchroom/broker/alice/../bob.sock")).toBeNull();
    expect(socketPathToAgent("")).toBeNull();
    expect(socketPathToAgent("alice.sock")).toBeNull();
  });

  it("rejects agent names beginning with non-alphanumeric chars", () => {
    expect(socketPathToAgent("/run/switchroom/broker/-alice.sock")).toBeNull();
    expect(socketPathToAgent("/run/switchroom/broker/_alice.sock")).toBeNull();
  });

  describe("subdir form (v0.7.4 — per-agent volume mounts)", () => {
    // The compose generator mounts each per-agent named volume at
    // /run/switchroom/broker/<agent>, exposing a single `sock` file.
    // socketPathToAgent must accept that shape so bindAgentSocket can
    // accept the path as-is (no path rewriting at the call site).
    it("returns the agent name for /run/switchroom/broker/<agent>/sock", () => {
      expect(socketPathToAgent("/run/switchroom/broker/alice/sock")).toBe("alice");
      expect(socketPathToAgent("/run/switchroom/broker/bob/sock")).toBe("bob");
    });

    it("supports hyphens, underscores, and digits in subdir form too", () => {
      expect(socketPathToAgent("/run/switchroom/broker/agent-1/sock")).toBe("agent-1");
      expect(socketPathToAgent("/run/switchroom/broker/my_agent/sock")).toBe("my_agent");
      expect(socketPathToAgent("/run/switchroom/broker/agent42/sock")).toBe("agent42");
    });

    it("still rejects non-canonical shapes that look subdir-ish", () => {
      // Wrong inner filename
      expect(socketPathToAgent("/run/switchroom/broker/alice/socket")).toBeNull();
      expect(socketPathToAgent("/run/switchroom/broker/alice/sock.bak")).toBeNull();
      // Extra path segments
      expect(socketPathToAgent("/run/switchroom/broker/alice/sub/sock")).toBeNull();
      // Wrong parent
      expect(socketPathToAgent("/run/switchroom/kernel/alice/sock")).toBeNull();
      // Path-traversal in the agent slot
      expect(socketPathToAgent("/run/switchroom/broker/../etc/sock")).toBeNull();
      // Empty agent name
      expect(socketPathToAgent("/run/switchroom/broker//sock")).toBeNull();
    });

    it("rejects subdir form agent names beginning with non-alphanumeric chars", () => {
      expect(socketPathToAgent("/run/switchroom/broker/-alice/sock")).toBeNull();
      expect(socketPathToAgent("/run/switchroom/broker/_alice/sock")).toBeNull();
    });
  });

  it("returns null for non-string input", () => {
    // @ts-expect-error — runtime guard for type-confused callers
    expect(socketPathToAgent(undefined)).toBeNull();
    // @ts-expect-error
    expect(socketPathToAgent(null)).toBeNull();
  });
});

describe("socketPathToIdentity — host-shell operator socket", () => {
  // /run/switchroom/broker/operator/sock is the host-shell-reachable
  // operator socket the broker container binds in v0.7+. Trust comes
  // from the bind path + 0600 chown to operator UID. The agent
  // enumerator must not see "operator" as an agent name.

  it("returns operator identity for the canonical path", () => {
    expect(socketPathToIdentity("/run/switchroom/broker/operator/sock")).toEqual({
      kind: "operator",
    });
  });

  it("does NOT return agent identity for the operator path (reserved)", () => {
    // Pre-fix this would have returned {kind:"agent", name:"operator"}.
    // socketPathToAgent must return null so the per-agent enumerator
    // skips this path; socketPathToIdentity returns the operator kind.
    expect(socketPathToAgent("/run/switchroom/broker/operator/sock")).toBeNull();
    expect(socketPathToAgent("/run/switchroom/broker/operator.sock")).toBeNull();
  });

  it("isReservedAgentName flags 'operator'", () => {
    expect(isReservedAgentName("operator")).toBe(true);
    expect(isReservedAgentName("alice")).toBe(false);
    expect(isReservedAgentName("klanker")).toBe(false);
  });

  it("returns agent identity for non-operator subdir paths", () => {
    expect(socketPathToIdentity("/run/switchroom/broker/alice/sock")).toEqual({
      kind: "agent",
      name: "alice",
    });
  });

  it("returns null for unrelated paths", () => {
    expect(socketPathToIdentity("/tmp/broker/operator/sock")).toBeNull();
    expect(socketPathToIdentity("/run/switchroom/kernel/operator/sock")).toBeNull();
    expect(socketPathToIdentity("")).toBeNull();
  });
});

describe("unlockSocketFor — server/client must agree", () => {
  // Single source of truth for the unlock-socket pairing. server.ts
  // uses this to bind the unlock listener; client.ts uses the same
  // function to compute the connect target. Disagreement here would
  // manifest as silent unlock failures.

  it("v0.6 flat-shape: foo.sock → foo.unlock.sock", () => {
    expect(unlockSocketFor("/home/op/.switchroom/vault-broker.sock")).toBe(
      "/home/op/.switchroom/vault-broker.unlock.sock",
    );
    expect(unlockSocketFor("/run/switchroom/broker/vault-broker.sock")).toBe(
      "/run/switchroom/broker/vault-broker.unlock.sock",
    );
  });

  it("v0.7 subdir-shape: <dir>/sock → <dir>/unlock", () => {
    expect(unlockSocketFor("/run/switchroom/broker/operator/sock")).toBe(
      "/run/switchroom/broker/operator/unlock",
    );
    expect(unlockSocketFor("/home/op/.switchroom/broker-operator/sock")).toBe(
      "/home/op/.switchroom/broker-operator/unlock",
    );
  });
});
