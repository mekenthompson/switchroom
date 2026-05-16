/**
 * RFC G — `getGdriveMcpSettingsEntry()` launcher wiring + the shared
 * broker-ACL gate predicate (`shouldEmitGdriveMcp`).
 *
 * The entry used to be a bare `uvx` command with a dead
 * `GOOGLE_OAUTH_TOKEN_FROM_VAULT` env. It now points at the switchroom
 * CLI's hidden `drive-mcp-launcher` verb (the launcher seeds a
 * refresh-token credentials file and execs upstream `--single-user`).
 * These tests pin: the launcher command, no env block, the tier
 * pass-through, and the broker-ACL-contract agreement.
 */

import { describe, expect, it } from "vitest";

import {
  getGdriveMcpSettingsEntry,
  shouldEmitGdriveMcp,
  type GdriveMcpTier,
} from "./scaffold-integration.js";

const CLI = "/usr/local/bin/switchroom";

describe("getGdriveMcpSettingsEntry — launcher command", () => {
  it("uses the switchroom CLI's drive-mcp-launcher verb as the command", () => {
    const entry = getGdriveMcpSettingsEntry(CLI);
    expect(entry.key).toBe("gdrive");
    expect(entry.value.command).toBe(CLI);
    expect(entry.value.args?.[0]).toBe("drive-mcp-launcher");
  });

  it("does NOT emit a uvx command or any GOOGLE_OAUTH_*_FROM_VAULT env", () => {
    const entry = getGdriveMcpSettingsEntry(CLI);
    expect(entry.value.command).not.toBe("uvx");
    // The dead env injection is gone entirely.
    expect(entry.value.env).toBeUndefined();
  });

  it("emits no --tier flag when called with no options (back-compat)", () => {
    const entry = getGdriveMcpSettingsEntry(CLI);
    expect(entry.value.args).not.toContain("--tier");
  });

  it("emits no --tier flag when tier is explicitly undefined", () => {
    const entry = getGdriveMcpSettingsEntry(CLI, { tier: undefined });
    expect(entry.value.args).not.toContain("--tier");
  });

  it.each<GdriveMcpTier>(["core", "extended", "complete"])(
    "passes --tier %s through to the launcher when tier is set",
    (tier) => {
      const entry = getGdriveMcpSettingsEntry(CLI, { tier });
      const args = entry.value.args ?? [];
      const flagIdx = args.indexOf("--tier");
      expect(flagIdx).toBeGreaterThan(-1);
      expect(args[flagIdx + 1]).toBe(tier);
      // Flag comes after the verb positional, not before.
      expect(flagIdx).toBeGreaterThan(args.indexOf("drive-mcp-launcher"));
    },
  );
});

describe("shouldEmitGdriveMcp — broker-ACL contract", () => {
  // The same config that makes the scaffold emit the gdrive entry MUST
  // be the config under which the broker would return a Google account.
  // Broker logic (src/auth/broker/server.ts opGoogleGetCredentials):
  //   account = agents.<name>.google_workspace.account  (must be set)
  //   ACL     = google_accounts[account].enabled_for[].includes(name)
  // shouldEmitGdriveMcp encodes exactly that — these cases pin both
  // sides to one predicate.

  it("emits when account set AND agent in enabled_for[] (broker would return creds)", () => {
    expect(
      shouldEmitGdriveMcp("carrie", "pixsoul@gmail.com", {
        "pixsoul@gmail.com": { enabled_for: ["clerk", "carrie"] },
      }),
    ).toBe(true);
  });

  it("does NOT emit when agent has no google_workspace.account (broker → ACCOUNT_NOT_FOUND)", () => {
    expect(
      shouldEmitGdriveMcp("carrie", undefined, {
        "pixsoul@gmail.com": { enabled_for: ["carrie"] },
      }),
    ).toBe(false);
  });

  it("does NOT emit when the referenced account isn't in google_accounts", () => {
    expect(
      shouldEmitGdriveMcp("carrie", "pixsoul@gmail.com", {
        "other@gmail.com": { enabled_for: ["carrie"] },
      }),
    ).toBe(false);
  });

  it("does NOT emit when agent NOT in enabled_for[] (broker → FORBIDDEN)", () => {
    expect(
      shouldEmitGdriveMcp("carrie", "pixsoul@gmail.com", {
        "pixsoul@gmail.com": { enabled_for: ["clerk"] },
      }),
    ).toBe(false);
  });

  it("does NOT emit when google_accounts is entirely absent", () => {
    expect(
      shouldEmitGdriveMcp("carrie", "pixsoul@gmail.com", undefined),
    ).toBe(false);
  });

  it("normalizes account case/whitespace the same way the schema + broker do", () => {
    // Schema lowercases+trims both the per-agent account and the
    // google_accounts keys; the predicate must agree post-normalization.
    expect(
      shouldEmitGdriveMcp("carrie", "  Pixsoul@Gmail.com  ", {
        "pixsoul@gmail.com": { enabled_for: ["carrie"] },
      }),
    ).toBe(true);
  });

  it("treats an empty-string account as not configured", () => {
    expect(
      shouldEmitGdriveMcp("carrie", "   ", {
        "pixsoul@gmail.com": { enabled_for: ["carrie"] },
      }),
    ).toBe(false);
  });
});
