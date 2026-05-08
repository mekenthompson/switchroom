import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideRuntime,
  readRuntimeMode,
  hasActiveSystemdInstall,
  legacyAdvisoryText,
  type DecisionInput,
  type RunCommand,
} from "./runtime-detection.js";

function input(over: Partial<DecisionInput>): DecisionInput {
  return {
    platform: "linux",
    marker: null,
    hasActiveSystemd: false,
    legacy: false,
    ...over,
  };
}

describe("decideRuntime — Phase 3b-3 decision matrix", () => {
  it("marker=docker → docker, no advisory, no marker rewrite", () => {
    const d = decideRuntime(input({ marker: "docker", hasActiveSystemd: true }));
    expect(d.runtime).toBe("docker");
    expect(d.showLegacyAdvisory).toBe(false);
    expect(d.writeDockerMarkerAfter).toBe(false);
    expect(d.writeHostMarkerAfter).toBe(false);
  });

  it("marker=host → host, no advisory", () => {
    const d = decideRuntime(input({ marker: "host", hasActiveSystemd: false }));
    expect(d.runtime).toBe("host");
    expect(d.showLegacyAdvisory).toBe(false);
    expect(d.writeHostMarkerAfter).toBe(false);
  });

  it("non-linux (darwin) with no marker → host, no advisory, no flip", () => {
    const d = decideRuntime(input({ platform: "darwin" }));
    expect(d.runtime).toBe("host");
    expect(d.showLegacyAdvisory).toBe(false);
    expect(d.writeHostMarkerAfter).toBe(false);
    expect(d.writeDockerMarkerAfter).toBe(false);
  });

  it("linux + --legacy on a fresh host → host, no advisory, write host marker", () => {
    const d = decideRuntime(input({ legacy: true, hasActiveSystemd: false }));
    expect(d.runtime).toBe("host");
    expect(d.showLegacyAdvisory).toBe(false);
    expect(d.writeHostMarkerAfter).toBe(true);
  });

  it("linux + --legacy + active systemd → host, no advisory (operator opted in)", () => {
    const d = decideRuntime(input({ legacy: true, hasActiveSystemd: true }));
    expect(d.runtime).toBe("host");
    expect(d.showLegacyAdvisory).toBe(false);
    expect(d.writeHostMarkerAfter).toBe(true);
  });

  it("linux + active systemd, no flag → host with legacy advisory", () => {
    const d = decideRuntime(input({ hasActiveSystemd: true }));
    expect(d.runtime).toBe("host");
    expect(d.showLegacyAdvisory).toBe(true);
    expect(d.writeHostMarkerAfter).toBe(false);
  });

  it("linux + no systemd, no marker, no flag → docker (default flip), write marker", () => {
    const d = decideRuntime(input({}));
    expect(d.runtime).toBe("docker");
    expect(d.showLegacyAdvisory).toBe(false);
    expect(d.writeDockerMarkerAfter).toBe(true);
  });
});

describe("readRuntimeMode", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when missing", () => {
    dir = mkdtempSync(join(tmpdir(), "rt-"));
    expect(readRuntimeMode(join(dir, "missing"))).toBe(null);
  });

  it("returns 'host' / 'docker' for valid contents", () => {
    dir = mkdtempSync(join(tmpdir(), "rt-"));
    const p1 = join(dir, "m1");
    writeFileSync(p1, "host\n");
    expect(readRuntimeMode(p1)).toBe("host");
    const p2 = join(dir, "m2");
    writeFileSync(p2, "docker");
    expect(readRuntimeMode(p2)).toBe("docker");
  });

  it("returns null for garbage contents", () => {
    dir = mkdtempSync(join(tmpdir(), "rt-"));
    const p = join(dir, "m");
    writeFileSync(p, "potato");
    expect(readRuntimeMode(p)).toBe(null);
  });
});

describe("hasActiveSystemdInstall", () => {
  it("returns true when systemctl reports an enabled switchroom-* unit", async () => {
    const run: RunCommand = async () => ({
      stdout:
        "switchroom-klanker.service             enabled         enabled\n" +
        "switchroom-vault-broker.service        enabled         enabled\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await hasActiveSystemdInstall(run)).toBe(true);
  });

  it("returns false on empty unit list", async () => {
    const run: RunCommand = async () => ({ stdout: "", stderr: "", exitCode: 0 });
    expect(await hasActiveSystemdInstall(run)).toBe(false);
  });

  it("returns false when units exist but are disabled", async () => {
    const run: RunCommand = async () => ({
      stdout: "switchroom-foo.service        disabled        enabled\n",
      stderr: "",
      exitCode: 0,
    });
    expect(await hasActiveSystemdInstall(run)).toBe(false);
  });

  it("returns false on non-zero exit (no systemd at all)", async () => {
    const run: RunCommand = async () => ({
      stdout: "",
      stderr: "command not found",
      exitCode: 127,
    });
    expect(await hasActiveSystemdInstall(run)).toBe(false);
  });

  it("returns false when runner throws", async () => {
    const run: RunCommand = async () => {
      throw new Error("boom");
    };
    expect(await hasActiveSystemdInstall(run)).toBe(false);
  });
});

describe("legacyAdvisoryText", () => {
  it("mentions the migrate verb and the --legacy flag", () => {
    const t = legacyAdvisoryText();
    expect(t).toContain("switchroom migrate to-docker");
    expect(t).toContain("--legacy");
    expect(t).toMatch(/legacy systemd/);
  });
});
