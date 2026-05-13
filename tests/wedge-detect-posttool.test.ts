import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Unit tests for telegram-plugin/hooks/wedge-detect-posttool.mjs.
 *
 * Hook contract:
 *   stdin:  PostToolUse JSON event { tool_name, tool_response, ... }
 *   stdout: optional JSON
 *             {"hookSpecificOutput":{"hookEventName":"PostToolUse",
 *              "additionalContext":"..."}}
 *           emitted only when the consecutive-empty-Bash counter
 *           crosses THRESHOLD (=3).
 *   exit:   0 always.
 *
 * State files in $TELEGRAM_STATE_DIR:
 *   wedge-counter.txt   — integer, consecutive empty Bash results.
 *   wedge-detected.json — sentinel written when counter >= THRESHOLD.
 */

const HOOK = resolve(
  __dirname,
  "..",
  "telegram-plugin",
  "hooks",
  "wedge-detect-posttool.mjs",
);

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  counter: number;
  sentinel: Record<string, unknown> | null;
}

function run(
  payload: Record<string, unknown> | string | null,
  stateDir: string | null,
  agentName = "test-agent",
): RunResult {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  if (stateDir) env.TELEGRAM_STATE_DIR = stateDir;
  else delete env.TELEGRAM_STATE_DIR;
  env.SWITCHROOM_AGENT_NAME = agentName;

  const stdin =
    payload === null ? "" : typeof payload === "string" ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env,
    encoding: "utf8",
  });

  let counter = 0;
  let sentinel: Record<string, unknown> | null = null;
  if (stateDir) {
    const cp = join(stateDir, "wedge-counter.txt");
    if (existsSync(cp)) counter = Number.parseInt(readFileSync(cp, "utf8").trim(), 10) || 0;
    const sp = join(stateDir, "wedge-detected.json");
    if (existsSync(sp)) sentinel = JSON.parse(readFileSync(sp, "utf8")) as Record<string, unknown>;
  }

  return {
    status: r.status ?? 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    counter,
    sentinel,
  };
}

function bashEvent(toolResponse: unknown): Record<string, unknown> {
  return {
    session_id: "sess-test",
    tool_use_id: `toolu_${Math.random().toString(36).slice(2, 8)}`,
    tool_name: "Bash",
    tool_input: { command: "true" },
    tool_response: toolResponse,
  };
}

describe("wedge-detect-posttool.mjs", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "wedge-detect-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("always exits 0 — even on bad input", () => {
    for (const bad of [null, "", "not-json", "{}"]) {
      const r = run(bad, stateDir);
      expect(r.status).toBe(0);
    }
  });

  it("non-Bash event resets the counter and is silent", () => {
    // Pre-seed counter as if a wedge was in progress.
    const r1 = run(bashEvent({ stdout: "", stderr: "" }), stateDir);
    expect(r1.counter).toBe(1);

    // Read event (not Bash) → counter reset to 0.
    const r2 = run(
      { session_id: "sess-test", tool_use_id: "t-r", tool_name: "Read", tool_response: "ok" },
      stateDir,
    );
    expect(r2.counter).toBe(0);
    expect(r2.stdout).toBe("");
    expect(r2.sentinel).toBeNull();
  });

  it("non-empty Bash result resets the counter", () => {
    const r1 = run(bashEvent({ stdout: "", stderr: "" }), stateDir);
    expect(r1.counter).toBe(1);

    const r2 = run(bashEvent({ stdout: "hello\n", stderr: "" }), stateDir);
    expect(r2.counter).toBe(0);
    expect(r2.sentinel).toBeNull();
  });

  it("counts consecutive empty Bash results with JSON-style response shape", () => {
    const r1 = run(bashEvent({ stdout: "", stderr: "" }), stateDir);
    expect(r1.counter).toBe(1);
    expect(r1.sentinel).toBeNull();

    const r2 = run(bashEvent({ stdout: "", stderr: "" }), stateDir);
    expect(r2.counter).toBe(2);
    expect(r2.sentinel).toBeNull();

    const r3 = run(bashEvent({ stdout: "", stderr: "" }), stateDir);
    expect(r3.counter).toBe(3);
    expect(r3.sentinel).not.toBeNull();
    expect(r3.sentinel?.consecutive).toBe(3);
    expect(r3.sentinel?.agent).toBe("test-agent");
    expect(r3.sentinel?.session_id).toBe("sess-test");
  });

  it("detects XML-tag style empty Bash response", () => {
    const response = "<bash-stdout></bash-stdout><bash-stderr></bash-stderr>";
    for (let i = 0; i < 3; i++) {
      const r = run(bashEvent(response), stateDir);
      expect(r.counter).toBe(i + 1);
    }
    expect(existsSync(join(stateDir, "wedge-detected.json"))).toBe(true);
  });

  it("at threshold, emits additionalContext nudge to stdout", () => {
    run(bashEvent({ stdout: "", stderr: "" }), stateDir);
    run(bashEvent({ stdout: "", stderr: "" }), stateDir);
    const r3 = run(bashEvent({ stdout: "", stderr: "" }), stateDir);

    expect(r3.stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(r3.stdout.trim()) as Record<string, unknown>;
    const hsOutput = parsed.hookSpecificOutput as Record<string, unknown>;
    expect(hsOutput.hookEventName).toBe("PostToolUse");
    const ctx = hsOutput.additionalContext as string;
    expect(ctx).toContain("wedge-detect");
    expect(ctx).toContain("KillBash");
    expect(ctx).toContain("switchroom agent restart");
  });

  it("at threshold, logs to stderr for docker logs visibility", () => {
    run(bashEvent({ stdout: "", stderr: "" }), stateDir);
    run(bashEvent({ stdout: "", stderr: "" }), stateDir);
    const r3 = run(bashEvent({ stdout: "", stderr: "" }), stateDir);
    expect(r3.stderr).toContain("wedge-detect");
    expect(r3.stderr).toContain("consecutive empty-result Bash calls");
  });

  it("missing TELEGRAM_STATE_DIR — silent no-op (no crash)", () => {
    const r = run(bashEvent({ stdout: "", stderr: "" }), null);
    expect(r.status).toBe(0);
  });

  it("a long real Bash output (>4KB) is treated as non-empty, resets counter", () => {
    run(bashEvent({ stdout: "", stderr: "" }), stateDir);
    const bigResponse = { stdout: "x".repeat(5000), stderr: "" };
    const r = run(bashEvent(bigResponse), stateDir);
    expect(r.counter).toBe(0);
  });

  it("response is the literal string '{}' (zero-info) — counted as empty", () => {
    const r = run(
      {
        session_id: "sess-test",
        tool_use_id: "t1",
        tool_name: "Bash",
        tool_response: "{}",
      },
      stateDir,
    );
    expect(r.counter).toBe(1);
  });
});
