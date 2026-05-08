/**
 * Watchdog journald helper tests — Phase 3b-1.
 *
 * Pure-function tests; no syscalls.
 */

import { describe, it, expect } from "vitest";
import { syslogIdentifier, dockerLogOptsForRole, isLinuxHost } from "./journald.js";

describe("syslogIdentifier", () => {
  it("formats role-only identifiers", () => {
    expect(syslogIdentifier("broker")).toBe("switchroom-broker");
    expect(syslogIdentifier("kernel")).toBe("switchroom-kernel");
    expect(syslogIdentifier("scheduler")).toBe("switchroom-scheduler");
  });

  it("appends the agent suffix for agent containers", () => {
    expect(syslogIdentifier("agent", "alice")).toBe("switchroom-agent-alice");
    expect(syslogIdentifier("agent", "klanker")).toBe("switchroom-agent-klanker");
  });

  it("strips disallowed characters", () => {
    expect(syslogIdentifier("AGENT", "Bob/2")).toBe("switchroom-agent-bob2");
  });
});

describe("dockerLogOptsForRole", () => {
  it("on Linux returns journald argv", () => {
    if (!isLinuxHost()) return;
    const argv = dockerLogOptsForRole({ role: "agent", agent: "alice" });
    expect(argv).toContain("--log-driver");
    expect(argv).toContain("journald");
    expect(argv).toContain("tag=switchroom-agent-alice");
  });

  it("on non-Linux returns an empty argv (no-op)", () => {
    if (isLinuxHost()) return;
    expect(dockerLogOptsForRole({ role: "agent", agent: "alice" })).toEqual([]);
  });
});
