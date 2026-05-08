import { describe, it, expect } from "vitest";
import { runUp, type UpDeps } from "./up.js";
import type { SwitchroomConfig } from "../config/schema.js";

/** Minimal config stub — runUp only forwards it through to the start* hooks. */
const stubConfig = { agents: { klanker: {} } } as unknown as SwitchroomConfig;

interface Spy {
  startedDocker: number;
  startedSystemd: number;
  out: string;
}

function makeDeps(over: Partial<UpDeps>): UpDeps & { spy: Spy } {
  const spy: Spy = { startedDocker: 0, startedSystemd: 0, out: "" };
  return {
    startDockerFleet: async () => { spy.startedDocker++; },
    startSystemdFleet: async () => { spy.startedSystemd++; },
    writeOut: (s) => { spy.out += s; },
    ...over,
    spy,
  } as UpDeps & { spy: Spy };
}

describe("runUp — simplified branch selector", () => {
  it("Linux + no flag → docker", async () => {
    const deps = makeDeps({ platform: "linux" });
    const res = await runUp(stubConfig, {}, deps);
    expect(res.runtime).toBe("docker");
    expect(deps.spy.startedDocker).toBe(1);
    expect(deps.spy.startedSystemd).toBe(0);
  });

  it("Linux + --legacy → systemd", async () => {
    const deps = makeDeps({ platform: "linux" });
    const res = await runUp(stubConfig, { legacy: true }, deps);
    expect(res.runtime).toBe("host");
    expect(deps.spy.startedDocker).toBe(0);
    expect(deps.spy.startedSystemd).toBe(1);
  });

  it("macOS → systemd (Docker Desktop is best-effort, not the production runtime)", async () => {
    const deps = makeDeps({ platform: "darwin" });
    const res = await runUp(stubConfig, {}, deps);
    expect(res.runtime).toBe("host");
    expect(deps.spy.startedSystemd).toBe(1);
  });

  it("macOS + --legacy → systemd (still systemd, --legacy is a no-op off Linux)", async () => {
    const deps = makeDeps({ platform: "darwin" });
    const res = await runUp(stubConfig, { legacy: true }, deps);
    expect(res.runtime).toBe("host");
    expect(deps.spy.startedSystemd).toBe(1);
  });

  it("propagates errors from the start hook", async () => {
    const deps = makeDeps({
      platform: "linux",
      startDockerFleet: async () => { throw new Error("compose blew up"); },
    });
    await expect(runUp(stubConfig, {}, deps)).rejects.toThrow(/compose blew up/);
  });
});
