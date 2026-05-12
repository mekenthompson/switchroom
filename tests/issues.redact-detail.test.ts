import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * SECURITY (#1069) — verify that hook stderr containing a secret is
 * redacted before it lands in issues.jsonl (and from there into the
 * Telegram issues-card / `/issues` list).
 *
 * Two layers are tested:
 *   1. `switchroom issues record --detail-stdin` redacts on the
 *      receiving side (defense-in-depth backstop in
 *      src/issues/store.ts:capDetail).
 *   2. `bin/run-hook.sh` (driving a forced-failing hook with a
 *      token-bearing stderr) ends up with redacted detail in the
 *      store. The shell wrapper is the actual real-world callsite.
 *
 * Fixture tokens are concatenated at runtime so the source file
 * never contains a contiguous token pattern. See CLAUDE.md "Secrets
 * in tests".
 */

const CLI = resolve(__dirname, "..", "dist", "cli", "switchroom.js");
const RUN_HOOK = resolve(__dirname, "..", "bin", "run-hook.sh");
const BUN = process.env.BUN_PATH ?? "bun";

const GITHUB_PAT = "ghp" + "_" + "16C7e42F292c6912E7710c838347Ae178B4a";
const ANTHROPIC_KEY = "sk-ant-" + "FAKEa01234567890ABCDEFGHIJKLMNOPQRST" + "uvwxyz0123";

let stateDir: string;
let scriptDir: string;
let cliShimPath: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "issues-redact-"));
  scriptDir = mkdtempSync(join(tmpdir(), "issues-redact-scripts-"));
  cliShimPath = join(scriptDir, "switchroom-shim.sh");
  writeFileSync(
    cliShimPath,
    `#!/usr/bin/env bash\nexec ${BUN} ${CLI} "$@"\n`,
  );
  chmodSync(cliShimPath, 0o755);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(scriptDir, { recursive: true, force: true });
});

function listIssues(): Array<{
  detail?: string;
  summary: string;
  source: string;
  code: string;
}> {
  const out = execFileSync(
    BUN,
    [CLI, "issues", "list", "--include-resolved", "--json", "--state-dir", stateDir],
    { encoding: "utf-8" },
  );
  return JSON.parse(out);
}

describe("issues record — server-side detail redaction (#1069)", () => {
  it("redacts a GitHub PAT in --detail before persisting to issues.jsonl", () => {
    const detail = [
      "fatal: 401 Unauthorized",
      `Authorization: Bearer ${GITHUB_PAT}`,
      "abort: refusing to push",
    ].join("\n");
    execFileSync(
      BUN,
      [
        CLI,
        "issues",
        "record",
        "--severity", "error",
        "--source", "hook:gitpush",
        "--code", "push.sh",
        "--summary", "git push failed",
        "--detail", detail,
        "--agent", "test-agent",
        "--state-dir", stateDir,
      ],
      { encoding: "utf-8" },
    );

    const raw = readFileSync(join(stateDir, "issues.jsonl"), "utf-8");
    // Absence — the raw token must not be on disk anywhere.
    expect(raw).not.toContain(GITHUB_PAT);
    // Presence — the redaction marker must be visible so operators
    // know something was scrubbed (not silently dropped).
    expect(raw).toContain("[REDACTED");
    // Structure preserved.
    expect(raw).toContain("Authorization");
    expect(raw).toContain("fatal: 401");
  });

  it("redacts a secret read from --detail-stdin", () => {
    const detail = `traceback: invalid key ${ANTHROPIC_KEY}\n`;
    execFileSync(
      BUN,
      [
        CLI,
        "issues",
        "record",
        "--severity", "error",
        "--source", "hook:recall",
        "--code", "recall.py",
        "--summary", "recall failed",
        "--detail-stdin",
        "--agent", "test-agent",
        "--state-dir", stateDir,
      ],
      { encoding: "utf-8", input: detail },
    );

    const raw = readFileSync(join(stateDir, "issues.jsonl"), "utf-8");
    expect(raw).not.toContain(ANTHROPIC_KEY);
    expect(raw).toContain("[REDACTED");

    const events = listIssues();
    expect(events).toHaveLength(1);
    expect(events[0].detail ?? "").not.toContain(ANTHROPIC_KEY);
  });

  it("scrubs URL credentials too (no contiguous token, but a leaked password)", () => {
    const detail = "git clone https://alice:hunter2@example.com/r.git failed";
    execFileSync(
      BUN,
      [
        CLI,
        "issues",
        "record",
        "--severity", "error",
        "--source", "hook:clone",
        "--code", "clone.sh",
        "--summary", "clone failed",
        "--detail", detail,
        "--agent", "test-agent",
        "--state-dir", stateDir,
      ],
      { encoding: "utf-8" },
    );

    const raw = readFileSync(join(stateDir, "issues.jsonl"), "utf-8");
    expect(raw).not.toContain("hunter2");
    expect(raw).toContain("***@example.com");
  });
});

describe("bin/run-hook.sh — end-to-end secret redaction (#1069)", () => {
  it("redacts a token printed to stderr by a failing hook before issues.jsonl is written", () => {
    const scriptPath = join(scriptDir, "leaky-hook.sh");
    writeFileSync(
      scriptPath,
      `#!/usr/bin/env bash\n` +
        `echo "request failed (401)" >&2\n` +
        `echo "Authorization: Bearer ${GITHUB_PAT}" >&2\n` +
        `exit 1\n`,
    );
    chmodSync(scriptPath, 0o755);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({
      ...process.env,
      SWITCHROOM_CLI_PATH: cliShimPath,
      TELEGRAM_STATE_DIR: stateDir,
      SWITCHROOM_AGENT_NAME: "test-agent",
    })) {
      if (v !== undefined && v !== null) env[k] = String(v);
    }
    const r = spawnSync(
      "bash",
      [RUN_HOOK, "hook:leaky", scriptPath],
      { env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" },
    );
    expect(r.status).toBe(1);

    const raw = readFileSync(join(stateDir, "issues.jsonl"), "utf-8");
    // The crown-jewel assertion: the token never makes it to disk.
    expect(raw).not.toContain(GITHUB_PAT);
    // And we can see the redaction marker.
    expect(raw).toContain("[REDACTED");
    // Structural content from the original stderr survives so the
    // operator still gets diagnostic value.
    expect(raw).toContain("request failed (401)");
  });
});
