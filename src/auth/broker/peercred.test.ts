/**
 * auth-broker peercred — path-as-identity classification.
 */

import { describe, expect, it } from "vitest";

import {
  classify,
  RESERVED_NAMES,
  socketPathToName,
  validateConsumerNames,
} from "./peercred.js";

describe("socketPathToName", () => {
  it("accepts the canonical subdir/sock shape", () => {
    expect(socketPathToName("/run/switchroom/auth-broker/ziggy/sock")).toBe("ziggy");
    expect(socketPathToName("/run/switchroom/auth-broker/operator/sock")).toBe("operator");
  });

  it("rejects flat <name>.sock", () => {
    expect(socketPathToName("/run/switchroom/auth-broker/ziggy.sock")).toBeNull();
  });

  it("rejects mismatched prefixes", () => {
    expect(socketPathToName("/run/switchroom/broker/ziggy/sock")).toBeNull();
    expect(socketPathToName("/run/foo/ziggy/sock")).toBeNull();
  });

  it("rejects illegal name characters", () => {
    expect(socketPathToName("/run/switchroom/auth-broker/has space/sock")).toBeNull();
    expect(socketPathToName("/run/switchroom/auth-broker/-leading-dash/sock")).toBeNull();
  });

  it("rejects oversized names", () => {
    const long = "a".repeat(64);
    expect(socketPathToName(`/run/switchroom/auth-broker/${long}/sock`)).toBeNull();
  });
});

describe("classify", () => {
  const cfg = {
    agents: ["ziggy", "clerk"],
    consumers: ["hindsight"],
    adminAgents: ["clerk"],
  };

  it("operator path produces operator identity", () => {
    expect(classify("/run/switchroom/auth-broker/operator/sock", cfg)).toEqual({
      kind: "operator",
    });
  });

  it("known agent path resolves to agent identity with admin flag", () => {
    expect(classify("/run/switchroom/auth-broker/ziggy/sock", cfg)).toEqual({
      kind: "agent",
      name: "ziggy",
      admin: false,
    });
    expect(classify("/run/switchroom/auth-broker/clerk/sock", cfg)).toEqual({
      kind: "agent",
      name: "clerk",
      admin: true,
    });
  });

  it("known consumer path resolves to consumer identity", () => {
    expect(classify("/run/switchroom/auth-broker/hindsight/sock", cfg)).toEqual({
      kind: "consumer",
      name: "hindsight",
    });
  });

  it("unknown name returns null", () => {
    expect(classify("/run/switchroom/auth-broker/nobody/sock", cfg)).toBeNull();
  });

  it("reserved name in non-operator path returns null (defence-in-depth)", () => {
    // path regex permits any slug; classify enforces reserved set
    for (const r of RESERVED_NAMES) {
      if (r === "operator") continue;
      expect(classify(`/run/switchroom/auth-broker/${r}/sock`, cfg)).toBeNull();
    }
  });
});

describe("validateConsumerNames", () => {
  it("flags consumer/agent name collision", () => {
    const errs = validateConsumerNames({
      agents: ["ziggy"],
      consumers: ["ziggy"],
      adminAgents: [],
    });
    expect(errs).toEqual([
      "consumer name 'ziggy' collides with an agent name",
    ]);
  });

  it("flags consumer name that's also an admin agent", () => {
    // Post-unification: admin is sourced from `agents.<name>.admin: true`,
    // so `adminAgents` in the shape is the derived subset of agent names
    // with that flag. A consumer-name collision with an admin-agent is
    // still a config error (and the agent-name collision check above
    // catches it too — this is defence in depth).
    const errs = validateConsumerNames({
      agents: ["ziggy"],
      consumers: ["ziggy-shadow"],
      adminAgents: ["ziggy-shadow"],
    });
    expect(errs).toContain(
      "consumer name 'ziggy-shadow' is an admin agent (consumers cannot be admins)",
    );
  });

  it("returns empty for a clean config", () => {
    expect(
      validateConsumerNames({
        agents: ["ziggy"],
        consumers: ["hindsight"],
        adminAgents: [],
      }),
    ).toEqual([]);
  });
});
