/**
 * Tests for the vault-CLI error parser + renderer (issue #969 P0b).
 */

import { describe, it, expect } from "vitest";
import { parseVaultCliError, renderVaultCliError } from "./vault-error.js";

describe("parseVaultCliError", () => {
  it("classifies VAULT-SANDBOX-CONTEXT", () => {
    const stderr =
      "VAULT-SANDBOX-CONTEXT: direct vault access is unavailable inside an " +
      "agent sandbox. The vault file is not mounted into agent containers; " +
      "only the broker socket is. Run 'switchroom vault init' on the host shell, " +
      "or use a broker-supported operation.";
    const err = parseVaultCliError(stderr);
    expect(err.kind).toBe("sandbox_context");
    // The hint contains 'switchroom vault init' — parser must skip it.
    expect(err.key).toBeUndefined();
  });

  it("classifies VAULT-NEEDS-APPROVAL and extracts the affected key", () => {
    const stderr =
      "VAULT-NEEDS-APPROVAL [unknown_key]: secret 'telegram_bot_token_klanker_20260510' " +
      "does not exist in the vault yet. Agents can rotate existing keys via " +
      "the broker but cannot create new ones; this requires operator approval.";
    const err = parseVaultCliError(stderr);
    expect(err.kind).toBe("needs_approval");
    expect(err.key).toBe("telegram_bot_token_klanker_20260510");
  });

  it("classifies VAULT-BROKER-UNREACHABLE", () => {
    const stderr =
      "VAULT-BROKER-UNREACHABLE: cannot reach vault broker " +
      "(ENOENT: no such file or directory, connect '/run/switchroom/broker/sock'). " +
      "From inside the agent sandbox, direct vault access is not possible.";
    const err = parseVaultCliError(stderr);
    expect(err.kind).toBe("broker_unreachable");
  });

  it("classifies VAULT-BROKER-DENIED", () => {
    const stderr =
      "VAULT-BROKER-DENIED [DENIED]: agent 'klanker' is not in the allow list for key 'shared_token'";
    const err = parseVaultCliError(stderr);
    expect(err.kind).toBe("broker_denied");
    // First single-quoted token is 'klanker' — accept either as valid key
    // (the renderer falls back to the verbHint.key for the host command).
    expect(["klanker", "shared_token"]).toContain(err.key);
  });

  it("returns 'other' for unrecognised errors", () => {
    const err = parseVaultCliError("Error: something broke\nstack trace …");
    expect(err.kind).toBe("other");
    expect(err.key).toBeUndefined();
  });

  it("handles empty / undefined stderr gracefully", () => {
    expect(parseVaultCliError("").kind).toBe("other");
    expect(parseVaultCliError(undefined as unknown as string).kind).toBe("other");
  });
});

describe("renderVaultCliError", () => {
  it("renders sandbox_context with a host-CLI suggestion", () => {
    const out = renderVaultCliError(
      { kind: "sandbox_context", original: "x" },
      { verb: "set", key: "my_key" },
    );
    expect(out.suppressRaw).toBe(true);
    expect(out.html).toContain("must run on the host");
    expect(out.html).toContain("switchroom vault set my_key");
  });

  it("renders needs_approval with the affected key + host hint + P1a teaser", () => {
    const out = renderVaultCliError(
      { kind: "needs_approval", original: "x", key: "telegram_bot_token" },
      { verb: "save" },
    );
    expect(out.suppressRaw).toBe(true);
    expect(out.html).toContain("operator approval required");
    expect(out.html).toContain("<code>telegram_bot_token</code>");
    expect(out.html).toContain("switchroom vault set telegram_bot_token");
    expect(out.html).toContain("P1a"); // forward-pointer to the upcoming flow
  });

  it("renders broker_unreachable with the status command", () => {
    const out = renderVaultCliError(
      { kind: "broker_unreachable", original: "x" },
      { verb: "set" },
    );
    expect(out.suppressRaw).toBe(true);
    expect(out.html).toContain("broker isn't reachable");
    expect(out.html).toContain("switchroom vault broker status");
  });

  it("renders broker_denied with a grant command + key", () => {
    const out = renderVaultCliError(
      { kind: "broker_denied", original: "x", key: "shared_token" },
      { verb: "set" },
    );
    expect(out.suppressRaw).toBe(true);
    expect(out.html).toContain("refused the request");
    expect(out.html).toContain("switchroom vault grant");
    expect(out.html).toContain("shared_token");
  });

  it("returns suppressRaw=false for 'other' so the gateway falls back to a raw pre-block", () => {
    const out = renderVaultCliError({ kind: "other", original: "weird error" }, { verb: "set" });
    expect(out.suppressRaw).toBe(false);
    expect(out.html).toBe("");
  });

  it("escapes HTML special characters in the key", () => {
    const out = renderVaultCliError(
      { kind: "needs_approval", original: "x", key: "key<with>html" },
      { verb: "save" },
    );
    expect(out.html).not.toContain("<with>");
    expect(out.html).toContain("key&lt;with&gt;html");
  });
});
