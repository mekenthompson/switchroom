import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
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
  ensureHindsightConsumer,
  HINDSIGHT_CONSUMER_NAME,
  HINDSIGHT_DEFAULT_UID,
  HINDSIGHT_BROKER_SOCK_VOLUME,
  HINDSIGHT_IMAGE,
} from "../../src/setup/hindsight.js";

const mockedExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

function findRunArgs(): string[] {
  const runCall = mockedExec.mock.calls.find(
    (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === "run",
  );
  expect(runCall).toBeDefined();
  return runCall![1] as string[];
}

describe("hindsight broker-fed mode (#1245)", () => {
  beforeEach(() => {
    mockedExec.mockReset();
    mockedExec.mockReturnValue("");
  });

  it("does NOT pass any LLM API key via -e or --env-file", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).not.toContain("--env-file");

    // No -e value should look like an API-key var.
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") {
        const val = args[i + 1] as string;
        expect(val).not.toMatch(/^HINDSIGHT_API_LLM_API_KEY=/);
        expect(val).not.toMatch(/^OPENAI_API_KEY=/);
        expect(val).not.toMatch(/^ANTHROPIC_API_KEY=/);
      }
    }
  });

  it("does NOT pass an entrypoint shim (broker-fed mode uses the image's ENTRYPOINT)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).not.toContain("--entrypoint");
  });

  it("bind-mounts the auth-broker consumer socket volume", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    // Look for `-v auth-broker-hindsight-sock:/run/switchroom/auth-broker`.
    let found = false;
    for (let i = 0; i < args.length - 1; i++) {
      if (
        args[i] === "-v" &&
        args[i + 1] === `${HINDSIGHT_BROKER_SOCK_VOLUME}:/run/switchroom/auth-broker`
      ) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("sets up a tmpfs at /run/claude-creds for the credential dotfile", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    let found = false;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--tmpfs" && (args[i + 1] as string).startsWith("/run/claude-creds")) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("sets HINDSIGHT_API_LLM_PROVIDER=claude-code (subscription-honest path)", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1] as string);
    }
    expect(envPairs).toContain("HINDSIGHT_API_LLM_PROVIDER=claude-code");
  });

  it("pins HINDSIGHT_API_LLM_MODEL to the switchroom default sonnet", () => {
    // Without this override the upstream hindsight image silently picks
    // its own default (an older date-pinned sonnet from
    // PROVIDER_DEFAULT_MODELS in /app/api/hindsight_api/config.py) and
    // drifts behind the rest of the fleet on every upstream pull.
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1] as string);
    }
    expect(envPairs).toContain("HINDSIGHT_API_LLM_MODEL=claude-sonnet-4-6");
  });

  it("enables stateless MCP (HINDSIGHT_API_MCP_STATELESS=true) so a hindsight bounce doesn't strand agent-side MCP sessions", () => {
    // Stateful MCP makes the server assign an Mcp-Session-Id on
    // initialize that the client must echo on every subsequent call.
    // When hindsight restarts, its in-memory session table is wiped
    // but every agent's claude MCP client keeps caching the now-stale
    // id — retain fails with "Session not found" until each agent is
    // also restarted. Stateless mode makes every request self-contained.
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    const envPairs: string[] = [];
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-e") envPairs.push(args[i + 1] as string);
    }
    expect(envPairs).toContain("HINDSIGHT_API_MCP_STATELESS=true");
  });

  it("uses the switchroom-hindsight image, not upstream", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    expect(args).toContain(HINDSIGHT_IMAGE);
    // Upstream image MUST NOT be used — that one is missing
    // claude-agent-sdk + the claude CLI.
    expect(args).not.toContain("ghcr.io/vectorize-io/hindsight:latest");
  });
});

describe("ensureHindsightConsumer (#1245)", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "switchroom-setup-test-"));
    configPath = join(dir, "switchroom.yaml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds an `auth.consumers[hindsight]` entry pinned to the active account", async () => {
    writeFileSync(
      configPath,
      [
        "telegram: {}",
        "agents: {}",
        "auth:",
        "  active: me@example.com",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await ensureHindsightConsumer(configPath, "me@example.com");
    expect(result.added).toBe(true);
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).toMatch(/consumers:/);
    expect(raw).toMatch(/name: hindsight/);
    expect(raw).toMatch(/account: me@example\.com/);
    expect(raw).toMatch(new RegExp(`uid: ${HINDSIGHT_DEFAULT_UID}`));
    expect(result.reason).toBe("added");
  });

  it("is idempotent when an entry named `hindsight` already exists", async () => {
    writeFileSync(
      configPath,
      [
        "auth:",
        "  active: me@example.com",
        "  consumers:",
        "    - name: hindsight",
        "      account: prior@example.com",
        "      uid: 12345",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await ensureHindsightConsumer(configPath, "me@example.com");
    expect(result.added).toBe(false);
    const raw = readFileSync(configPath, "utf-8");
    // Prior entry untouched (account stays at prior@, uid stays at 12345).
    expect(raw).toMatch(/account: prior@example\.com/);
    expect(raw).toMatch(/uid: 12345/);
    expect(raw).not.toMatch(/account: me@example\.com/);
  });

  it("creates the `auth.consumers` array when missing", async () => {
    writeFileSync(
      configPath,
      [
        "auth:",
        "  active: me@example.com",
        "",
      ].join("\n"),
      "utf-8",
    );
    const result = await ensureHindsightConsumer(configPath, "me@example.com");
    expect(result.added).toBe(true);
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).toMatch(/consumers:\s*\n\s+- name: hindsight/);
  });

  it("creates the entire `auth:` block when missing", async () => {
    writeFileSync(configPath, "telegram: {}\nagents: {}\n", "utf-8");
    const result = await ensureHindsightConsumer(configPath, "me@example.com");
    expect(result.added).toBe(true);
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).toMatch(/auth:/);
    expect(raw).toMatch(/name: hindsight/);
  });

  it("does NOT write any OpenAI key or HINDSIGHT_API_LLM_API_KEY to the yaml", async () => {
    writeFileSync(configPath, "auth:\n  active: me@example.com\n", "utf-8");
    await ensureHindsightConsumer(configPath, "me@example.com");
    const raw = readFileSync(configPath, "utf-8");
    expect(raw).not.toMatch(/openai/i);
    expect(raw).not.toMatch(/api_key/i);
    expect(raw).not.toMatch(/HINDSIGHT_API_LLM_API_KEY/);
  });

  it("uses the canonical consumer slug", () => {
    expect(HINDSIGHT_CONSUMER_NAME).toBe("hindsight");
  });
});
