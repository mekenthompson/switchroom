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
import { socketPathToAgent } from "./peercred.js";

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
