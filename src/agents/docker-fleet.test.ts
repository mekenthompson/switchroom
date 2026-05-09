/**
 * Tests for {@link bringUpAgentService} — the helper that owns the
 * "regenerate compose, persist, `docker compose up -d --no-deps
 * agent-<name>`" sequence used by `switchroom agent add` (Phase 3a/3b)
 * and the in-flight bring-up path. PR-D1 / v0.7 coverage gap #2.
 *
 * We mock the compose generator (so we don't need a fully-formed config),
 * intercept `node:child_process.execFileSync` to assert the docker argv,
 * and write to a tmpdir to verify the on-disk compose path + file mode.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, statSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";

vi.mock("./compose.js", () => ({
  generateCompose: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

import { bringUpAgentService, resolveSwitchroomHome } from "./docker-fleet.js";
import { generateCompose } from "./compose.js";
import { execFileSync } from "node:child_process";
import type { SwitchroomConfig } from "../config/schema.js";

const STUB_CONFIG = {
  switchroom: { agents_dir: "/tmp/agents" },
  agents: { bot: { extends: "general" } },
} as unknown as SwitchroomConfig;

const STUB_COMPOSE_YAML = "services:\n  agent-bot:\n    image: stub\n";

describe("bringUpAgentService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (generateCompose as any).mockReturnValue(STUB_COMPOSE_YAML);
  });

  it("writes compose YAML to <home>/compose/docker-compose.yml with mode 0o600", () => {
    const home = mkdtempSync(join(tmpdir(), "docker-fleet-"));
    (execFileSync as any).mockReturnValue(Buffer.from(""));

    const result = bringUpAgentService({
      config: STUB_CONFIG,
      agentName: "bot",
      switchroomHome: home,
      stdio: "ignore",
    });

    const expectedPath = resolve(home, "compose", "docker-compose.yml");
    expect(result.composePath).toBe(expectedPath);
    expect(existsSync(expectedPath)).toBe(true);
    expect(readFileSync(expectedPath, "utf-8")).toBe(STUB_COMPOSE_YAML);

    const mode = statSync(expectedPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("calls generateCompose with homeDir = os.homedir() (PR-A1 fix)", () => {
    const home = mkdtempSync(join(tmpdir(), "docker-fleet-"));
    (execFileSync as any).mockReturnValue(Buffer.from(""));

    bringUpAgentService({
      config: STUB_CONFIG,
      agentName: "bot",
      switchroomHome: home,
      stdio: "ignore",
    });

    expect(generateCompose).toHaveBeenCalledWith({
      config: STUB_CONFIG,
      homeDir: homedir(),
    });
  });

  it("shells out `docker compose -f <path> up -d --no-deps agent-<name>` with exact argv", () => {
    const home = mkdtempSync(join(tmpdir(), "docker-fleet-"));
    (execFileSync as any).mockReturnValue(Buffer.from(""));

    bringUpAgentService({
      config: STUB_CONFIG,
      agentName: "bot",
      switchroomHome: home,
      stdio: "ignore",
    });

    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [bin, args, opts] = (execFileSync as any).mock.calls[0];
    expect(bin).toBe("docker");
    expect(args).toEqual([
      "compose",
      "-f",
      resolve(home, "compose", "docker-compose.yml"),
      "up",
      "-d",
      "--no-deps",
      "agent-bot",
    ]);
    expect(opts.stdio).toBe("ignore");
  });

  it("respects custom dockerBin override (tests can substitute a wrapper)", () => {
    const home = mkdtempSync(join(tmpdir(), "docker-fleet-"));
    (execFileSync as any).mockReturnValue(Buffer.from(""));

    bringUpAgentService({
      config: STUB_CONFIG,
      agentName: "bot",
      switchroomHome: home,
      dockerBin: "/usr/local/bin/podman",
      stdio: "ignore",
    });

    const [bin] = (execFileSync as any).mock.calls[0];
    expect(bin).toBe("/usr/local/bin/podman");
  });

  it("uses the injected generateComposeContent override when supplied (skips real generator)", () => {
    const home = mkdtempSync(join(tmpdir(), "docker-fleet-"));
    (execFileSync as any).mockReturnValue(Buffer.from(""));
    const customCompose = "services: {}\n";

    bringUpAgentService({
      config: STUB_CONFIG,
      agentName: "bot",
      switchroomHome: home,
      generateComposeContent: () => customCompose,
      stdio: "ignore",
    });

    expect(generateCompose).not.toHaveBeenCalled();
    const composePath = resolve(home, "compose", "docker-compose.yml");
    expect(readFileSync(composePath, "utf-8")).toBe(customCompose);
  });

  it("propagates docker failure as an error from execFileSync", () => {
    const home = mkdtempSync(join(tmpdir(), "docker-fleet-"));
    (execFileSync as any).mockImplementation(() => {
      const e = new Error("docker compose up failed: image pull error") as Error & { status: number };
      e.status = 1;
      throw e;
    });

    expect(() =>
      bringUpAgentService({
        config: STUB_CONFIG,
        agentName: "bot",
        switchroomHome: home,
        stdio: "ignore",
      }),
    ).toThrow(/docker compose up failed/);

    // The compose file MUST still have been persisted before the docker
    // shellout — that's what makes a retry possible.
    expect(existsSync(resolve(home, "compose", "docker-compose.yml"))).toBe(true);
  });
});

describe("resolveSwitchroomHome", () => {
  beforeEach(() => {
    delete process.env.SWITCHROOM_HOME;
  });

  it("explicit > env > HOME-derived precedence", () => {
    expect(resolveSwitchroomHome("/explicit")).toBe("/explicit");
    process.env.SWITCHROOM_HOME = "/from-env";
    expect(resolveSwitchroomHome()).toBe("/from-env");
    delete process.env.SWITCHROOM_HOME;
    expect(resolveSwitchroomHome()).toBe(resolve(process.env.HOME ?? "", ".switchroom"));
  });
});
