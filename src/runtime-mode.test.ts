/**
 * Tests for `isDockerRuntime`. Two signals: env var (set inside
 * containers by compose.ts) and compose-file presence (set on the
 * host by `switchroom apply`). Either fires.
 *
 * Why this matters: v0.7.2 only checked the env var, so an operator
 * running `switchroom agent status` from their host shell got systemd
 * fallback even on a docker fleet. The compose-file branch closes that
 * gap. This test locks in both signals.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("isDockerRuntime", () => {
  let sandbox: string;
  let prevHome: string | undefined;
  let prevRuntime: string | undefined;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "switchroom-runtime-"));
    prevHome = process.env.HOME;
    prevRuntime = process.env.SWITCHROOM_RUNTIME;
    process.env.HOME = sandbox;
    delete process.env.SWITCHROOM_RUNTIME;
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    if (prevRuntime !== undefined) process.env.SWITCHROOM_RUNTIME = prevRuntime;
    else delete process.env.SWITCHROOM_RUNTIME;
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns false when neither signal is set", async () => {
    const { isDockerRuntime } = await import("./runtime-mode.js");
    expect(isDockerRuntime()).toBe(false);
  });

  it("returns true when SWITCHROOM_RUNTIME=docker (no compose file needed)", async () => {
    process.env.SWITCHROOM_RUNTIME = "docker";
    const { isDockerRuntime } = await import("./runtime-mode.js");
    expect(isDockerRuntime()).toBe(true);
  });

  it("returns true when ~/.switchroom/compose/docker-compose.yml exists (host-shell signal)", async () => {
    // The headline v0.7.3 fix: an operator running `switchroom agent
    // status` from their host shell has no env var, but the compose
    // file's presence is the right signal that this fleet is docker.
    mkdirSync(join(sandbox, ".switchroom", "compose"), { recursive: true });
    writeFileSync(join(sandbox, ".switchroom", "compose", "docker-compose.yml"), "name: switchroom\n");
    const { isDockerRuntime } = await import("./runtime-mode.js");
    expect(isDockerRuntime()).toBe(true);
  });

  it("returns false when only an UNRELATED file lives under ~/.switchroom (no compose dir)", async () => {
    mkdirSync(join(sandbox, ".switchroom"), { recursive: true });
    writeFileSync(join(sandbox, ".switchroom", "switchroom.yaml"), "version: 1\n");
    const { isDockerRuntime } = await import("./runtime-mode.js");
    expect(isDockerRuntime()).toBe(false);
  });
});
