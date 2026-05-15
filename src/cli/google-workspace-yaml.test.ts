import { describe, expect, it } from "vitest";

import { setGoogleWorkspaceBlock } from "./google-workspace-yaml.js";

const BASE = `# top-level comment
switchroom:
  version: 1
telegram:
  bot_token: "x"  # inline comment
agents:
  clerk:
    extends: default
`;

const BLOCK = {
  clientIdRef: "vault:google-oauth-client-id",
  clientSecretRef: "vault:google-oauth-client-secret",
  approvers: [123, 456],
  tier: "core" as const,
};

describe("setGoogleWorkspaceBlock", () => {
  it("adds the block when absent and preserves surrounding content + comments", () => {
    const out = setGoogleWorkspaceBlock(BASE, BLOCK);
    expect(out).toMatch(/^# top-level comment/m);
    expect(out).toContain("# inline comment");
    expect(out).toContain("clerk:");
    expect(out).toMatch(/^google_workspace:$/m);
    // The yaml lib emits `vault:...` as a valid unquoted plain scalar;
    // assert on the key/value pair without pinning quote style (parse
    // round-trip is covered by the next test).
    expect(out).toMatch(
      /google_client_id:\s*"?vault:google-oauth-client-id"?/,
    );
    expect(out).toMatch(
      /google_client_secret:\s*"?vault:google-oauth-client-secret"?/,
    );
    expect(out).toMatch(/approvers:\s*\n?\s*(- 123|\[\s*123)/);
    expect(out).toContain("tier: core");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("re-parses to the expected shape", async () => {
    const { parse } = await import("yaml");
    const parsed = parse(setGoogleWorkspaceBlock(BASE, BLOCK));
    expect(parsed.google_workspace.google_client_id).toBe(
      "vault:google-oauth-client-id",
    );
    expect(parsed.google_workspace.approvers).toEqual([123, 456]);
    expect(parsed.google_workspace.tier).toBe("core");
    // Untouched siblings survive.
    expect(parsed.switchroom.version).toBe(1);
  });

  it("never clobbers an existing google_workspace: block (returns input verbatim)", () => {
    const withBlock = `google_workspace:\n  google_client_id: "existing"\n  tier: extended\n${BASE}`;
    expect(setGoogleWorkspaceBlock(withBlock, BLOCK)).toBe(withBlock);
  });

  it("never clobbers the legacy drive: alias", () => {
    const withDrive = `drive:\n  google_client_id: "legacy"\n${BASE}`;
    expect(setGoogleWorkspaceBlock(withDrive, BLOCK)).toBe(withDrive);
  });

  it("rejects empty refs and empty approvers", () => {
    expect(() =>
      setGoogleWorkspaceBlock(BASE, { ...BLOCK, clientIdRef: "" }),
    ).toThrow(/clientIdRef/);
    expect(() =>
      setGoogleWorkspaceBlock(BASE, { ...BLOCK, approvers: [] }),
    ).toThrow(/approver/);
  });

  it("throws when the YAML root is not a map", () => {
    expect(() => setGoogleWorkspaceBlock("- a\n- b\n", BLOCK)).toThrow(
      /root is not a map/,
    );
  });
});
