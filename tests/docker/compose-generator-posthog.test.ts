/**
 * compose-generator-posthog.test.ts
 *
 * Verifies that the compose generator wires through PostHog runtime
 * telemetry env vars per the new analytics-runtime PR (#1122 PR1):
 *   - SWITCHROOM_ANALYTICS_ID emitted iff ~/.switchroom/analytics-id
 *     exists on the host
 *   - SWITCHROOM_TELEMETRY_DISABLED propagated from the operator's
 *     shell (only when truthy)
 *   - SWITCHROOM_POSTHOG_KEY / SWITCHROOM_POSTHOG_HOST overrides
 *     propagated when present
 *
 * Pure compose-string assertions — no docker invocation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCompose } from "../../src/agents/compose.js";
import type { SwitchroomConfig } from "../../src/config/schema.js";

function makeConfig(): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: { bot_token: "x" },
    defaults: undefined,
    profiles: undefined,
    agents: {
      coach: {
        extends: undefined,
        settings_raw: undefined,
        admin: undefined,
        env: undefined,
        schedule: [],
        tools: { allow: [], deny: [] },
        hooks: undefined,
        channels: undefined,
      } as unknown as SwitchroomConfig["agents"][string],
    },
    drive: undefined as unknown as SwitchroomConfig["drive"],
  } as unknown as SwitchroomConfig;
}

let tmpHome: string;
const ENV_KEYS = [
  "SWITCHROOM_TELEMETRY_DISABLED",
  "SWITCHROOM_POSTHOG_KEY",
  "SWITCHROOM_POSTHOG_HOST",
] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "compose-posthog-test-"));
  for (const k of ENV_KEYS) {
    originalEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (originalEnv[k] != null) process.env[k] = originalEnv[k];
    else delete process.env[k];
  }
});

describe("compose-generator — PostHog runtime telemetry env vars", () => {
  it("emits SWITCHROOM_ANALYTICS_ID when the host file exists", () => {
    mkdirSync(join(tmpHome, ".switchroom"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".switchroom", "analytics-id"),
      "abc123-deterministic-uuid",
      "utf-8",
    );
    const out = generateCompose({ config: makeConfig(), homeDir: tmpHome });
    expect(out).toContain('SWITCHROOM_ANALYTICS_ID: "abc123-deterministic-uuid"');
  });

  it("omits SWITCHROOM_ANALYTICS_ID when the host file is missing", () => {
    const out = generateCompose({ config: makeConfig(), homeDir: tmpHome });
    expect(out).not.toContain("SWITCHROOM_ANALYTICS_ID:");
  });

  it("omits SWITCHROOM_ANALYTICS_ID when the host file is empty", () => {
    mkdirSync(join(tmpHome, ".switchroom"), { recursive: true });
    writeFileSync(join(tmpHome, ".switchroom", "analytics-id"), "   \n", "utf-8");
    const out = generateCompose({ config: makeConfig(), homeDir: tmpHome });
    expect(out).not.toContain("SWITCHROOM_ANALYTICS_ID:");
  });

  it("propagates SWITCHROOM_TELEMETRY_DISABLED=1 from host env", () => {
    process.env.SWITCHROOM_TELEMETRY_DISABLED = "1";
    const out = generateCompose({ config: makeConfig(), homeDir: tmpHome });
    expect(out).toContain('SWITCHROOM_TELEMETRY_DISABLED: "1"');
  });

  it("propagates SWITCHROOM_TELEMETRY_DISABLED=true from host env", () => {
    process.env.SWITCHROOM_TELEMETRY_DISABLED = "true";
    const out = generateCompose({ config: makeConfig(), homeDir: tmpHome });
    // Normalised to "1" on emission so the in-container reader's truthy
    // check matches without operator-specific casing surprises.
    expect(out).toContain('SWITCHROOM_TELEMETRY_DISABLED: "1"');
  });

  it("does NOT emit SWITCHROOM_TELEMETRY_DISABLED when unset (the common case)", () => {
    const out = generateCompose({ config: makeConfig(), homeDir: tmpHome });
    expect(out).not.toContain("SWITCHROOM_TELEMETRY_DISABLED:");
  });

  it("propagates SWITCHROOM_POSTHOG_KEY override from host env", () => {
    process.env.SWITCHROOM_POSTHOG_KEY = "phc_override_key_xyz";
    const out = generateCompose({ config: makeConfig(), homeDir: tmpHome });
    expect(out).toContain('SWITCHROOM_POSTHOG_KEY: "phc_override_key_xyz"');
  });

  it("propagates SWITCHROOM_POSTHOG_HOST override from host env", () => {
    process.env.SWITCHROOM_POSTHOG_HOST = "https://eu.i.posthog.com";
    const out = generateCompose({ config: makeConfig(), homeDir: tmpHome });
    expect(out).toContain(
      'SWITCHROOM_POSTHOG_HOST: "https://eu.i.posthog.com"',
    );
  });

  it("byte-determinism: two runs with same inputs produce identical output", () => {
    mkdirSync(join(tmpHome, ".switchroom"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".switchroom", "analytics-id"),
      "stable-uuid",
      "utf-8",
    );
    process.env.SWITCHROOM_TELEMETRY_DISABLED = "1";
    const out1 = generateCompose({ config: makeConfig(), homeDir: tmpHome });
    const out2 = generateCompose({ config: makeConfig(), homeDir: tmpHome });
    expect(out1).toBe(out2);
  });
});
