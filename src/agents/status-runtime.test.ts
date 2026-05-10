/**
 * Adapter tests for status.ts.
 *
 * Exercises `readDockerContainer` JSON parsing and `defaultStatusInputs`
 * wiring (both adapters resolve to the same container — claude and the
 * gateway sidecar share the agent container under docker).
 *
 * `docker inspect` is mocked at the `child_process` level via vitest's
 * module mock; we only assert on the parser's mapping from `State` JSON
 * to the canonical `{pid, activeEnterTs, active}` shape that the
 * buildClaudeStatus / buildGatewayStatus consumers want.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { readDockerContainer, defaultStatusInputs } from "./status.js";

const execMock = execFileSync as unknown as ReturnType<typeof vi.fn>;

describe("readDockerContainer", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it("maps a running container's State JSON to {pid, activeEnterTs, active=active}", () => {
    execMock.mockReturnValue(
      JSON.stringify({
        Status: "running",
        Pid: 12345,
        StartedAt: "2026-05-09T01:00:00.000Z",
      }) + "\n",
    );
    const got = readDockerContainer("switchroom-clerk");
    expect(got.active).toBe("active");
    expect(got.pid).toBe(12345);
    expect(got.activeEnterTs).toBe(Date.parse("2026-05-09T01:00:00.000Z"));
    expect(execMock).toHaveBeenCalledWith(
      "docker",
      ["inspect", "--format", "{{json .State}}", "switchroom-clerk"],
      expect.anything(),
    );
  });

  it("returns inactive shape when the container is not running", () => {
    execMock.mockReturnValue(
      JSON.stringify({ Status: "exited", Pid: 0, StartedAt: "" }),
    );
    const got = readDockerContainer("switchroom-stopped");
    expect(got.active).toBe("inactive");
    expect(got.pid).toBeNull();
    expect(got.activeEnterTs).toBeNull();
  });

  it("returns inactive shape when docker inspect throws (container missing)", () => {
    execMock.mockImplementation(() => {
      throw new Error("No such container");
    });
    const got = readDockerContainer("switchroom-missing");
    expect(got.active).toBe("inactive");
    expect(got.pid).toBeNull();
    expect(got.activeEnterTs).toBeNull();
  });

  it("returns inactive shape on unparseable JSON", () => {
    execMock.mockReturnValue("not json");
    const got = readDockerContainer("switchroom-broken");
    expect(got.active).toBe("inactive");
  });

  it("maps Status='restarting' to its own bucket (crash-loop signal preserved)", () => {
    execMock.mockReturnValue(
      JSON.stringify({ Status: "restarting", Pid: 0, StartedAt: "2026-05-09T01:00:00Z" }),
    );
    const got = readDockerContainer("switchroom-flapping");
    expect(got.active).toBe("restarting");
    expect(got.pid).toBeNull();
  });
});

describe("defaultStatusInputs", () => {
  beforeEach(() => {
    execMock.mockReset();
  });

  it("both getClaudeProcess + getGatewayProcess query docker for the SAME container", () => {
    execMock.mockReturnValue(
      JSON.stringify({ Status: "running", Pid: 99, StartedAt: "2026-05-09T01:00:00Z" }),
    );
    const inputs = defaultStatusInputs({
      agentName: "clerk",
      agentDir: "/tmp/agent",
      hindsightApiUrl: null,
      hindsightBankId: "clerk",
    });

    inputs.getClaudeProcess();
    inputs.getGatewayProcess();

    // Claude and the gateway plugin live in the same container.
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock.mock.calls[0]![0]).toBe("docker");
    expect(execMock.mock.calls[0]![1]).toContain("switchroom-clerk");
    expect(execMock.mock.calls[1]![0]).toBe("docker");
    expect(execMock.mock.calls[1]![1]).toContain("switchroom-clerk");
  });
});
