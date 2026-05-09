import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock node:child_process so docker(...) calls are observable and don't
// escape the test. tmux.js is mocked separately so we can control
// sendAgentInterrupt's outcome per-case.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock("../src/agents/tmux.js", () => ({
  sendAgentInterrupt: vi.fn(),
  captureAgentPane: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  startAgent,
  stopAgent,
  restartAgent,
  resolveAgentPid,
  getAgentStartSha,
  getAgentStatus,
  getAllAgentStatuses,
  parseAgentStartShaFromEnv,
} from "../src/agents/lifecycle.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

const mockedExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

interface DockerCall {
  args: string[];
}

function recordingStub(handlers: Record<string, () => string>): DockerCall[] {
  const calls: DockerCall[] = [];
  mockedExec.mockImplementation((bin: string, args: string[]) => {
    if (bin !== "docker") return "";
    calls.push({ args });
    // Match by the first compose subcommand or first verb after compose flags.
    const verb = args[0] === "compose" ? `compose ${args[5] ?? ""}` : args[0];
    const handler = handlers[verb];
    if (handler) return handler();
    return "";
  });
  return calls;
}

beforeEach(() => {
  mockedExec.mockReset();
  // Pin a deterministic compose path so we can assert argv shape.
  process.env.SWITCHROOM_COMPOSE_FILE = "/tmp/sw-test-compose.yml";
  // Force docker runtime mode for the whole suite. Without this,
  // getAgentStatus()'s host-shell branch (added in v0.7.3 PR #871)
  // calls readSystemdUnit and returns "inactive" — defeating the
  // point of these tests, which exercise the docker `inspect` path.
  process.env.SWITCHROOM_RUNTIME = "docker";
});

describe("lifecycle (docker mode): start/stop/restart shellouts", () => {
  it("startAgent calls `compose start agent-<name>` when the container exists", () => {
    const calls = recordingStub({
      ps: () => "switchroom-foo\n",
      "compose start": () => "",
    });
    startAgent("foo");
    // First call: ps probe; second: compose start
    expect(calls.length).toBe(2);
    expect(calls[0].args).toEqual([
      "ps",
      "-a",
      "--format",
      "{{.Names}}",
      "--filter",
      "name=^switchroom-foo$",
    ]);
    expect(calls[1].args).toEqual([
      "compose",
      "-p",
      "switchroom",
      "-f",
      "/tmp/sw-test-compose.yml",
      "start",
      "agent-foo",
    ]);
  });

  it("startAgent falls back to `compose up -d --no-deps` when the container is missing", () => {
    const calls = recordingStub({
      ps: () => "", // no container
      "compose up": () => "",
    });
    startAgent("foo");
    expect(calls[1].args).toEqual([
      "compose",
      "-p",
      "switchroom",
      "-f",
      "/tmp/sw-test-compose.yml",
      "up",
      "-d",
      "--no-deps",
      "agent-foo",
    ]);
  });

  it("stopAgent calls `compose stop agent-<name>`", () => {
    const calls = recordingStub({ "compose stop": () => "" });
    stopAgent("foo");
    expect(calls[0].args).toEqual([
      "compose",
      "-p",
      "switchroom",
      "-f",
      "/tmp/sw-test-compose.yml",
      "stop",
      "agent-foo",
    ]);
  });

  it("restartAgent calls `compose restart agent-<name>`", () => {
    const calls = recordingStub({ "compose restart": () => "" });
    restartAgent("foo");
    expect(calls[0].args).toEqual([
      "compose",
      "-p",
      "switchroom",
      "-f",
      "/tmp/sw-test-compose.yml",
      "restart",
      "agent-foo",
    ]);
  });

  it("restartAgent rethrows with a clear prefix on docker failure", () => {
    mockedExec.mockImplementation(() => {
      const e = new Error("Command failed") as NodeJS.ErrnoException & { stderr?: string };
      e.stderr = "service agent-foo not found";
      throw e;
    });
    expect(() => restartAgent("foo")).toThrowError(/Failed to restart agent "foo"/);
  });
});

describe("lifecycle (docker mode): resolveAgentPid", () => {
  it("returns the container PID 1 from State.Pid", () => {
    mockedExec.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "inspect") return "12345";
      return "";
    });
    expect(resolveAgentPid("foo")).toBe(12345);
  });

  it("returns 0 when the container is missing", () => {
    mockedExec.mockImplementation(() => {
      throw new Error("No such container");
    });
    expect(resolveAgentPid("foo")).toBe(0);
  });

  it("returns 0 when State.Pid is 0 (stopped container)", () => {
    mockedExec.mockImplementation(() => "0");
    expect(resolveAgentPid("foo")).toBe(0);
  });
});

