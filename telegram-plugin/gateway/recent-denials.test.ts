/**
 * Tests for the recent-denial scanner (#969 P2b).
 */

import { describe, it, expect } from "vitest";
import { recentDenialsFromAuditLog } from "./recent-denials.js";

// Anchor "now" in test runs so the windowing is reproducible.
const NOW_MS = Date.parse("2026-05-11T12:00:00Z");

function entry(o: Partial<{ ts: string; agent_name: string; key: string; result: string }>): string {
  return JSON.stringify({
    ts: o.ts,
    op: "get",
    caller: "pid:1234",
    pid: 1234,
    agent_name: o.agent_name,
    key: o.key,
    result: o.result ?? "denied:scope-allow",
  });
}

describe("recentDenialsFromAuditLog", () => {
  it("returns empty on empty log", () => {
    expect(
      recentDenialsFromAuditLog("", { agentName: "klanker", windowMs: 1000, limit: 5, nowMs: NOW_MS }),
    ).toEqual([]);
  });

  it("filters to the target agent only", () => {
    const log = [
      entry({ ts: "2026-05-11T11:00:00Z", agent_name: "klanker", key: "k1", result: "denied:scope-allow" }),
      entry({ ts: "2026-05-11T11:00:00Z", agent_name: "OTHER", key: "k2", result: "denied:scope-allow" }),
    ].join("\n");
    const r = recentDenialsFromAuditLog(log, { agentName: "klanker", windowMs: 24 * 3600 * 1000, limit: 5, nowMs: NOW_MS });
    expect(r).toHaveLength(1);
    expect(r[0].key).toBe("k1");
  });

  it("filters to denied results only (drops allowed)", () => {
    const log = [
      entry({ ts: "2026-05-11T11:00:00Z", agent_name: "klanker", key: "k1", result: "allowed" }),
      entry({ ts: "2026-05-11T11:00:00Z", agent_name: "klanker", key: "k2", result: "denied:scope-allow" }),
    ].join("\n");
    const r = recentDenialsFromAuditLog(log, { agentName: "klanker", windowMs: 24 * 3600 * 1000, limit: 5, nowMs: NOW_MS });
    expect(r.map((x) => x.key)).toEqual(["k2"]);
  });

  it("groups multiple denials for the same key into a count", () => {
    const log = [
      entry({ ts: "2026-05-11T10:00:00Z", agent_name: "klanker", key: "openai", result: "denied:scope-allow" }),
      entry({ ts: "2026-05-11T11:00:00Z", agent_name: "klanker", key: "openai", result: "denied:scope-allow" }),
      entry({ ts: "2026-05-11T11:30:00Z", agent_name: "klanker", key: "openai", result: "denied:scope-allow" }),
    ].join("\n");
    const r = recentDenialsFromAuditLog(log, { agentName: "klanker", windowMs: 24 * 3600 * 1000, limit: 5, nowMs: NOW_MS });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ key: "openai", count: 3 });
    expect(r[0].lastSeenMs).toBe(Date.parse("2026-05-11T11:30:00Z"));
  });

  it("excludes entries older than the window", () => {
    const log = [
      entry({ ts: "2026-05-01T00:00:00Z", agent_name: "klanker", key: "stale" }), // > 7 days
      entry({ ts: "2026-05-11T11:00:00Z", agent_name: "klanker", key: "fresh" }),
    ].join("\n");
    const r = recentDenialsFromAuditLog(log, { agentName: "klanker", windowMs: 7 * 24 * 3600 * 1000, limit: 5, nowMs: NOW_MS });
    expect(r.map((x) => x.key)).toEqual(["fresh"]);
  });

  it("sorts newest first and applies limit", () => {
    const log = [
      entry({ ts: "2026-05-11T09:00:00Z", agent_name: "klanker", key: "a" }),
      entry({ ts: "2026-05-11T10:00:00Z", agent_name: "klanker", key: "b" }),
      entry({ ts: "2026-05-11T11:00:00Z", agent_name: "klanker", key: "c" }),
      entry({ ts: "2026-05-11T11:30:00Z", agent_name: "klanker", key: "d" }),
    ].join("\n");
    const r = recentDenialsFromAuditLog(log, { agentName: "klanker", windowMs: 24 * 3600 * 1000, limit: 2, nowMs: NOW_MS });
    expect(r.map((x) => x.key)).toEqual(["d", "c"]);
  });

  it("drops keys that don't match the safe slug regex", () => {
    // Defensive: a tampered log line should not surface a button with
    // injection-shaped data, even though Telegram callback_data is
    // sanitized at render time too.
    const log = [
      entry({ ts: "2026-05-11T11:00:00Z", agent_name: "klanker", key: "../etc/passwd" }),
      entry({ ts: "2026-05-11T11:00:00Z", agent_name: "klanker", key: "good_key" }),
    ].join("\n");
    const r = recentDenialsFromAuditLog(log, { agentName: "klanker", windowMs: 24 * 3600 * 1000, limit: 5, nowMs: NOW_MS });
    expect(r.map((x) => x.key)).toEqual(["good_key"]);
  });

  it("ignores malformed JSON lines silently", () => {
    const log = [
      "not json",
      "{trailing comma,}",
      entry({ ts: "2026-05-11T11:00:00Z", agent_name: "klanker", key: "valid" }),
    ].join("\n");
    const r = recentDenialsFromAuditLog(log, { agentName: "klanker", windowMs: 24 * 3600 * 1000, limit: 5, nowMs: NOW_MS });
    expect(r).toHaveLength(1);
    expect(r[0].key).toBe("valid");
  });
});
