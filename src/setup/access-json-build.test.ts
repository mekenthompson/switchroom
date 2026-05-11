/**
 * Tests for `buildAccessJson` in setup/onboarding.ts.
 *
 * Covers issues #1001 (numeric userId must serialise as a string) and
 * #1002 (DM topology / empty-or-sentinel forum chat id must omit the
 * groups block).
 */

import { describe, it, expect } from "vitest";
import { buildAccessJson } from "./onboarding.js";

function parse(s: string): {
  allowFrom: unknown;
  groups?: Record<string, unknown>;
  dmPolicy: string;
} {
  return JSON.parse(s);
}

describe("buildAccessJson — userId coercion (#1001)", () => {
  it("string userId lands as a quoted string in allowFrom", () => {
    const j = parse(buildAccessJson("8248703757", "-100123", undefined));
    expect(j.allowFrom).toEqual(["8248703757"]);
    expect(typeof (j.allowFrom as unknown[])[0]).toBe("string");
  });

  it("numeric userId (typed-out from a legacy user.json) is coerced to string", () => {
    // Defensive coercion: the type says `string` but TS can't enforce at
    // runtime, and the gateway rejects unquoted JSON numbers as
    // 'non-string entries'.
    const j = parse(buildAccessJson(8248703757 as unknown as string, "-100123", undefined));
    expect(j.allowFrom).toEqual(["8248703757"]);
    expect(typeof (j.allowFrom as unknown[])[0]).toBe("string");
  });
});

describe("buildAccessJson — groups gating (#1002)", () => {
  it("DM-topology (dmOnly:true) omits the groups block entirely", () => {
    const j = parse(buildAccessJson("12345", "-100abc", undefined, { dmOnly: true }));
    expect(j.groups).toBeUndefined();
  });

  it("empty forumChatId omits the groups block (no synthetic empty-key entry)", () => {
    // Pre-fix: this produced groups: { "": { ... } } which the gateway
    // boot-probe 404s on. Post-fix: skip the block when forum chat id
    // is not a real value.
    const j = parse(buildAccessJson("12345", "", undefined));
    expect(j.groups).toBeUndefined();
  });

  it('sentinel "0" forumChatId also omits the groups block', () => {
    // v0.7 setup writes "0" as a placeholder for "no forum configured".
    // It's not a real chat id; don't pin it into the access list.
    const j = parse(buildAccessJson("12345", "0", undefined));
    expect(j.groups).toBeUndefined();
  });

  it("real forumChatId + non-dmOnly emits the groups entry as before", () => {
    const j = parse(buildAccessJson("12345", "-1001234567890", undefined));
    expect(j.groups).toEqual({
      "-1001234567890": { requireMention: false, allowFrom: [] },
    });
  });
});
