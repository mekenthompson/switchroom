import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { preflightCheck } from "../src/cli/agent.js";

// preflightCheck reads $HOME/.config/systemd/user/switchroom-<name>.service
// and the agent's start.sh / telegram/.env from its agentDir argument. We
// build a sandbox under a tempdir, point HOME at it, and write fixtures.

describe("preflightCheck — autoaccept handler detection (v0.7.0+)", () => {
  let sandbox: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "switchroom-preflight-"));
    prevHome = process.env.HOME;
    process.env.HOME = sandbox;
    mkdirSync(join(sandbox, ".config/systemd/user"), { recursive: true });
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    rmSync(sandbox, { recursive: true, force: true });
  });

  function writeAgent(name: string, unit: string, withEnv = true): string {
    const agentDir = resolve(sandbox, ".switchroom/agents", name);
    mkdirSync(join(agentDir, "telegram"), { recursive: true });
    writeFileSync(resolve(agentDir, "start.sh"), "#!/bin/bash\n", { mode: 0o755 });
    if (withEnv) {
      writeFileSync(
        resolve(agentDir, "telegram/.env"),
        "TELEGRAM_BOT_TOKEN=fake\n",
      );
    }
    writeFileSync(
      resolve(sandbox, ".config/systemd/user", `switchroom-${name}.service`),
      unit,
    );
    return agentDir;
  }

  it("passes when unit uses autoaccept-poll (tmux-default)", () => {
    const agentDir = writeAgent(
      "alpha",
      `[Service]\nExecStart=/usr/bin/tmux new-session -d -s alpha 'bash start.sh'\nExecStartPost=/bin/bash -c '/path/to/dist/cli/autoaccept-poll.ts alpha &'\n`,
    );
    const errors = preflightCheck("alpha", agentDir, true);
    // Filter for handler-related errors only — token/env/etc are independent.
    const handlerErrs = errors.filter((e) => e.includes("autoaccept") || e.includes("expect"));
    expect(handlerErrs).toEqual([]);
  });

  it("passes when unit uses legacy expect wrapper and expect is on PATH", () => {
    const agentDir = writeAgent(
      "bravo",
      `[Service]\nExecStart=/usr/bin/script -qfc "/usr/bin/expect -f /path/to/autoaccept.exp /path/start.sh"\n`,
    );
    const errors = preflightCheck("bravo", agentDir, true);
    const handlerErrs = errors.filter((e) => e.includes("autoaccept handler"));
    expect(handlerErrs).toEqual([]);
  });

  it("flags missing handler when unit has neither expect nor poller", () => {
    const agentDir = writeAgent(
      "charlie",
      `[Service]\nExecStart=/usr/bin/bash /path/start.sh\n`,
    );
    const errors = preflightCheck("charlie", agentDir, true);
    expect(errors.some((e) => e.includes("no autoaccept handler"))).toBe(true);
  });

  it("does not flag handler when usesDevChannels=false", () => {
    const agentDir = writeAgent(
      "delta",
      `[Service]\nExecStart=/usr/bin/bash /path/start.sh\n`,
    );
    const errors = preflightCheck("delta", agentDir, false);
    expect(errors.some((e) => e.includes("autoaccept handler"))).toBe(false);
    expect(errors.some((e) => e.includes("expect"))).toBe(false);
  });

  it("prefers poller over expect when unit has both (mixed unit)", () => {
    const agentDir = writeAgent(
      "echo",
      `[Service]\nExecStart=/usr/bin/tmux ... 'bash start.sh'\nExecStartPost=/bin/bash -c 'autoaccept-poll.ts echo &'\n# legacy reference autoaccept.exp commented out\n`,
    );
    const errors = preflightCheck("echo", agentDir, true);
    // Should not require expect binary because poller path takes precedence.
    expect(errors.some((e) => e.includes("'expect' binary"))).toBe(false);
  });
});

describe("preflightCheck — SWITCHROOM_RUNTIME=docker skips systemd checks", () => {
  let sandbox: string;
  let prevHome: string | undefined;
  let prevRuntime: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "switchroom-preflight-docker-"));
    prevHome = process.env.HOME;
    prevRuntime = process.env.SWITCHROOM_RUNTIME;
    process.env.HOME = sandbox;
    process.env.SWITCHROOM_RUNTIME = "docker";
    mkdirSync(join(sandbox, ".config/systemd/user"), { recursive: true });
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    if (prevRuntime !== undefined) process.env.SWITCHROOM_RUNTIME = prevRuntime;
    else delete process.env.SWITCHROOM_RUNTIME;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("does NOT flag a missing systemd unit under docker mode", () => {
    // No systemd unit written. Only start.sh exists.
    const agentDir = resolve(sandbox, ".switchroom/agents/dockeragent");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(resolve(agentDir, "start.sh"), "#!/bin/bash\n", { mode: 0o755 });

    const errors = preflightCheck("dockeragent", agentDir, true);
    expect(errors.some((e) => e.includes("systemd unit"))).toBe(false);
    expect(errors.some((e) => e.includes("autoaccept"))).toBe(false);
  });

  it("still flags a missing start.sh under docker mode", () => {
    // start.sh check is runtime-agnostic — it's the per-agent scaffold artefact.
    const agentDir = resolve(sandbox, ".switchroom/agents/missingstart");
    mkdirSync(agentDir, { recursive: true });
    // Note: no start.sh written.

    const errors = preflightCheck("missingstart", agentDir, true);
    expect(errors.some((e) => e.includes("start.sh not found"))).toBe(true);
  });
});
