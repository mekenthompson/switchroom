import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

import { execFileSync, spawnSync } from "node:child_process";
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
const mockedSpawnSync = spawnSync as unknown as ReturnType<typeof vi.fn>;

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
});

describe("lifecycle (docker mode): start/stop/restart shellouts", () => {
  it("startAgent calls `compose up -d --force-recreate --no-deps agent-<name>` (#1018)", () => {
    // fails when: a refactor reverts startAgent to `compose start`
    // (or `up -d` without `--force-recreate`). Either reintroduces
    // #1018: a `stop → edit yaml → apply → start` round leaves the
    // container with create-time env. The restartAgent test below
    // pins the same flag-set for symmetry.
    const calls = recordingStub({
      "compose up": () => "",
    });
    startAgent("foo");
    expect(calls.length).toBe(1);
    expect(calls[0].args).toEqual([
      "compose",
      "-p",
      "switchroom",
      "-f",
      "/tmp/sw-test-compose.yml",
      "up",
      "-d",
      "--force-recreate",
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

  it("restartAgent calls `compose up -d --force-recreate --no-deps agent-<name>` (#932)", () => {
    // All three flags are load-bearing — see the doc-comment on
    // restartAgent for why each one matters:
    //   up -d            picks up volume-mount diffs (#857 / #916)
    //   --force-recreate always bounces the process so scaffold-
    //                    content edits (settings.json / start.sh /
    //                    SOUL.md / .mcp.json) take effect — pre-PR
    //                    `restart` always bounced; pre-#944-reviewer
    //                    `up -d --no-deps` no-op'd on byte-identical
    //                    compose, breaking auth.ts and grant flows.
    //   --no-deps        leaves siblings (broker/kernel) untouched.
    const calls = recordingStub({ "compose up": () => "" });
    restartAgent("foo");
    expect(calls[0].args).toEqual([
      "compose",
      "-p",
      "switchroom",
      "-f",
      "/tmp/sw-test-compose.yml",
      "up",
      "-d",
      "--force-recreate",
      "--no-deps",
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

// Issue #1118: ALL callers of restartAgent must produce a fresh
// clean-shutdown marker so the next boot's reason classifier sees
// "graceful" instead of falling through to "crash" (operator-driven
// restarts via auth.ts, reconcile, web/api, etc. previously omitted
// the reason argument → no marker written → next boot misclassified
// as crash → misleading "💥 agent-crashed" card on every legitimate
// operator action).
describe("lifecycle (docker mode): restartAgent ALWAYS writes a clean-shutdown marker (#1118)", () => {
  let tmpRoot: string;
  let prevAgentsDir: string | undefined;

  beforeEach(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    tmpRoot = mkdtempSync(joinPath(tmpdir(), "sw-restartagent-1118-"));
    prevAgentsDir = process.env.SWITCHROOM_AGENTS_DIR;
    process.env.SWITCHROOM_AGENTS_DIR = tmpRoot;
  });

  afterEach(async () => {
    const { rmSync } = await import("node:fs");
    if (prevAgentsDir === undefined) delete process.env.SWITCHROOM_AGENTS_DIR;
    else process.env.SWITCHROOM_AGENTS_DIR = prevAgentsDir;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("restartAgent(name) — no reason arg — writes a 'cli: restart' marker (regression #1118)", async () => {
    recordingStub({ "compose up": () => "" });
    restartAgent("foo");
    const { readFileSync, existsSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const markerPath = joinPath(tmpRoot, "foo", "telegram", "clean-shutdown.json");
    expect(existsSync(markerPath)).toBe(true);
    const m = JSON.parse(readFileSync(markerPath, "utf-8")) as {
      ts: number;
      signal: string;
      reason: string;
    };
    expect(m.reason).toBe("cli: restart");
    expect(m.signal).toBe("SIGTERM");
    expect(typeof m.ts).toBe("number");
    // Marker must be FRESH at write time — the boot reason classifier
    // uses a 60s 'graceful' window, so a marker ts older than ~now is
    // useless. Allow 5s slack for slow CI.
    expect(Date.now() - m.ts).toBeLessThan(5_000);
  });

  it("restartAgent(name, customReason) — reason arg honored (regression: don't clobber explicit caller reason)", async () => {
    recordingStub({ "compose up": () => "" });
    restartAgent("foo", "auth: token rotated");
    const { readFileSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const markerPath = joinPath(tmpRoot, "foo", "telegram", "clean-shutdown.json");
    const m = JSON.parse(readFileSync(markerPath, "utf-8")) as { reason: string };
    expect(m.reason).toBe("auth: token rotated");
  });

  it("restartAgent preserves a fresh prior marker (cooperative race: gateway-written reason wins)", async () => {
    // Production race: in-chat /new handler writes
    // "user: /new from chat" into the marker, then spawns a detached
    // `switchroom agent restart` CLI. The CLI's restartAgent() call
    // would normally write "cli: restart" — but preserveExisting:true
    // MUST leave the user attribution in place so the greeting card
    // shows who really triggered it.
    const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const dir = joinPath(tmpRoot, "foo", "telegram");
    mkdirSync(dir, { recursive: true });
    const markerPath = joinPath(dir, "clean-shutdown.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        ts: Date.now(),
        signal: "SIGTERM",
        reason: "user: /new from chat",
      }),
    );

    recordingStub({ "compose up": () => "" });
    restartAgent("foo");

    const after = JSON.parse(readFileSync(markerPath, "utf-8")) as { reason: string };
    expect(after.reason).toBe("user: /new from chat");
  });

  it("restartAgent overwrites a stale prior marker (>30s old)", async () => {
    const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const dir = joinPath(tmpRoot, "foo", "telegram");
    mkdirSync(dir, { recursive: true });
    const markerPath = joinPath(dir, "clean-shutdown.json");
    writeFileSync(
      markerPath,
      JSON.stringify({
        ts: Date.now() - 60_000,
        signal: "SIGTERM",
        reason: "user: ancient marker",
      }),
    );

    recordingStub({ "compose up": () => "" });
    restartAgent("foo");

    const after = JSON.parse(readFileSync(markerPath, "utf-8")) as { reason: string };
    expect(after.reason).toBe("cli: restart");
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

  it("getAllAgentStatuses batches into ONE inspect + ONE stats call", () => {
    // New contract (perf fix): two `docker` calls total via spawnSync,
    // not 2×N execFileSync. inspect returns one line per container with
    // a leading-slash {{.Name}}; stats lists all running containers.
    const calls: string[][] = [];
    mockedSpawnSync.mockImplementation((_bin: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "inspect") {
        // Both container names in a SINGLE call; missing ones simply
        // don't appear in stdout.
        return {
          status: 0,
          stdout:
            "/switchroom-a|running|2026-05-09T12:00:00Z|111\n" +
            "/switchroom-b|exited|2026-05-09T11:00:00Z|0\n",
          stderr: "",
        };
      }
      if (args[0] === "stats") {
        return { status: 0, stdout: "switchroom-a|8MiB / 4GiB\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
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
    expect(all.a.memory).toBe("8MB");
    expect(all.b.active).toBe("exited");
    expect(all.b.pid).toBeNull();
    expect(all.b.memory).toBeNull(); // not running → no stats line

    // The whole point of the fix: exactly 2 docker invocations
    // regardless of agent count, and the inspect call carries BOTH
    // container names (batched, not per-agent).
    const inspectCalls = calls.filter((a) => a[0] === "inspect");
    const statsCalls = calls.filter((a) => a[0] === "stats");
    expect(inspectCalls).toHaveLength(1);
    expect(statsCalls).toHaveLength(1);
    expect(inspectCalls[0]).toContain("switchroom-a");
    expect(inspectCalls[0]).toContain("switchroom-b");
  });

  it("getAllAgentStatuses tolerates a total stats failure (memory stays null)", () => {
    mockedSpawnSync.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "inspect") {
        return {
          status: 0,
          stdout: "/switchroom-a|running|2026-05-09T12:00:00Z|111\n",
          stderr: "",
        };
      }
      // stats blows up entirely.
      return { status: 1, stdout: "", stderr: "docker stats failed" };
    });
    const config = {
      switchroom: { version: 1, agents_dir: "/tmp/a", skills_dir: "/tmp/s" },
      telegram: { bot_token: "123:abc" },
      defaults: {},
      profiles: {},
      agents: { a: { profile: "default" } },
    } as unknown as SwitchroomConfig;
    const all = getAllAgentStatuses(config);
    expect(all.a.active).toBe("active");
    expect(all.a.pid).toBe(111);
    expect(all.a.memory).toBeNull();
  });

  it("getAllAgentStatuses returns inactive shells for containers absent from inspect output", () => {
    mockedSpawnSync.mockImplementation((_bin: string, args: string[]) => {
      if (args[0] === "inspect") {
        // Only 'a' exists; 'b' missing → omitted from stdout, non-zero exit.
        return {
          status: 1,
          stdout: "/switchroom-a|running|2026-05-09T12:00:00Z|111\n",
          stderr: "Error: No such object: switchroom-b",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const config = {
      switchroom: { version: 1, agents_dir: "/tmp/a", skills_dir: "/tmp/s" },
      telegram: { bot_token: "123:abc" },
      defaults: {},
      profiles: {},
      agents: { a: { profile: "default" }, b: { profile: "default" } },
    } as unknown as SwitchroomConfig;
    const all = getAllAgentStatuses(config);
    expect(all.a.active).toBe("active");
    expect(all.b).toEqual({ active: "inactive", uptime: null, memory: null, pid: null });
  });
});
