import { describe, it, expect } from "vitest";

import {
  runHostdChecks,
  HOSTD_DRIFT_HOURS,
  type HostdProbeDeps,
} from "../src/cli/doctor-hostd.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

function cfg(enabled: boolean, agents: string[] = ["a"]): SwitchroomConfig {
  return {
    host_control: enabled ? { enabled: true } : { enabled: false },
    agents: Object.fromEntries(agents.map((n) => [n, {}])),
  } as unknown as SwitchroomConfig;
}

/** Build a dockerInspect fake from a {`ref|format`: value} map. */
function fakeInspect(map: Record<string, string | null>): HostdProbeDeps {
  return {
    dockerInspect: (ref, format) => map[`${ref}|${format}`] ?? null,
  };
}

const HOSTD = "switchroom-hostd";

describe("runHostdChecks", () => {
  it("warns once when host_control is not enabled", () => {
    const r = runHostdChecks(cfg(false));
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("hostd: configured");
    expect(r[0].status).toBe("warn");
    expect(r[0].fix).toContain("switchroom hostd install");
  });

  it("fails 'running' when enabled but the container is absent", () => {
    const r = runHostdChecks(cfg(true), fakeInspect({}));
    expect(r.find((x) => x.name === "hostd: configured")?.status).toBe("ok");
    const running = r.find((x) => x.name === "hostd: running");
    expect(running?.status).toBe("fail");
    expect(running?.detail).toContain("not found");
    // drift check skipped when not running
    expect(r.find((x) => x.name === "hostd: image drift")).toBeUndefined();
  });

  it("fails 'running' when the container is stopped", () => {
    const r = runHostdChecks(
      cfg(true),
      fakeInspect({ [`${HOSTD}|{{.State.Status}}`]: "exited" }),
    );
    expect(r.find((x) => x.name === "hostd: running")?.status).toBe("fail");
    expect(r.find((x) => x.name === "hostd: running")?.detail).toContain(
      "exited",
    );
  });

  it("all-ok when running and image vintage is in sync", () => {
    const now = "2026-05-18T10:00:00.000Z";
    const r = runHostdChecks(
      cfg(true),
      fakeInspect({
        [`${HOSTD}|{{.State.Status}}`]: "running",
        [`${HOSTD}|{{.Image}}`]: "sha256:hostdimg",
        ["sha256:hostdimg|{{.Created}}"]: now,
        ["switchroom-a|{{.Image}}"]: "sha256:agentimg",
        ["sha256:agentimg|{{.Created}}"]: now,
      }),
    );
    expect(r.map((x) => x.status)).toEqual(["ok", "ok", "ok"]);
    expect(r.find((x) => x.name === "hostd: image drift")?.detail).toContain(
      "in sync",
    );
  });

  it("warns on image drift when hostd lags the agent fleet", () => {
    const hostd = "2026-05-17T09:00:00.000Z";
    const agent = "2026-05-18T10:00:00.000Z"; // ~25h newer
    const r = runHostdChecks(
      cfg(true),
      fakeInspect({
        [`${HOSTD}|{{.State.Status}}`]: "running",
        [`${HOSTD}|{{.Image}}`]: "sha256:old",
        ["sha256:old|{{.Created}}"]: hostd,
        ["switchroom-a|{{.Image}}"]: "sha256:new",
        ["sha256:new|{{.Created}}"]: agent,
      }),
    );
    const drift = r.find((x) => x.name === "hostd: image drift");
    expect(drift?.status).toBe("warn");
    expect(drift?.detail).toContain("--skip-images");
    expect(drift?.fix).toContain("switchroom hostd install");
  });

  it("does not warn when lag is within the threshold", () => {
    const base = Date.parse("2026-05-18T10:00:00.000Z");
    const hostd = new Date(
      base - (HOSTD_DRIFT_HOURS - 0.5) * 3_600_000,
    ).toISOString();
    const r = runHostdChecks(
      cfg(true),
      fakeInspect({
        [`${HOSTD}|{{.State.Status}}`]: "running",
        [`${HOSTD}|{{.Image}}`]: "sha256:h",
        ["sha256:h|{{.Created}}"]: hostd,
        ["switchroom-a|{{.Image}}"]: "sha256:a",
        ["sha256:a|{{.Created}}"]: "2026-05-18T10:00:00.000Z",
      }),
    );
    expect(r.find((x) => x.name === "hostd: image drift")?.status).toBe("ok");
  });

  it("skips drift gracefully when no agent image is resolvable", () => {
    const r = runHostdChecks(
      cfg(true, ["a"]),
      fakeInspect({
        [`${HOSTD}|{{.State.Status}}`]: "running",
        [`${HOSTD}|{{.Image}}`]: "sha256:h",
        ["sha256:h|{{.Created}}"]: "2026-05-18T10:00:00.000Z",
        // no switchroom-a image entries
      }),
    );
    const drift = r.find((x) => x.name === "hostd: image drift");
    expect(drift?.status).toBe("ok");
    expect(drift?.detail).toContain("skipped");
  });
});
