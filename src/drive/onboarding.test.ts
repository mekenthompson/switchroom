/**
 * Onboarding card structure tests (RFC C §5).
 */

import { describe, expect, it } from "bun:test";
import { buildOnboardingCard, buildReconnectCard } from "./onboarding.js";

describe("buildOnboardingCard", () => {
  it("surface is mcp:gdrive (not 'system' — onboarding is per-MCP)", () => {
    const c = buildOnboardingCard("klanker");
    expect(c.surface).toBe("mcp:gdrive");
    expect(c.agent).toBe("klanker");
  });

  it("first option is the recommended Allow-my-Drive read grant (default per §5)", () => {
    const c = buildOnboardingCard("klanker");
    const first = c.options[0];
    expect(first.choice).toEqual({ kind: "allow_drive_read" });
    expect(first.grant_scope).toBe("doc:gdrive:**");
    expect(first.grant_action).toBe("read");
    expect(first.label.toLowerCase()).toContain("recommended");
  });

  it("includes the per-doc warning option", () => {
    const c = buildOnboardingCard("klanker");
    const perDoc = c.options.find((o) => o.choice.kind === "per_doc");
    expect(perDoc).toBeDefined();
    expect(perDoc?.grant_scope).toBe(null);
  });

  it("body warns explicitly about prompt-flood for per-doc choice", () => {
    const c = buildOnboardingCard("klanker");
    expect(c.body).toContain("20+ prompts");
  });

  it("body names the agent so the user can verify on small screens", () => {
    const c = buildOnboardingCard("klanker");
    expect(c.body).toContain("klanker");
  });
});

describe("buildReconnectCard", () => {
  it("surface is system (per RFC §4.2)", () => {
    const c = buildReconnectCard("klanker");
    expect(c.surface).toBe("system");
    expect(c.action_grammar).toBe("reconnect_drive");
  });

  it("includes Reconnect + Disconnect-permanently buttons", () => {
    const c = buildReconnectCard("klanker");
    const labels = c.options.map((o) => o.action);
    expect(labels).toContain("reconnect");
    expect(labels).toContain("disconnect");
  });

  it("propagates Google's invalid_grant detail when provided", () => {
    const c = buildReconnectCard("klanker", "Token has been expired or revoked.");
    expect(c.body).toContain("Token has been expired or revoked");
  });
});
