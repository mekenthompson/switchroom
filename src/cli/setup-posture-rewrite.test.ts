/**
 * Tests for the YAML-aware `vault.broker.approvalAuth` rewrite used by
 * `switchroom setup`. Pre-fix the rewrite was a single regex
 * (`^(\s+)broker:\s*\n`) that would match ANY `broker:` mapping in the
 * file — landing the posture key under e.g. a top-level peer `broker:`
 * sibling of `vault:`. These tests pin the scoping so the regression
 * can't quietly recur.
 */

import { describe, expect, it } from "vitest";
import { insertVaultBrokerApprovalAuth } from "./setup-posture-rewrite.js";
import YAML from "yaml";

describe("insertVaultBrokerApprovalAuth", () => {
  it("inserts approvalAuth under vault.broker when only vault.broker exists", () => {
    const src = [
      "vault:",
      "  broker:",
      "    autoUnlock: true",
      "    autoUnlockCredentialPath: ~/.switchroom/vault-auto-unlock",
      "",
    ].join("\n");
    const result = insertVaultBrokerApprovalAuth(src, "telegram-id");
    expect(result.kind).toBe("rewritten");
    if (result.kind !== "rewritten") return;
    const parsed = YAML.parse(result.content);
    expect(parsed.vault.broker.approvalAuth).toBe("telegram-id");
    expect(parsed.vault.broker.autoUnlock).toBe(true);
  });

  it("does NOT touch a sibling top-level broker: key", () => {
    // This is the regression case the reviewer flagged: a top-level
    // `broker:` peer of `vault:` should NOT receive the posture key.
    const src = [
      "broker:",
      "  # totally unrelated top-level broker config",
      "  endpoint: https://example.test",
      "  port: 8080",
      "vault:",
      "  broker:",
      "    autoUnlock: true",
      "",
    ].join("\n");
    const result = insertVaultBrokerApprovalAuth(src, "telegram-id");
    expect(result.kind).toBe("rewritten");
    if (result.kind !== "rewritten") return;
    const parsed = YAML.parse(result.content);
    // The sibling top-level broker must be untouched.
    expect(parsed.broker.endpoint).toBe("https://example.test");
    expect(parsed.broker.port).toBe(8080);
    expect(parsed.broker.approvalAuth).toBeUndefined();
    // The vault.broker block gets the key.
    expect(parsed.vault.broker.approvalAuth).toBe("telegram-id");
    expect(parsed.vault.broker.autoUnlock).toBe(true);
  });

  it("returns already-set when approvalAuth is already declared", () => {
    const src = [
      "vault:",
      "  broker:",
      "    autoUnlock: true",
      "    approvalAuth: passphrase",
      "",
    ].join("\n");
    const result = insertVaultBrokerApprovalAuth(src, "telegram-id");
    expect(result.kind).toBe("already-set");
  });

  it("returns not-found when vault.broker is missing", () => {
    const src = [
      "vault:",
      "  path: ~/.switchroom/vault.enc",
      "",
    ].join("\n");
    const result = insertVaultBrokerApprovalAuth(src, "telegram-id");
    expect(result.kind).toBe("not-found");
  });

  it("returns not-found when vault is missing entirely", () => {
    const src = [
      "broker:",
      "  endpoint: https://example.test",
      "",
    ].join("\n");
    const result = insertVaultBrokerApprovalAuth(src, "telegram-id");
    expect(result.kind).toBe("not-found");
  });

  it("preserves user comments and surrounding formatting", () => {
    const src = [
      "# top-level comment about the whole file",
      "vault:",
      "  # broker-related comment",
      "  broker:",
      "    autoUnlock: true   # inline comment",
      "    # another comment",
      "    autoUnlockCredentialPath: ~/.switchroom/vault-auto-unlock",
      "",
      "telegram:",
      "  bot_token: xxx",
      "",
    ].join("\n");
    const result = insertVaultBrokerApprovalAuth(src, "telegram-id");
    expect(result.kind).toBe("rewritten");
    if (result.kind !== "rewritten") return;
    expect(result.content).toContain("# top-level comment about the whole file");
    expect(result.content).toContain("# broker-related comment");
    expect(result.content).toContain("# inline comment");
    expect(result.content).toContain("# another comment");
    // telegram block intact
    expect(result.content).toContain("telegram:");
    expect(result.content).toContain("bot_token: xxx");
    const parsed = YAML.parse(result.content);
    expect(parsed.vault.broker.approvalAuth).toBe("telegram-id");
  });
});
