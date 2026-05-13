import { describe, it, expect } from "vitest";
import {
  socketPathToIdentity,
  isReservedHostdAgentName,
} from "../../src/host-control/peercred.js";

describe("hostd peercred — socketPathToIdentity", () => {
  it("parses container-side per-agent paths", () => {
    expect(socketPathToIdentity("/run/switchroom/hostd/klanker/sock")).toEqual({
      kind: "agent",
      name: "klanker",
    });
  });

  it("parses host-side per-agent paths regardless of HOME prefix", () => {
    expect(
      socketPathToIdentity("/home/me/.switchroom/hostd/klanker/sock"),
    ).toEqual({ kind: "agent", name: "klanker" });
    expect(
      socketPathToIdentity("/var/lib/operator/.switchroom/hostd/klanker/sock"),
    ).toEqual({ kind: "agent", name: "klanker" });
  });

  it("returns {kind: operator} for the operator socket", () => {
    expect(
      socketPathToIdentity("/home/me/.switchroom/hostd/operator/sock"),
    ).toEqual({ kind: "operator" });
  });

  it("returns null for reserved-but-not-operator names", () => {
    expect(
      socketPathToIdentity("/home/me/.switchroom/hostd/hostd/sock"),
    ).toBeNull();
  });

  it("returns null for malformed paths", () => {
    for (const bad of [
      "",
      "/etc/passwd",
      "/run/switchroom/hostd//sock",
      "/run/switchroom/broker/klanker/sock", // wrong daemon
      "/run/switchroom/hostd/klanker", // missing /sock
      "/run/switchroom/hostd/klanker/sock/extra",
    ]) {
      expect(socketPathToIdentity(bad), `expected null for "${bad}"`).toBeNull();
    }
  });

  it("rejects agent names with shell-special characters", () => {
    expect(
      socketPathToIdentity("/run/switchroom/hostd/foo;bar/sock"),
    ).toBeNull();
  });

  it("isReservedHostdAgentName covers operator and hostd", () => {
    expect(isReservedHostdAgentName("operator")).toBe(true);
    expect(isReservedHostdAgentName("hostd")).toBe(true);
    expect(isReservedHostdAgentName("klanker")).toBe(false);
  });
});
