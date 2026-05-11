import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUatEnv } from "./load-env.js";

describe("loadUatEnv", () => {
  let tmpDir: string;
  let envFile: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "uat-load-env-"));
    envFile = join(tmpDir, ".env");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
  });

  it("populates env vars from KEY=value lines", () => {
    writeFileSync(envFile, "UAT_TEST_FOO=bar\nUAT_TEST_BAZ=qux\n");
    loadUatEnv(envFile);
    expect(process.env.UAT_TEST_FOO).toBe("bar");
    expect(process.env.UAT_TEST_BAZ).toBe("qux");
  });

  it("does not overwrite values already set in process.env", () => {
    process.env.UAT_TEST_FOO = "from-shell";
    writeFileSync(envFile, "UAT_TEST_FOO=from-file\n");
    loadUatEnv(envFile);
    expect(process.env.UAT_TEST_FOO).toBe("from-shell");
  });

  it("strips surrounding single or double quotes", () => {
    writeFileSync(envFile, `UAT_TEST_DQ="quoted"\nUAT_TEST_SQ='quoted'\n`);
    loadUatEnv(envFile);
    expect(process.env.UAT_TEST_DQ).toBe("quoted");
    expect(process.env.UAT_TEST_SQ).toBe("quoted");
  });

  it("ignores blank lines and # comments", () => {
    writeFileSync(envFile, "# top comment\n\nUAT_TEST_FOO=bar\n# trailing\n");
    loadUatEnv(envFile);
    expect(process.env.UAT_TEST_FOO).toBe("bar");
  });

  it("is a no-op when the file does not exist", () => {
    const before = process.env.UAT_TEST_NONEXISTENT;
    loadUatEnv(join(tmpDir, "missing.env"));
    expect(process.env.UAT_TEST_NONEXISTENT).toBe(before);
  });

  it("handles values containing = signs (session strings)", () => {
    writeFileSync(envFile, "UAT_TEST_SESSION=abc=def=ghi\n");
    loadUatEnv(envFile);
    expect(process.env.UAT_TEST_SESSION).toBe("abc=def=ghi");
  });

  it("skips empty values so unpopulated .env.example copies stay unset", () => {
    writeFileSync(envFile, "UAT_TEST_EMPTY=\nUAT_TEST_QUOTED_EMPTY=\"\"\n");
    loadUatEnv(envFile);
    expect(process.env.UAT_TEST_EMPTY).toBeUndefined();
    expect(process.env.UAT_TEST_QUOTED_EMPTY).toBeUndefined();
  });
});
