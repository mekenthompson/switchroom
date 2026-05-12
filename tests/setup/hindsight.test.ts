import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

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
  hindsightSecretFilePath,
  pickHindsightSecretDir,
  HINDSIGHT_SECRET_CONTAINER_PATH,
} from "../../src/setup/hindsight.js";

const mockedExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

function findRunArgs(): string[] {
  const runCall = mockedExec.mock.calls.find(
    (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "run",
  );
  expect(runCall).toBeDefined();
  return runCall![1] as string[];
}

describe("hindsight secret routing (#1068)", () => {
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

    const args = findRunArgs();
    const joined = args.join(" ");
    expect(joined).not.toContain("sk-test-secret-value-do-not-leak");

    // Inspect every -e value: none may be HINDSIGHT_API_LLM_API_KEY.
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") {
        expect(args[i + 1]).not.toMatch(/^HINDSIGHT_API_LLM_API_KEY=/);
      }
    }
  });

  it("does NOT pass --env-file (rejected approach — env-file leaks too)", () => {
    startHindsight("openai", "sk-do-not-use-env-file", {
      apiPort: 8888,
      uiPort: 9999,
    });
    const args = findRunArgs();
    // --env-file populates .Config.Env identically to -e on Docker 29+,
    // so the fix must NOT use it for secrets. Asserted explicitly so a
    // regression to the v1 approach is loud.
    expect(args).not.toContain("--env-file");

    // Capture the bind-mount path for cleanup.
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-v" && (args[i + 1] as string).includes("/llm-key:")) {
        writtenPath = (args[i + 1] as string).split(":")[0];
      }
    }
  });

  it("bind-mounts the secret file read-only into the container", () => {
    startHindsight("openai", "sk-bind-mount-test", { apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();

    // Look for the -v entry pointing at the in-container secret path.
    const mountIdx = args.findIndex(
      (a, i) =>
        a === "-v" &&
        typeof args[i + 1] === "string" &&
        (args[i + 1] as string).includes(`:${HINDSIGHT_SECRET_CONTAINER_PATH}:ro`),
    );
    expect(mountIdx).toBeGreaterThanOrEqual(0);

    const mountSpec = args[mountIdx + 1];
    const [hostPath, containerPath, mode] = mountSpec.split(":");
    expect(containerPath).toBe(HINDSIGHT_SECRET_CONTAINER_PATH);
    expect(mode).toBe("ro");
    writtenPath = hostPath;

    // Host file exists with bare-value contents. Mode is 0644 (not 0600)
    // so the non-root `hindsight` user inside the container can read it
    // even when host UID != container UID; the 0700 parent dir is the
    // real access control. See writeHindsightLlmKeyFile() jsdoc.
    expect(existsSync(hostPath)).toBe(true);
    const fileMode = statSync(hostPath).mode & 0o777;
    expect(fileMode).toBe(0o644);
    const content = readFileSync(hostPath, "utf-8");
    expect(content).toBe("sk-bind-mount-test");
  });

  it("overrides entrypoint with sh + shim that exports key from the bind-mounted file", () => {
    startHindsight("openai", "sk-shim-test", { apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();

    // --entrypoint sh comes BEFORE the image; -c '<shim>' comes AFTER.
    const entrypointIdx = args.indexOf("--entrypoint");
    expect(entrypointIdx).toBeGreaterThanOrEqual(0);
    expect(args[entrypointIdx + 1]).toBe("sh");

    // Find the image arg, then assert the following -c shim.
    const imageIdx = args.findIndex((a) =>
      typeof a === "string" && a.startsWith("ghcr.io/vectorize-io/hindsight"),
    );
    expect(imageIdx).toBeGreaterThanOrEqual(0);
    expect(args[imageIdx + 1]).toBe("-c");
    const shim = args[imageIdx + 2];
    expect(shim).toContain(`cat ${HINDSIGHT_SECRET_CONTAINER_PATH}`);
    expect(shim).toContain("export HINDSIGHT_API_LLM_API_KEY");
    expect(shim).toContain("exec /app/start-all.sh");
    // The shim must NOT contain the literal key value.
    expect(shim).not.toContain("sk-shim-test");
    // Fail-loud guards: explicit `|| exit 1` after the `$()` assignment
    // (POSIX `set -e` doesn't propagate from $() inside an assignment),
    // and an empty-value check so we never boot Hindsight with KEY="".
    expect(shim).toMatch(/\|\| exit 1/);
    expect(shim).toContain('[ -n "$key" ]');

    // Capture for cleanup.
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-v" && (args[i + 1] as string).includes("/llm-key:")) {
        writtenPath = (args[i + 1] as string).split(":")[0];
      }
    }
  });

  it("does NOT bind-mount or override entrypoint when apiKey is undefined", () => {
    startHindsight("ollama", undefined, { apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).not.toContain("--entrypoint");
    expect(args).not.toContain("--env-file");
    // No -v entry should target the secret container path.
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-v") {
        expect(args[i + 1]).not.toContain(HINDSIGHT_SECRET_CONTAINER_PATH);
      }
    }
  });

  it("still passes non-secret env (provider, observation cap) via -e", () => {
    startHindsight("openai", "sk-not-relevant-here", {
      apiPort: 8888,
      uiPort: 9999,
    });
    const args = findRunArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1]);
    }
    expect(envPairs.some((p) => p.startsWith("HINDSIGHT_API_LLM_PROVIDER=openai"))).toBe(true);
    expect(envPairs.some((p) => p.startsWith("HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE="))).toBe(true);

    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-v" && (args[i + 1] as string).includes("/llm-key:")) {
        writtenPath = (args[i + 1] as string).split(":")[0];
      }
    }
  });

  it("writeHindsightLlmKeyFile refuses keys containing newlines", () => {
    expect(() => writeHindsightLlmKeyFile("sk-bad\nvalue")).toThrow(/newline/i);
  });

  it("writes the secret file under a tmpfs-backed dir", () => {
    const dir = pickHindsightSecretDir();
    expect(
      dir === "/run/switchroom/hindsight" || dir === "/dev/shm/switchroom-hindsight",
    ).toBe(true);
  });

  it("hindsightSecretFilePath returns a stable path ending in llm-key", () => {
    const p = hindsightSecretFilePath();
    expect(p.endsWith("/llm-key")).toBe(true);
  });

  it("stopHindsight unlinks the host secret file (best-effort)", () => {
    const path = writeHindsightLlmKeyFile("sk-cleanup-test-value");
    expect(existsSync(path)).toBe(true);
    stopHindsight();
    expect(existsSync(path)).toBe(false);
  });

  it("stopHindsight also cleans up the legacy llm-key.env path (pre-pivot)", () => {
    // Simulate a host that has the old envfile layout sitting around.
    const dir = pickHindsightSecretDir();
    const legacyPath = `${dir}/llm-key.env`;
    writeFileSync(legacyPath, "HINDSIGHT_API_LLM_API_KEY=stale\n", { mode: 0o600 });
    expect(existsSync(legacyPath)).toBe(true);

    stopHindsight();

    expect(existsSync(legacyPath)).toBe(false);
  });
});
