/**
 * RFC G Phase 1 — `getGdriveMcpSettingsEntry()` tier knob plumbing.
 *
 * The function previously took no args; Phase 1 added an optional `tier`
 * (RFC G §4.2). This test pins the back-compat default (no flag emitted
 * when tier is undefined) and verifies the three documented tier values
 * round-trip into the spawn args.
 */

import { describe, expect, it } from "vitest";

import {
  getGdriveMcpSettingsEntry,
  type GdriveMcpTier,
} from "./scaffold-integration.js";

describe("getGdriveMcpSettingsEntry — RFC G Phase 1 tier knob", () => {
  it("emits no --tool-tier flag when called with no options (back-compat)", () => {
    const entry = getGdriveMcpSettingsEntry();
    expect(entry.value.args).not.toContain("--tool-tier");
  });

  it("emits no --tool-tier flag when tier is explicitly undefined", () => {
    const entry = getGdriveMcpSettingsEntry({ tier: undefined });
    expect(entry.value.args).not.toContain("--tool-tier");
  });

  it.each<GdriveMcpTier>(["core", "extended", "complete"])(
    "emits --tool-tier %s when tier is set",
    (tier) => {
      const entry = getGdriveMcpSettingsEntry({ tier });
      const args = entry.value.args ?? [];
      const flagIdx = args.indexOf("--tool-tier");
      expect(flagIdx).toBeGreaterThan(-1);
      expect(args[flagIdx + 1]).toBe(tier);
      // Flag must come after the program-name positional, not before:
      expect(flagIdx).toBeGreaterThan(args.indexOf("google-workspace-mcp"));
    },
  );

  it("preserves the pinned upstream SHA in the --from arg regardless of tier", () => {
    const expected =
      "git+https://github.com/taylorwilsdon/google_workspace_mcp.git@f3c7dc5df2641c8545abc9e8f402d794f2853745";
    for (const tier of [undefined, "core", "extended", "complete"] as const) {
      const entry = getGdriveMcpSettingsEntry(tier ? { tier } : undefined);
      expect(entry.value.args).toContain(expected);
    }
  });

  it("preserves the GOOGLE_OAUTH_TOKEN_FROM_VAULT env regardless of tier", () => {
    for (const tier of [undefined, "core", "extended", "complete"] as const) {
      const entry = getGdriveMcpSettingsEntry(tier ? { tier } : undefined);
      expect(entry.value.env?.GOOGLE_OAUTH_TOKEN_FROM_VAULT).toBe("1");
    }
  });
});
