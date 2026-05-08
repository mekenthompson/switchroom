import { describe, it, expect } from "vitest";
import { checkRuntimeCoexistence, runDockerChecks } from "./doctor-docker.js";
import type { SwitchroomConfig } from "../config/schema.js";

describe("checkRuntimeCoexistence — Phase 3b-3", () => {
  it("warns when marker=docker but systemd units remain enabled", () => {
    const r = checkRuntimeCoexistence({
      marker: "docker",
      enabledSystemdUnits: [
        "switchroom-klanker.service",
        "switchroom-vault-broker.service",
      ],
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/runtime-mode=docker/);
    expect(r.detail).toMatch(/switchroom-klanker/);
    expect(r.fix).toBeTruthy();
  });

  it("ok when marker=host and systemd units are present (consistent)", () => {
    const r = checkRuntimeCoexistence({
      marker: "host",
      enabledSystemdUnits: ["switchroom-klanker.service"],
    });
    expect(r.status).toBe("ok");
  });

  it("ok when marker=docker and no systemd units are enabled", () => {
    const r = checkRuntimeCoexistence({
      marker: "docker",
      enabledSystemdUnits: [],
    });
    expect(r.status).toBe("ok");
  });

  it("warns when marker is absent but systemd units exist (operator hasn't pinned)", () => {
    const r = checkRuntimeCoexistence({
      marker: null,
      enabledSystemdUnits: ["switchroom-klanker.service"],
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toMatch(/marker absent/);
    expect(r.fix).toMatch(/--legacy/);
  });

  it("ok on a fresh host (no marker, no systemd)", () => {
    const r = checkRuntimeCoexistence({
      marker: null,
      enabledSystemdUnits: [],
    });
    expect(r.status).toBe("ok");
  });

  it("does NOT escalate to fail (warn ceiling — coexistence is legitimate mid-migration)", () => {
    const r = checkRuntimeCoexistence({
      marker: "docker",
      enabledSystemdUnits: Array.from({ length: 20 }, (_, i) => `switchroom-a${i}.service`),
    });
    expect(r.status).not.toBe("fail");
    expect(r.detail).toMatch(/\.\.\./); // truncated list
  });
});

describe("runDockerChecks — coexistence wiring", () => {
  const cfg = { agents: { klanker: {} } } as unknown as SwitchroomConfig;

  it("includes coexistence even when docker mode is inactive", () => {
    const checks = runDockerChecks({
      config: cfg,
      active: false,
      marker: "docker",
      enabledSystemdUnits: ["switchroom-klanker.service"],
    });
    const co = checks.find((c) => c.name === "runtime coexistence");
    expect(co?.status).toBe("warn");
  });

  it("includes coexistence when docker mode is active", () => {
    const checks = runDockerChecks({
      config: cfg,
      active: true,
      marker: "docker",
      enabledSystemdUnits: [],
    });
    expect(checks.find((c) => c.name === "runtime coexistence")?.status).toBe("ok");
  });

  it("omits coexistence when caller doesn't supply marker/units (back-compat)", () => {
    const checks = runDockerChecks({
      config: cfg,
      active: true,
    });
    expect(checks.find((c) => c.name === "runtime coexistence")).toBeUndefined();
  });
});
