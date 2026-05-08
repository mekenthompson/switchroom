import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkGitClean,
  checkRuntimeMode,
  checkSharedHost,
  checkSystemdHealthy,
  checkVaultUnlocked,
  readRuntimeMode,
  runPreflight,
  type RunCommand,
  type RunCommandResult,
} from "./preflight.js";
import type { BrokerStatus } from "../../vault/broker/protocol.js";

function fakeRun(
  table: Record<string, RunCommandResult | ((args: readonly string[]) => RunCommandResult)>,
): RunCommand {
  return async (cmd, args) => {
    const key = `${cmd} ${args.join(" ")}`;
    for (const [pattern, val] of Object.entries(table)) {
      if (key.startsWith(pattern)) {
        return typeof val === "function" ? val(args) : val;
      }
    }
    return { stdout: "", stderr: `unmocked: ${key}`, exitCode: 127 };
  };
}

const ok = (stdout = ""): RunCommandResult => ({ stdout, stderr: "", exitCode: 0 });

const unlocked = (): Promise<BrokerStatus | null> =>
  Promise.resolve({ unlocked: true, keyCount: 1, uptimeSec: 1 });
const locked = (): Promise<BrokerStatus | null> =>
  Promise.resolve({ unlocked: false, keyCount: 0, uptimeSec: 1 });
const unreachable = (): Promise<BrokerStatus | null> => Promise.resolve(null);

describe("checkGitClean", () => {
  it("passes on a clean tree", async () => {
    const r = await checkGitClean({ runCommand: fakeRun({ "git -C": ok("") }) });
    expect(r.ok).toBe(true);
  });

  it("refuses on a dirty tree", async () => {
    const r = await checkGitClean({
      runCommand: fakeRun({ "git -C": ok(" M src/foo.ts\n") }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/uncommitted changes/);
  });

  it("refuses if git itself fails", async () => {
    const r = await checkGitClean({
      runCommand: fakeRun({ "git -C": { stdout: "", stderr: "not a repo", exitCode: 128 } }),
    });
    expect(r.ok).toBe(false);
  });
});

describe("checkVaultUnlocked", () => {
  it("passes when broker reports unlocked", async () => {
    const r = await checkVaultUnlocked({ probeBroker: unlocked });
    expect(r.ok).toBe(true);
  });

  it("refuses when broker is locked", async () => {
    const r = await checkVaultUnlocked({ probeBroker: locked });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/locked/);
  });

  it("refuses when broker is unreachable", async () => {
    const r = await checkVaultUnlocked({ probeBroker: unreachable });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/not reachable/);
  });

  it("refuses when probe throws", async () => {
    const r = await checkVaultUnlocked({
      probeBroker: () => Promise.reject(new Error("boom")),
    });
    expect(r.ok).toBe(false);
  });
});

