import { describe, it, expect } from "vitest";
import { detectHindsightEnvLeak } from "../src/cli/doctor.js";

describe("detectHindsightEnvLeak (#1068)", () => {
  it("flags HINDSIGHT_API_LLM_API_KEY=<anything> as leaked", () => {
    const json = JSON.stringify([
      "PATH=/usr/local/sbin:/usr/local/bin",
      "HINDSIGHT_API_LLM_API_KEY=sk-leaked-value-12345",
      "HINDSIGHT_API_LLM_PROVIDER=openai",
    ]);
    const result = detectHindsightEnvLeak(json);
    expect(result.leaked).toBe(true);
    if (result.leaked) {
      expect(result.leakedKeys).toContain("HINDSIGHT_API_LLM_API_KEY");
    }
  });

  it("flags any *KEY*=sk-... env var (OpenAI / Anthropic shape)", () => {
    const json = JSON.stringify([
      "PATH=/usr/local/bin",
      "MY_API_KEY=sk-abcdefghij1234567890",
    ]);
    const result = detectHindsightEnvLeak(json);
    expect(result.leaked).toBe(true);
    if (result.leaked) expect(result.leakedKeys).toContain("MY_API_KEY");
  });

  it("flags *KEY*=AKIA... env var (AWS access key shape)", () => {
    const json = JSON.stringify([
      "AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE",
    ]);
    const result = detectHindsightEnvLeak(json);
    expect(result.leaked).toBe(true);
  });

  it("flags *TOKEN*= with 20+ base64-ish chars", () => {
    const json = JSON.stringify([
      "GITHUB_TOKEN=ghp_AbCdEf0123456789AbCdEf0123456789",
    ]);
    const result = detectHindsightEnvLeak(json);
    expect(result.leaked).toBe(true);
  });

  it("flags generic SECRET= with long base64-ish value", () => {
    const json = JSON.stringify([
      "MY_SECRET=Zm9vYmFyYmF6cXV1eGZyb2J6b2dvbA==",
    ]);
    const result = detectHindsightEnvLeak(json);
    expect(result.leaked).toBe(true);
  });

  it("does NOT flag clean env (non-secret names + harmless values)", () => {
    const json = JSON.stringify([
      "PATH=/usr/local/sbin:/usr/local/bin",
      "HOME=/home/hindsight",
      "HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=1000",
      "HINDSIGHT_API_LLM_PROVIDER=openai",
      "LANG=C.UTF-8",
    ]);
    const result = detectHindsightEnvLeak(json);
    expect(result.leaked).toBe(false);
  });

  it("does NOT flag short values on secret-named vars (false-positive guard)", () => {
    const json = JSON.stringify([
      "FOO_KEY=short",
      "BAR_TOKEN=abc",
    ]);
    const result = detectHindsightEnvLeak(json);
    expect(result.leaked).toBe(false);
  });

  it("does NOT flag non-secret-named vars even with long values", () => {
    const json = JSON.stringify([
      "REQUEST_ID=abcdefghijklmnopqrstuvwxyz0123456789",
      "USER_AGENT=Mozilla/5.0-with-a-very-long-string-no-problem",
    ]);
    const result = detectHindsightEnvLeak(json);
    expect(result.leaked).toBe(false);
  });

  it("returns leaked=false on malformed inspect JSON", () => {
    expect(detectHindsightEnvLeak("not json").leaked).toBe(false);
    expect(detectHindsightEnvLeak("").leaked).toBe(false);
    expect(detectHindsightEnvLeak("{}").leaked).toBe(false);
  });

  it("handles empty env array", () => {
    expect(detectHindsightEnvLeak("[]").leaked).toBe(false);
  });

  it("post-fix container (env-file routed) reads as clean", () => {
    // After the #1068 fix, the API key is in the container's env (set by
    // --env-file at start time) but NOT in `.Config.Env`. Docker only
    // echoes `-e` and Dockerfile-baked vars into .Config.Env. So the
    // inspect output looks like:
    const json = JSON.stringify([
      "PATH=/usr/local/sbin:/usr/local/bin",
      "HINDSIGHT_API_MAX_OBSERVATIONS_PER_SCOPE=1000",
      "HINDSIGHT_API_LLM_PROVIDER=openai",
      // No HINDSIGHT_API_LLM_API_KEY here — that's the whole point.
    ]);
    const result = detectHindsightEnvLeak(json);
    expect(result.leaked).toBe(false);
  });
});