describe("lifecycle (docker mode): getAgentStartSha resolution chain", () => {
  it("prefers SWITCHROOM_AGENT_START_SHA from container env", () => {
    mockedExec.mockImplementation((_bin: string, args: string[]) => {
      // first inspect call is the env-dump
      if (args.includes("{{range .Config.Env}}{{println .}}{{end}}")) {
        return "PATH=/usr/bin\nSWITCHROOM_AGENT_START_SHA=abc1234\nTZ=UTC";
      }
      return "";
    });
    expect(getAgentStartSha("foo")).toBe("abc1234");
  });

  it("falls back to switchroom.commit container label when env is missing", () => {
    mockedExec.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("{{range .Config.Env}}{{println .}}{{end}}")) {
        return "PATH=/usr/bin\nTZ=UTC";
      }
      if (args.includes("{{index .Config.Labels \"switchroom.commit\"}}")) {
        return "deadbee";
      }
      return "";
    });
    expect(getAgentStartSha("foo")).toBe("deadbee");
  });

  it("falls back to org.opencontainers.image.revision on the image", () => {
    mockedExec.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("{{range .Config.Env}}{{println .}}{{end}}")) return "X=1";
      if (args.includes("{{index .Config.Labels \"switchroom.commit\"}}")) return "<no value>";
      if (args.includes("{{.Config.Image}}")) return "ghcr.io/switchroom/agent:0.7.0";
      if (args.includes("{{index .Config.Labels \"org.opencontainers.image.revision\"}}")) {
        return "f00ba12";
      }
      return "";
    });
    expect(getAgentStartSha("foo")).toBe("f00ba12");
  });

  it("returns null and warns when no source has a value", () => {
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mockedExec.mockImplementation((_bin: string, args: string[]) => {
      if (args.includes("{{range .Config.Env}}{{println .}}{{end}}")) return "X=1";
      if (args.includes("{{index .Config.Labels \"switchroom.commit\"}}")) return "<no value>";
      if (args.includes("{{.Config.Image}}")) return "ghcr.io/switchroom/agent:0.7.0";
      if (args.includes("{{index .Config.Labels \"org.opencontainers.image.revision\"}}")) {
        return "<no value>";
      }
      return "";
    });
    expect(getAgentStartSha("foo")).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("parseAgentStartShaFromEnv extracts the sha from a docker env array", () => {
    expect(
      parseAgentStartShaFromEnv([
        "PATH=/usr/bin",
        "SWITCHROOM_AGENT_START_SHA=abc1234",
        "TZ=UTC",
      ]),
    ).toBe("abc1234");
    expect(parseAgentStartShaFromEnv(["PATH=/usr/bin"])).toBeNull();
  });
});

describe("lifecycle (docker mode): getAgentStatus + getAllAgentStatuses", () => {
  it("normalises State.Status='running' to active='active'", () => {
    mockedExec.mockImplementation((_bin: string, args: string[]) => {
      if (
        args[0] === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.StartedAt}}|{{.State.Pid}}")
      ) {
        return "running|2026-05-09T12:00:00Z|4242";
      }
      if (args[0] === "stats") return "12.34MiB / 4GiB";
      return "";
    });
    const s = getAgentStatus("foo");
    expect(s.active).toBe("active");
    expect(s.uptime).toBe("2026-05-09T12:00:00Z");
    expect(s.pid).toBe(4242);
    expect(s.memory).toBe("12MB");
  });

  it("returns inactive shell when the container is missing", () => {
    mockedExec.mockImplementation(() => {
      throw new Error("No such container");
    });
    const s = getAgentStatus("foo");
    expect(s).toEqual({ active: "inactive", uptime: null, memory: null, pid: null });
  });

  it("getAllAgentStatuses iterates every configured agent", () => {
    mockedExec.mockImplementation((_bin: string, args: string[]) => {
      if (
        args[0] === "inspect" &&
        args.includes("{{.State.Status}}|{{.State.StartedAt}}|{{.State.Pid}}")
      ) {
        // pull the container name (last arg) to differentiate
        const cn = args[args.length - 1];
        if (cn === "switchroom-a") return "running|2026-05-09T12:00:00Z|111";
        if (cn === "switchroom-b") return "exited|2026-05-09T11:00:00Z|0";
      }
      if (args[0] === "stats") return "8MiB / 4GiB";
      return "";
    });
    const config: SwitchroomConfig = {
      switchroom: { version: 1, agents_dir: "/tmp/agents", skills_dir: "/tmp/skills" },
      telegram: { bot_token: "123:abc" },
      defaults: {},
      profiles: {},
      agents: {
        a: { profile: "default" },
        b: { profile: "default" },
      },
    } as unknown as SwitchroomConfig;
    const all = getAllAgentStatuses(config);
    expect(all.a.active).toBe("active");
    expect(all.a.pid).toBe(111);
    expect(all.b.active).toBe("exited");
    expect(all.b.pid).toBeNull();
  });
});
