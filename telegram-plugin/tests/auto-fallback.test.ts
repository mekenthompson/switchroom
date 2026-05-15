import { describe, expect, it } from "vitest";
import { loadLockout, type LockoutRecord, type LockoutPersistOps } from "../auto-fallback.js";

// The auto-fallback module is read-only since PR #1329 — the writer +
// decision logic + plan executor were retired alongside the legacy
// per-agent poller (fleet-wide path supersedes them). The only
// remaining consumer is gateway.ts's `isAutoFallbackCooldownActive`,
// which reads the existing on-disk lockout to bound a pending-restart
// drain. This test set covers that one read path.

const EMPTY: LockoutRecord = { lastTransitionedFrom: null, lastTransitionAt: 0 };

function fakeOps(initial: Record<string, string> = {}): LockoutPersistOps & {
  files: Map<string, string>;
} {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFileSync: (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return v;
    },
    // unused by loadLockout — present to satisfy the interface.
    writeFileSync: () => { throw new Error("writes are retired"); },
    mkdirSync: () => { throw new Error("mkdir is retired"); },
    existsSync: (p: string) => files.has(p),
    joinPath: (...parts: string[]) => parts.join("/"),
  };
}

describe("loadLockout — read-only after #1329", () => {
  it("returns the empty lockout when no file exists", () => {
    expect(loadLockout("/agent", fakeOps())).toEqual(EMPTY);
  });

  it("returns the parsed record on a well-formed file", () => {
    const ops = fakeOps({
      "/agent/.claude/auto-fallback-lockout.json": JSON.stringify({
        lastTransitionedFrom: "ken@example.com",
        lastTransitionAt: 1_700_000_000_000,
      }),
    });
    expect(loadLockout("/agent", ops)).toEqual({
      lastTransitionedFrom: "ken@example.com",
      lastTransitionAt: 1_700_000_000_000,
    });
  });

  it("falls back to the empty lockout on malformed JSON", () => {
    const ops = fakeOps({
      "/agent/.claude/auto-fallback-lockout.json": "{broken json",
    });
    expect(loadLockout("/agent", ops)).toEqual(EMPTY);
  });

  it("falls back to the empty lockout on missing fields", () => {
    const ops = fakeOps({
      "/agent/.claude/auto-fallback-lockout.json": JSON.stringify({ wrong: "shape" }),
    });
    expect(loadLockout("/agent", ops)).toEqual(EMPTY);
  });

  it("falls back to the empty lockout when lastTransitionAt is non-finite", () => {
    const ops = fakeOps({
      "/agent/.claude/auto-fallback-lockout.json": JSON.stringify({
        lastTransitionedFrom: "ken@example.com",
        lastTransitionAt: "not a number",
      }),
    });
    expect(loadLockout("/agent", ops)).toEqual(EMPTY);
  });

  it("accepts an explicit-null lastTransitionedFrom", () => {
    const ops = fakeOps({
      "/agent/.claude/auto-fallback-lockout.json": JSON.stringify({
        lastTransitionedFrom: null,
        lastTransitionAt: 0,
      }),
    });
    expect(loadLockout("/agent", ops)).toEqual(EMPTY);
  });
});
