import { describe, it, expect } from "vitest";

import { redact, REDACTED_MARKER } from "./redact.js";

// Fixtures are assembled at runtime so the source file never contains a
// contiguous token pattern that would trip GitHub Push Protection or
// secretlint's own static scan. See CLAUDE.md "Secrets in tests".
const GITHUB_PAT = "ghp" + "_" + "16C7e42F292c6912E7710c838347Ae178B4a";
const SLACK_BOT = ["xoxb", "0000000000", "0000000000000", "FIXTURE0NOTAREALTOKEN000"].join("-");
const ANTHROPIC_KEY = "sk-ant-" + "FAKEa01234567890ABCDEFGHIJKLMNOPQRST" + "uvwxyz0123";

describe("redact()", () => {
  it("returns the input unchanged when it contains no secrets or URL credentials", () => {
    const input = "regular log line with nothing sensitive in it at all";
    expect(redact(input)).toBe(input);
  });

  it("returns the empty string unchanged", () => {
    expect(redact("")).toBe("");
  });

  it("redacts a GitHub PAT in a bash error message", () => {
    const input = `fatal: unable to access: 401 (token=${GITHUB_PAT})`;
    const out = redact(input);
    expect(out).not.toContain(GITHUB_PAT);
    expect(out).toContain("[REDACTED");
  });

  it("redacts an Anthropic API key echoed in a 401 response", () => {
    const input = `HTTP 401 — invalid key: ${ANTHROPIC_KEY}`;
    const out = redact(input);
    expect(out).not.toContain(ANTHROPIC_KEY);
    expect(out).toContain("[REDACTED");
  });

  it("redacts URL embedded credentials (username:password@)", () => {
    const input = "git clone https://alice:hunter2@example.com/repo.git failed";
    const out = redact(input);
    expect(out).not.toContain("alice:hunter2");
    expect(out).toContain("***@example.com");
  });

  it("redacts sensitive URL query params", () => {
    const input = "GET https://api.example.com/x?api_key=abc12345&trace=42 -> 401";
    const out = redact(input);
    expect(out).not.toContain("api_key=abc12345");
    expect(out).toMatch(/api_key=\*\*\*/);
    // Non-sensitive params left alone.
    expect(out).toContain("trace=42");
  });

  it("redacts a Slack bot token", () => {
    const input = `webhook failed: token=${SLACK_BOT}`;
    const out = redact(input);
    expect(out).not.toContain(SLACK_BOT);
    expect(out).toContain("[REDACTED");
  });

  it("handles multiline stderr blobs and redacts every hit", () => {
    const input = [
      "Traceback (most recent call last):",
      `  File "recall.py", line 47, in fetch`,
      `    return requests.get(url, headers={"Authorization": "Bearer ${GITHUB_PAT}"})`,
      `requests.HTTPError: 401 Unauthorized: ${ANTHROPIC_KEY}`,
    ].join("\n");
    const out = redact(input);
    expect(out).not.toContain(GITHUB_PAT);
    expect(out).not.toContain(ANTHROPIC_KEY);
    // Structural content preserved.
    expect(out).toContain("Traceback");
    expect(out).toContain("recall.py");
  });

  it("is idempotent on Bearer-style detections (whole-span replacement)", () => {
    const input = `Authorization: Bearer ${GITHUB_PAT} leaked here`;
    const once = redact(input);
    const twice = redact(once);
    expect(twice).toBe(once);
  });

  // The structural detectors (cli_flag, json_secret_field) leave the
  // *key* in place and only redact the value. On a second pass the
  // marker itself can match the value class — bytes stay redacted but
  // the tag rewrites (e.g. `[REDACTED:openai_api_key]` →
  // `[REDACTED:cli_flag]`). The load-bearing property is "no
  // secret bytes survive ANY number of passes", not byte-identical
  // idempotence. These tests pin that property.
  it("never leaks token bytes across two redact passes (--api-key style)", () => {
    const input = `command failed: server --api-key ${GITHUB_PAT}`;
    const once = redact(input);
    const twice = redact(once);
    expect(once).not.toContain(GITHUB_PAT);
    expect(twice).not.toContain(GITHUB_PAT);
    // Marker still flags that something was scrubbed.
    expect(twice).toContain("[REDACTED");
  });

  it("never leaks token bytes across two redact passes (password=)", () => {
    const input = `DB_PASSWORD=${GITHUB_PAT} in env dump`;
    const once = redact(input);
    const twice = redact(once);
    expect(once).not.toContain(GITHUB_PAT);
    expect(twice).not.toContain(GITHUB_PAT);
  });

  it("never leaks token bytes across two redact passes (JSON field)", () => {
    const input = `response body: {"api_key":"${GITHUB_PAT}","other":1}`;
    const once = redact(input);
    const twice = redact(once);
    expect(once).not.toContain(GITHUB_PAT);
    expect(twice).not.toContain(GITHUB_PAT);
  });

  it("exports the canonical REDACTED_MARKER", () => {
    // Marker should be obvious to operators reading a chat surface.
    expect(REDACTED_MARKER).toBe("[REDACTED]");
  });

  it("emits a tagged marker that identifies the rule but never leaks bytes", () => {
    const input = `key=${GITHUB_PAT}`;
    const out = redact(input);
    // We expect something like `[REDACTED:github_pat_classic]` or
    // similar — the exact rule_id is detector-internal but the prefix
    // is stable.
    expect(out).toMatch(/\[REDACTED(?::[a-z0-9_]+)?\]/);
  });
});
