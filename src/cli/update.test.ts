/**
 * Unit tests for `switchroom update` (#918). Drives the planUpdate
 * step builder + runUpdate dispatch with a fake runner so no real
 * docker / git / bun is invoked.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planUpdate, runUpdate, isGitCheckout } from "./update.js";

function fakeRunner() {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  let nextStatus = 0;
  return {
    calls,
    setNextStatus(n: number) { nextStatus = n; },
    fn: (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const s = nextStatus;
      nextStatus = 0;
      return { status: s };
    },
  };
}

describe("planUpdate", () => {
  it("produces 4 steps in default mode (no --rebuild)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-plan-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({ composePath });
      expect(steps.map((s) => s.name)).toEqual([
        "pull-images",
        "apply-config",
        "recreate-containers",
        "doctor",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("inserts the rebuild-source step when --rebuild is set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-rebuild-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({ composePath, rebuild: true });
      expect(steps.map((s) => s.name)).toEqual([
        "pull-images",
        "rebuild-source",
        "apply-config",
        "recreate-containers",
        "doctor",
      ]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips pull-images with a clear reason when --skip-images is set", () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-skip-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const steps = planUpdate({ composePath, skipImages: true });
      const pull = steps.find((s) => s.name === "pull-images");
      expect(pull?.skipReason).toContain("--skip-images");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips pull-images with the right reason when compose file doesn't exist", () => {
    const steps = planUpdate({ composePath: "/nonexistent/compose.yml" });
    const pull = steps.find((s) => s.name === "pull-images");
    expect(pull?.skipReason).toContain("compose file not found");
    expect(pull?.skipReason).toContain("apply --compose-only");
  });

  it("never skips recreate-containers — even with --skip-images, apply may have changed compose (#923 reviewer)", () => {
    const steps = planUpdate({ skipImages: true });
    const recreate = steps.find((s) => s.name === "recreate-containers");
    expect(recreate?.skipReason).toBeUndefined();
  });
});

describe("--rebuild against a non-checkout install fails loudly (#923 reviewer)", () => {
  it("rebuild-source step throws when scriptPath has no .git ancestor", () => {
    const tmp = mkdtempSync(join(tmpdir(), "rebuild-no-git-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      // Spoof argv[1] to a path with no .git ancestor for the duration
      // of the plan() + run() calls.
      const origArgv1 = process.argv[1];
      process.argv[1] = join(tmp, "fake-installed-cli.js");
      try {
        const steps = planUpdate({ composePath, rebuild: true });
        const rebuild = steps.find((s) => s.name === "rebuild-source");
        expect(rebuild).toBeDefined();
        expect(rebuild?.skipReason).toBeUndefined(); // not silently skipped
        expect(() => rebuild!.run()).toThrow(/--rebuild requires a git checkout/);
      } finally {
        process.argv[1] = origArgv1;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runUpdate", () => {
  it("dry-runs cleanly under --check, no runner calls", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-check-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const out: string[] = [];
      const runner = fakeRunner();
      const code = await runUpdate({
        check: true,
        composePath,
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        runner: runner.fn,
      });
      expect(code).toBe(0);
      expect(runner.calls).toHaveLength(0);
      const joined = out.join("");
      expect(joined).toMatch(/dry-run/);
      expect(joined).toMatch(/pull-images/);
      expect(joined).toMatch(/apply-config/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runs the steps in order via the injected runner", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-run-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const out: string[] = [];
      const runner = fakeRunner();
      const code = await runUpdate({
        composePath,
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        runner: runner.fn,
      });
      expect(code).toBe(0);
      // 4 calls: pull, apply, up, doctor. Identify each by its
      // signature args (cmd + first non-script arg).
      expect(runner.calls).toHaveLength(4);
      // [0] docker compose ... pull
      expect(runner.calls[0]?.cmd).toBe("docker");
      expect(runner.calls[0]?.args).toContain("pull");
      // [1] <execPath> <scriptPath> apply --non-interactive
      expect(runner.calls[1]?.cmd).toBe(process.execPath);
      expect(runner.calls[1]?.args).toContain("apply");
      expect(runner.calls[1]?.args).toContain("--non-interactive");
      // [2] docker compose ... up -d --remove-orphans
      expect(runner.calls[2]?.cmd).toBe("docker");
      expect(runner.calls[2]?.args).toContain("up");
      expect(runner.calls[2]?.args).toContain("--remove-orphans");
      // [3] <execPath> <scriptPath> doctor
      expect(runner.calls[3]?.cmd).toBe(process.execPath);
      expect(runner.calls[3]?.args).toContain("doctor");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails fast on a step error and reports which step", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "update-fail-"));
    try {
      const composePath = join(tmp, "docker-compose.yml");
      writeFileSync(composePath, "services: {}\n");
      const out: string[] = [];
      const runner = fakeRunner();
      runner.setNextStatus(1); // first call (pull) fails
      const code = await runUpdate({
        composePath,
        stdout: (s) => out.push(s),
        stderr: (s) => out.push(s),
        runner: runner.fn,
      });
      expect(code).toBe(1);
      // Should NOT have proceeded to apply / up / doctor.
      expect(runner.calls).toHaveLength(1);
      expect(out.join("")).toMatch(/pull-images failed/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("isGitCheckout", () => {
  it("returns true for a path under a directory containing .git", () => {
    const tmp = mkdtempSync(join(tmpdir(), "git-detect-"));
    try {
      mkdirSync(join(tmp, ".git"), { recursive: true });
      mkdirSync(join(tmp, "dist", "cli"), { recursive: true });
      const scriptPath = join(tmp, "dist", "cli", "switchroom.js");
      writeFileSync(scriptPath, "");
      expect(isGitCheckout(scriptPath)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns false for a path with no .git ancestor", () => {
    const tmp = mkdtempSync(join(tmpdir(), "no-git-detect-"));
    try {
      mkdirSync(join(tmp, "dist", "cli"), { recursive: true });
      const scriptPath = join(tmp, "dist", "cli", "switchroom.js");
      writeFileSync(scriptPath, "");
      expect(isGitCheckout(scriptPath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
