import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock execFileSync so `docker run` never actually fires. We capture
// the args to assert on the command shape.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import {
  startHindsight,
  stopHindsight,
  writeHindsightLlmKeyFile,
  hindsightSecretEnvFilePath,
  pickHindsightSecretDir,
} from "../../src/setup/hindsight.js";

const mockedExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

// We isolate filesystem side-effects by stubbing the tmpfs dir picker. The
// real implementation tries `/run/switchroom/hindsight` then `/dev/shm/...`;
// in CI/test we redirect both into a per-test tmpdir.
//
// We do this by monkey-patching the env / using a tmpdir override: but
// since pickHindsightSecretDir() doesn't read env, we go a different
// route — write a wrapper that pre-creates one of the candidate dirs
// under our test tmpdir and points it via a module-scoped override.
//
// Simpler approach: write to `/dev/shm` if it's writable (it is on Linux
// CI); skip the test on platforms where it isn't. The function under test
// already returns the chosen path so the assertion can introspect it.

describe("hindsight secret env-file (#1068)", () => {
  let writtenPath: string | null = null;

  beforeEach(() => {
    mockedExec.mockReset();
    mockedExec.mockReturnValue("");
    writtenPath = null;
  });

  afterEach(() => {
    if (writtenPath && existsSync(writtenPath)) {
      try { rmSync(writtenPath); } catch { /* best-effort */ }
    }
  });

  it("does NOT pass HINDSIGHT_API_LLM_API_KEY via -e", () => {
    startHindsight("openai", "sk-test-secret-value-do-not-leak", {
      apiPort: 8888,
      uiPort: 9999,
    });

    // Find the docker-run call.
    const runCall = mockedExec.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "run",
    );
    expect(runCall).toBeDefined();
    const args = runCall![1] as string[];

    // Joined arg string must not contain the API key value or the
    // sensitive var name as a `-e` value.
    const joined = args.join(" ");
    expect(joined).not.toContain("sk-test-secret-value-do-not-leak");
    expect(joined).not.toContain("-e HINDSIGHT_API_LLM_API_KEY");

    // And no `-e KEY=VALUE` entry should contain the key name.
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") {
        expect(args[i + 1]).not.toMatch(/^HINDSIGHT_API_LLM_API_KEY=/);
      }
    }
  });

  it("passes --env-file <path> when apiKey is supplied", () => {
    startHindsight("openai", "sk-another-test-key-value", {
      apiPort: 8888,
      uiPort: 9999,
    });

    const runCall = mockedExec.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "run",
    );
    const args = runCall![1] as string[];

    const envFileIdx = args.indexOf("--env-file");
    expect(envFileIdx).toBeGreaterThanOrEqual(0);
    const envFilePath = args[envFileIdx + 1];
    expect(envFilePath).toBeTruthy();
    writtenPath = envFilePath;

    // File should exist and be mode 0600.
    expect(existsSync(envFilePath)).toBe(true);
    const mode = statSync(envFilePath).mode & 0o777;
    expect(mode).toBe(0o600);

    // Contents should be exactly one line.
    const content = readFileSync(envFilePath, "utf-8");
    expect(content).toBe("HINDSIGHT_API_LLM_API_KEY=sk-another-test-key-value\n");
  });

  it("does NOT pass --env-file when apiKey is undefined", () => {
    startHindsight("ollama", undefined, { apiPort: 8888, uiPort: 9999 });

    const runCall = mockedExec.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "run",
    );
    const args = runCall![1] as string[];
    expect(args).not.toContain("--env-file");
  });

  it("still passes non-secret env (provider, observation cap) via -e", () => {
    startHindsight("openai", "sk-not-relevant-here", {
      apiPort: 8888,
      uiPort: 9999,
    });

    const runCall = mockedExec.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "run",
    );
    const args = runCall![1] as string[];
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1]);
    }
    expect(envPairs.some((p) => p.startsWith("HINDSIGHT_API_LLM_PROVIDER=openai"))).toBe(true);
    expect(envPairs.some((p) => p.startsWith("HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE="))).toBe(true);

    // Capture for cleanup.
    const envFileIdx = args.indexOf("--env-file");
    if (envFileIdx >= 0) writtenPath = args[envFileIdx + 1];
  });

  it("writeHindsightLlmKeyFile refuses keys containing newlines", () => {
    expect(() => writeHindsightLlmKeyFile("sk-bad\nvalue")).toThrow(/newline/i);
  });

  it("writes the env-file under a tmpfs-backed dir", () => {
    const dir = pickHindsightSecretDir();
    // Must be one of the sanctioned tmpfs locations — never /tmp or $HOME.
    expect(
      dir === "/run/switchroom/hindsight" || dir === "/dev/shm/switchroom-hindsight",
    ).toBe(true);
  });

  it("stopHindsight unlinks the env-file (best-effort)", () => {
    // Seed: write a file via the helper.
    const path = writeHindsightLlmKeyFile("sk-cleanup-test-value");
    expect(existsSync(path)).toBe(true);

    stopHindsight();

    expect(existsSync(path)).toBe(false);
  });

  it("hindsightSecretEnvFilePath returns a stable path ending in llm-key.env", () => {
    const p = hindsightSecretEnvFilePath();
    expect(p.endsWith("/llm-key.env")).toBe(true);
  });
});
