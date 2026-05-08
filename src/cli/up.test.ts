import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUp, type UpDeps } from "./up.js";
import type { SwitchroomConfig } from "../config/schema.js";

/** Minimal config stub — runUp only forwards it through to the start* hooks. */
const stubConfig = { agents: { klanker: {} } } as unknown as SwitchroomConfig;

interface Spy {
  startedDocker: number;
  startedSystemd: number;
  err: string;
  out: string;
}

function makeDeps(over: Partial<UpDeps> & { dir: string }): UpDeps & { spy: Spy } {
  const spy: Spy = { startedDocker: 0, startedSystemd: 0, err: "", out: "" };
  return {
    runtimeModePath: join(over.dir, "runtime-mode"),
    runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    startDockerFleet: async () => { spy.startedDocker++; },
    startSystemdFleet: async () => { spy.startedSystemd++; },
    writeErr: (s) => { spy.err += s; },
    writeOut: (s) => { spy.out += s; },
    ...over,
    spy,
  } as UpDeps & { spy: Spy };
}

describe("runUp — Phase 3b-3 acceptance matrix", () => {
  let dir: string;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("(1) fresh Linux, no marker, no systemd → docker, marker=docker, no advisory", async () => {
    dir = mkdtempSync(join(tmpdir(), "up-"));
    const deps = makeDeps({ dir, platform: "linux" });
    const res = await runUp(stubConfig, {}, deps);
    expect(res.runtime).toBe("docker");
    expect(res.printedAdvisory).toBe(false);
    expect(res.markerWritten).toBe("docker");
    expect(deps.spy.startedDocker).toBe(1);
    expect(deps.spy.startedSystemd).toBe(0);
    expect(readFileSync(join(dir, "runtime-mode"), "utf8").trim()).toBe("docker");
  });

  it("(2) Linux with active systemd, no marker, no flag → systemd + advisory; marker untouched", async () => {
    dir = mkdtempSync(join(tmpdir(), "up-"));
    const deps = makeDeps({
      dir,
      platform: "linux",
      runCommand: async () => ({
        stdout: "switchroom-klanker.service             enabled         enabled\n",
        stderr: "",
        exitCode: 0,
      }),
    });
    const res = await runUp(stubConfig, {}, deps);
    expect(res.runtime).toBe("host");
    expect(res.printedAdvisory).toBe(true);
    expect(res.markerWritten).toBe(null);
    expect(deps.spy.startedSystemd).toBe(1);
    expect(deps.spy.err).toContain("legacy systemd runtime");
    expect(deps.spy.err).toContain("--legacy");
    expect(existsSync(join(dir, "runtime-mode"))).toBe(false);
  });

  it("(3) --legacy on the same Linux+systemd host → systemd, NO advisory, marker=host", async () => {
    dir = mkdtempSync(join(tmpdir(), "up-"));
    const deps = makeDeps({
      dir,
      platform: "linux",
      runCommand: async () => ({
        stdout: "switchroom-klanker.service             enabled         enabled\n",
        stderr: "",
        exitCode: 0,
      }),
    });
    const res = await runUp(stubConfig, { legacy: true }, deps);
    expect(res.runtime).toBe("host");
    expect(res.printedAdvisory).toBe(false);
    expect(res.markerWritten).toBe("host");
    expect(deps.spy.err).not.toContain("legacy systemd runtime");
    expect(readFileSync(join(dir, "runtime-mode"), "utf8").trim()).toBe("host");
  });

  it("(4) macOS with no marker → systemd path (current behaviour), no flip, no advisory", async () => {
    dir = mkdtempSync(join(tmpdir(), "up-"));
    const deps = makeDeps({ dir, platform: "darwin" });
    const res = await runUp(stubConfig, {}, deps);
    expect(res.runtime).toBe("host");
    expect(res.printedAdvisory).toBe(false);
    expect(res.markerWritten).toBe(null);
    expect(existsSync(join(dir, "runtime-mode"))).toBe(false);
  });

  it("(5) marker=docker → docker, regardless of systemd state, no advisory", async () => {
    dir = mkdtempSync(join(tmpdir(), "up-"));
    writeFileSync(join(dir, "runtime-mode"), "docker\n");
    const deps = makeDeps({
      dir,
      platform: "linux",
      // systemd probe should NOT be consulted; if it were, this would
      // try to flip the result. We assert decision is unaffected.
      runCommand: async () => ({
        stdout: "switchroom-klanker.service enabled enabled\n",
        stderr: "",
        exitCode: 0,
      }),
    });
    const res = await runUp(stubConfig, {}, deps);
    expect(res.runtime).toBe("docker");
    expect(res.printedAdvisory).toBe(false);
    expect(res.markerWritten).toBe(null);
    expect(deps.spy.startedDocker).toBe(1);
  });

  it("marker=host → systemd, no advisory", async () => {
    dir = mkdtempSync(join(tmpdir(), "up-"));
    writeFileSync(join(dir, "runtime-mode"), "host\n");
    const deps = makeDeps({ dir, platform: "linux" });
    const res = await runUp(stubConfig, {}, deps);
    expect(res.runtime).toBe("host");
    expect(res.printedAdvisory).toBe(false);
    expect(res.markerWritten).toBe(null);
    expect(deps.spy.startedSystemd).toBe(1);
  });

  it("--legacy on a fresh Linux host (no systemd) still uses systemd and writes marker=host", async () => {
    dir = mkdtempSync(join(tmpdir(), "up-"));
    const deps = makeDeps({ dir, platform: "linux" });
    const res = await runUp(stubConfig, { legacy: true }, deps);
    expect(res.runtime).toBe("host");
    expect(res.markerWritten).toBe("host");
    expect(deps.spy.startedSystemd).toBe(1);
  });

  it("propagates errors from the start hook (does not write marker on failure)", async () => {
    dir = mkdtempSync(join(tmpdir(), "up-"));
    const deps = makeDeps({
      dir,
      platform: "linux",
      startDockerFleet: async () => { throw new Error("compose blew up"); },
    });
    await expect(runUp(stubConfig, {}, deps)).rejects.toThrow(/compose blew up/);
    expect(existsSync(join(dir, "runtime-mode"))).toBe(false);
  });
});
