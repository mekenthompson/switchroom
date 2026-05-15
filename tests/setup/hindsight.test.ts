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

  // Regression — without uid/gid on the tmpfs, the mount lands root-owned
  // and the entrypoint shim's `chmod 0700 /run/claude-creds` (running as
  // the image's pinned USER hindsight, UID 11000) fails EACCES → boot
  // exits non-zero → docker `--restart unless-stopped` crash-loops.
  it("tmpfs at /run/claude-creds carries uid + gid matching HINDSIGHT_DEFAULT_UID", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    let tmpfsArg: string | undefined;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "--tmpfs" && (args[i + 1] as string).startsWith("/run/claude-creds")) {
        tmpfsArg = args[i + 1] as string;
        break;
      }
    }
    expect(tmpfsArg).toBeDefined();
    expect(tmpfsArg).toMatch(/uid=11000\b/);
    expect(tmpfsArg).toMatch(/gid=11000\b/);
    // Sanity: the existing mode + rw flags survive the addition.
    expect(tmpfsArg).toMatch(/mode=0700\b/);
    expect(tmpfsArg).toMatch(/\brw\b/);
  });

  // Regression — the standalone `docker run` path mounts the broker
  // socket volume by name. The auth-broker compose declares the volume
  // with an explicit `name:` override (see compose-generator.test.ts
  // "auth-broker per-consumer volume naming"), so the actual docker
  // volume name has NO project prefix. setup.ts must reference that
  // unprefixed name; if it ever silently picks up the prefixed name, a
  // fresh empty volume gets created and the entrypoint times out on
  // the missing UDS.
  it("mounts the broker socket volume by the unprefixed canonical name", () => {
    startHindsight({ apiPort: 8888, uiPort: 9999 });
    const args = findRunArgs();
    let volArg: string | undefined;
    for (let i = 0; i < args.length - 1; i++) {
      if (args[i] === "-v" && (args[i + 1] as string).includes("/run/switchroom/auth-broker")) {
        volArg = args[i + 1] as string;
        break;
      }
    }
    expect(volArg).toBe("auth-broker-hindsight-sock:/run/switchroom/auth-broker");
    // Must NOT have the docker-compose project prefix.
    expect(volArg).not.toMatch(/^switchroom_/);
  });
});

// Regression — `checkHindsightConsumer` in src/cli/doctor.ts probes the
// host-side path of the named volume the broker chowns its consumer
// socket into. It MUST use the unprefixed name (`auth-broker-hindsight-
// sock`) because the compose generator overrides the project prefix on
// per-consumer volumes (see compose-generator.test.ts "auth-broker
// per-consumer volume naming"). Probing the prefixed path always
// reports `socket not yet bound on disk` even on a healthy install.
describe("checkHindsightConsumer — volume probe path (regression)", () => {
  it("probes the unprefixed `auth-broker-hindsight-sock` host path, not the project-prefixed one", async () => {
    const { checkHindsightConsumer } = await import("../../src/cli/doctor.js");
    const probedPaths: string[] = [];
    const result = checkHindsightConsumer(
      {
        auth: {
          consumers: [{ name: "hindsight", account: "k@example.com", uid: 11000 }],
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      {
        socketProbe: (p: string) => {
          probedPaths.push(p);
          return false;
        },
      },
    );
    expect(probedPaths.length).toBeGreaterThan(0);
    for (const p of probedPaths) {
      // Must contain the unprefixed name…
      expect(p).toContain("auth-broker-hindsight-sock");
      // …and must NOT contain the docker-compose project prefix
      // (otherwise the doctor false-warns on every healthy install
      // post-bug-5-fix).
      expect(p).not.toContain("switchroom_auth-broker-hindsight-sock");
    }
    // Probe missed → status warns; sanity check the result shape.
    expect(result.status).toBe("warn");
  });
});

// Regression — the compose snippet (used by operators who run hindsight
// in its OWN compose project rather than via `docker run`) had the same
// tmpfs ownership bug. Pin the tmpfs flag shape here so the two
// codepaths can't drift.
describe("generateHindsightComposeSnippet — tmpfs ownership", () => {
  it("emits uid + gid on the /run/claude-creds tmpfs entry", async () => {
    const { generateHindsightComposeSnippet } = await import("../../src/setup/hindsight.js");
    const snippet = generateHindsightComposeSnippet();
    // Find the tmpfs block — it's a `- /run/claude-creds:rw,...` line.
    const tmpfsLine = snippet
      .split("\n")
      .find((l) => l.includes("/run/claude-creds:rw"));
    expect(tmpfsLine).toBeDefined();
    expect(tmpfsLine).toMatch(/uid=11000\b/);
    expect(tmpfsLine).toMatch(/gid=11000\b/);
    expect(tmpfsLine).toMatch(/mode=0700\b/);
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
