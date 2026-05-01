/**
 * Tests for vault-broker schema additions (PR 1) and CLI flag knobs (PR 196-198).
 *
 * Covers:
 *   - ScheduleEntrySchema.secrets: valid values, regex rejection, default []
 *   - VaultConfigSchema.broker: default population when omitted
 *   - AgentSchema.thinking_effort: enum validation
 *   - AgentSchema.permission_mode: enum validation
 *   - AgentSchema.fallback_model: regex validation
 */

import { describe, expect, it } from "vitest";
import { AgentSchema, ScheduleEntrySchema, VaultConfigSchema } from "./schema.js";

describe("ScheduleEntrySchema.secrets", () => {
  it("accepts a list of valid vault key names", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
      secrets: ["openai_api_key", "polygon_api_key"],
    });
    expect(result.secrets).toEqual(["openai_api_key", "polygon_api_key"]);
  });

  it("accepts key names with hyphens", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
      secrets: ["my-key", "another-key-123"],
    });
    expect(result.secrets).toEqual(["my-key", "another-key-123"]);
  });

  it("defaults to [] when secrets field is omitted", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
    });
    expect(result.secrets).toEqual([]);
  });

  it("defaults to [] when secrets is explicitly []", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
      secrets: [],
    });
    expect(result.secrets).toEqual([]);
  });

  it("rejects key names containing spaces", () => {
    expect(() =>
      ScheduleEntrySchema.parse({
        cron: "0 8 * * *",
        prompt: "Send a brief.",
        secrets: ["bad space"],
      }),
    ).toThrow();
  });

  it("rejects key names containing shell-special characters", () => {
    const badNames = ["foo$bar", "foo;bar", "foo.bar", "foo@bar"];
    for (const name of badNames) {
      expect(() =>
        ScheduleEntrySchema.parse({
          cron: "0 8 * * *",
          prompt: "Send a brief.",
          secrets: [name],
        }),
        `expected "${name}" to be rejected`,
      ).toThrow();
    }
  });

  it("accepts namespaced key names with forward slashes", () => {
    const result = ScheduleEntrySchema.parse({
      cron: "0 8 * * *",
      prompt: "Send a brief.",
      secrets: ["microsoft/ken-tokens", "openai/api-key"],
    });
    expect(result.secrets).toEqual(["microsoft/ken-tokens", "openai/api-key"]);
  });
});

describe("VaultConfigSchema.broker", () => {
  it("populates broker defaults when vault.broker is omitted", () => {
    const result = VaultConfigSchema.parse({});
    expect(result.broker.socket).toBe("~/.switchroom/vault-broker.sock");
    expect(result.broker.enabled).toBe(true);
  });

  it("populates broker defaults when vault block is empty", () => {
    const result = VaultConfigSchema.parse({});
    expect(result.broker).toEqual({
      socket: "~/.switchroom/vault-broker.sock",
      enabled: true,
      autoUnlock: false,
      autoUnlockCredentialPath: "~/.config/switchroom/auto-unlock.bin",
    });
  });

  it("accepts an explicit broker socket override", () => {
    const result = VaultConfigSchema.parse({
      broker: { socket: "/run/my-broker.sock" },
    });
    expect(result.broker.socket).toBe("/run/my-broker.sock");
    expect(result.broker.enabled).toBe(true);
  });

  it("accepts broker.enabled: false", () => {
    const result = VaultConfigSchema.parse({
      broker: { enabled: false },
    });
    expect(result.broker.enabled).toBe(false);
    expect(result.broker.socket).toBe("~/.switchroom/vault-broker.sock");
  });

  it("preserves existing vault.path alongside broker defaults", () => {
    const result = VaultConfigSchema.parse({
      path: "/custom/vault.enc",
    });
    expect(result.path).toBe("/custom/vault.enc");
    expect(result.broker.enabled).toBe(true);
  });

  it("defaults autoUnlock to false", () => {
    const result = VaultConfigSchema.parse({});
    expect(result.broker.autoUnlock).toBe(false);
  });

  it("accepts autoUnlock: true", () => {
    const result = VaultConfigSchema.parse({
      broker: { autoUnlock: true },
    });
    expect(result.broker.autoUnlock).toBe(true);
    expect(result.broker.enabled).toBe(true);
  });

  it("accepts a custom autoUnlockCredentialPath", () => {
    const result = VaultConfigSchema.parse({
      broker: { autoUnlockCredentialPath: "/etc/credstore.encrypted/vault-passphrase" },
    });
    expect(result.broker.autoUnlockCredentialPath).toBe(
      "/etc/credstore.encrypted/vault-passphrase"
    );
  });
});

function baseAgentInput(overrides: Record<string, unknown> = {}) {
  return {
    topic_name: "Test",
    ...overrides,
  };
}

describe("AgentSchema.thinking_effort", () => {
  it("accepts all valid effort values", () => {
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const result = AgentSchema.parse(baseAgentInput({ thinking_effort: effort }));
      expect(result.thinking_effort).toBe(effort);
    }
  });

  it("is optional — omitted means no flag", () => {
    const result = AgentSchema.parse(baseAgentInput());
    expect(result.thinking_effort).toBeUndefined();
  });

  it("rejects invalid effort values", () => {
    expect(() =>
      AgentSchema.parse(baseAgentInput({ thinking_effort: "ultra" })),
    ).toThrow();
  });

  it("rejects empty string", () => {
    expect(() =>
      AgentSchema.parse(baseAgentInput({ thinking_effort: "" })),
    ).toThrow();
  });
});

describe("AgentSchema.permission_mode", () => {
  it("accepts all valid permission_mode values", () => {
    const modes = [
      "acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan",
    ] as const;
    for (const mode of modes) {
      const result = AgentSchema.parse(baseAgentInput({ permission_mode: mode }));
      expect(result.permission_mode).toBe(mode);
    }
  });

  it("is optional — omitted means no flag", () => {
    const result = AgentSchema.parse(baseAgentInput());
    expect(result.permission_mode).toBeUndefined();
  });

  it("rejects invalid permission_mode values", () => {
    expect(() =>
      AgentSchema.parse(baseAgentInput({ permission_mode: "skipAll" })),
    ).toThrow();
  });
});

describe("AgentSchema.fallback_model", () => {
  it("accepts valid model names", () => {
    for (const model of ["sonnet", "haiku", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      const result = AgentSchema.parse(baseAgentInput({ fallback_model: model }));
      expect(result.fallback_model).toBe(model);
    }
  });

  it("is optional — omitted means no flag", () => {
    const result = AgentSchema.parse(baseAgentInput());
    expect(result.fallback_model).toBeUndefined();
  });

  it("rejects model names with spaces", () => {
    expect(() =>
      AgentSchema.parse(baseAgentInput({ fallback_model: "bad model" })),
    ).toThrow();
  });

  it("rejects model names with shell-special characters", () => {
    expect(() =>
      AgentSchema.parse(baseAgentInput({ fallback_model: "model$foo" })),
    ).toThrow();
  });
});