describe("checkSystemdHealthy", () => {
  it("skips for to-host", async () => {
    const r = await checkSystemdHealthy("to-host", {
      runCommand: fakeRun({ systemctl: { stdout: "x", stderr: "", exitCode: 0 } }),
    });
    expect(r.ok).toBe(true);
  });

  it("passes when no failed switchroom-* units", async () => {
    const r = await checkSystemdHealthy("to-docker", {
      runCommand: fakeRun({ systemctl: ok("") }),
    });
    expect(r.ok).toBe(true);
  });

  it("refuses when failed switchroom-* units exist", async () => {
    const r = await checkSystemdHealthy("to-docker", {
      runCommand: fakeRun({
        systemctl: ok("switchroom-klanker.service loaded failed failed klanker\n"),
      }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/switchroom-klanker.service/);
  });
});

describe("checkSharedHost", () => {
  it("passes when fleet count == total", async () => {
    const r = await checkSharedHost(
      { sharedHost: false },
      {
        runCommand: fakeRun({
          "docker ps -aq --filter": ok("a\nb\n"),
          "docker ps -aq": ok("a\nb\n"),
        }),
      },
    );
    expect(r.ok).toBe(true);
  });

  it("refuses on foreign containers without --shared-host", async () => {
    const r = await checkSharedHost(
      { sharedHost: false },
      {
        runCommand: fakeRun({
          "docker ps -aq --filter": ok("a\n"),
          "docker ps -aq": ok("a\nb\nc\n"),
        }),
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/2 foreign/);
  });

  it("passes on foreign containers when --shared-host is set", async () => {
    const r = await checkSharedHost(
      { sharedHost: true },
      {
        runCommand: fakeRun({
          "docker ps -aq --filter": ok("a\n"),
          "docker ps -aq": ok("a\nb\nc\n"),
        }),
      },
    );
    expect(r.ok).toBe(true);
  });

  it("refuses if docker ps fails", async () => {
    const r = await checkSharedHost(
      { sharedHost: false },
      {
        runCommand: fakeRun({
          "docker ps -aq": { stdout: "", stderr: "no daemon", exitCode: 1 },
        }),
      },
    );
    expect(r.ok).toBe(false);
  });
});

describe("readRuntimeMode + checkRuntimeMode", () => {
  function tmpMarker(content: string | null): string {
    const dir = mkdtempSync(join(tmpdir(), "sr-rt-"));
    const path = join(dir, "runtime-mode");
    if (content !== null) writeFileSync(path, content);
    return path;
  }

  it("returns null when missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "sr-rt-"));
    expect(readRuntimeMode(join(dir, "missing"))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads host/docker", () => {
    const p1 = tmpMarker("host\n");
    const p2 = tmpMarker("docker");
    expect(readRuntimeMode(p1)).toBe("host");
    expect(readRuntimeMode(p2)).toBe("docker");
  });

  it("ignores garbage", () => {
    const p = tmpMarker("nonsense");
    expect(readRuntimeMode(p)).toBeNull();
  });

  it("to-docker refuses if mode is already docker", async () => {
    const p = tmpMarker("docker");
    const r = await checkRuntimeMode("to-docker", { runtimeModePath: p });
    expect(r.ok).toBe(false);
  });

  it("to-docker passes if mode is host or missing", async () => {
    const p1 = tmpMarker("host");
    expect((await checkRuntimeMode("to-docker", { runtimeModePath: p1 })).ok).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "sr-rt-"));
    expect(
      (await checkRuntimeMode("to-docker", { runtimeModePath: join(dir, "x") })).ok,
    ).toBe(true);
  });

  it("to-host refuses if mode is host or missing", async () => {
    const p = tmpMarker("host");
    expect((await checkRuntimeMode("to-host", { runtimeModePath: p })).ok).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "sr-rt-"));
    expect(
      (await checkRuntimeMode("to-host", { runtimeModePath: join(dir, "x") })).ok,
    ).toBe(false);
  });

  it("to-host passes if mode is docker", async () => {
    const p = tmpMarker("docker");
    expect((await checkRuntimeMode("to-host", { runtimeModePath: p })).ok).toBe(true);
  });
});

describe("runPreflight composer", () => {
  it("short-circuits at the first failing check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sr-rt-"));
    const marker = join(dir, "rt");
    writeFileSync(marker, "host");
    const result = await runPreflight(
      "to-docker",
      { sharedHost: false },
      {
        runtimeModePath: marker,
        probeBroker: unlocked,
        runCommand: fakeRun({
          "git -C": ok(" M dirty.ts\n"), // refuses here
          systemctl: ok(""),
          "docker ps -aq --filter": ok(""),
          "docker ps -aq": ok(""),
        }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.refusal?.name).toBe("git-clean");
    expect(result.checks).toHaveLength(1);
  });

  it("returns ok=true when every check passes (to-docker)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sr-rt-"));
    const marker = join(dir, "rt");
    writeFileSync(marker, "host");
    const result = await runPreflight(
      "to-docker",
      { sharedHost: false },
      {
        runtimeModePath: marker,
        probeBroker: unlocked,
        runCommand: fakeRun({
          "git -C": ok(""),
          systemctl: ok(""),
          "docker ps -aq --filter": ok("a\n"),
          "docker ps -aq": ok("a\n"),
        }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(5);
  });

  it("returns ok=true for to-host with docker marker", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sr-rt-"));
    const marker = join(dir, "rt");
    writeFileSync(marker, "docker");
    const result = await runPreflight(
      "to-host",
      { sharedHost: false },
      {
        runtimeModePath: marker,
        probeBroker: unlocked,
        runCommand: fakeRun({
          "git -C": ok(""),
          systemctl: ok(""),
          "docker ps -aq --filter": ok(""),
          "docker ps -aq": ok(""),
        }),
      },
    );
    expect(result.ok).toBe(true);
  });
});
