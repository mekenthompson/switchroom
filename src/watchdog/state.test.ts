/**
 * Watchdog state + events unit tests — Phase 3b-1.
 *
 * Pure in-memory SQLite via bun:sqlite. No docker, no filesystem.
 */

import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import { WatchdogState } from "./state.js";
import { WatchdogEvents } from "./events.js";

function freshState(): { db: Database; state: WatchdogState } {
  const db = new Database(":memory:");
  const state = new WatchdogState(db);
  return { db, state };
}

describe("WatchdogState — schema + container row", () => {
  it("creates schema idempotently", () => {
    const { db } = freshState();
    // Calling new WatchdogState a second time on the same db must not throw.
    expect(() => new WatchdogState(db)).not.toThrow();
  });

  it("upserts a container and reads it back", () => {
    const { state } = freshState();
    state.upsertContainer({
      name: "switchroom-alice",
      role: "agent",
      agent: "alice",
      nowMs: 1000,
    });
    const row = state.getContainer("switchroom-alice");
    expect(row).not.toBeNull();
    expect(row?.role).toBe("agent");
    expect(row?.agent).toBe("alice");
    expect(row?.escalated).toBe(0);
  });

  it("returns null for unknown container", () => {
    const { state } = freshState();
    expect(state.getContainer("nope")).toBeNull();
  });

  it("tracks consecutive-health-fail count", () => {
    const { state } = freshState();
    state.upsertContainer({ name: "c1", role: "agent", agent: null, nowMs: 0 });
    state.setConsecutiveHealthFails("c1", 3, 5);
    expect(state.getContainer("c1")?.consecutive_health_fails).toBe(3);
  });

  it("marks escalation and reflects via isEscalated", () => {
    const { state } = freshState();
    state.upsertContainer({ name: "c1", role: "agent", agent: null, nowMs: 0 });
    expect(state.isEscalated("c1")).toBe(false);
    state.markEscalated("c1", 1234);
    expect(state.isEscalated("c1")).toBe(true);
    expect(state.getContainer("c1")?.escalated_ts).toBe(1234);
  });
});

describe("WatchdogState — restart history", () => {
  it("records and counts restarts within a window", () => {
    const { state } = freshState();
    state.recordRestart({ container: "c1", ts: 100, reason: "exit", attempt: 1 });
    state.recordRestart({ container: "c1", ts: 200, reason: "exit", attempt: 2 });
    state.recordRestart({ container: "c1", ts: 1000, reason: "exit", attempt: 3 });
    state.recordRestart({ container: "c2", ts: 150, reason: "exit", attempt: 1 });
    expect(state.countRecentRestarts("c1", 0, 500)).toBe(2);
    expect(state.countRecentRestarts("c1", 0, 1500)).toBe(3);
    expect(state.countRecentRestarts("c2", 0, 1500)).toBe(1);
  });

  it("excludes restarts older than the window start", () => {
    const { state } = freshState();
    state.recordRestart({ container: "c1", ts: 100, reason: "exit", attempt: 1 });
    state.recordRestart({ container: "c1", ts: 1000, reason: "exit", attempt: 2 });
    expect(state.countRecentRestarts("c1", 500, 1500)).toBe(1);
  });
});

describe("WatchdogEvents", () => {
  it("appends events and reads them back newest-first", () => {
    const { db, state } = freshState();
    const stderr = { write: () => {} };
    const events = new WatchdogEvents(db, state, stderr);
    events.emit({ ts: 1, container: "c1", type: "container-start" });
    events.emit({
      ts: 2,
      container: "c1",
      type: "restart-attempt",
      detail: { backoffMs: 1000 },
    });
    const recent = events.recent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.event_type).toBe("restart-attempt");
    expect(recent[0]?.detail).toBe('{"backoffMs":1000}');
  });

  it("writes JSON lines to stderr for journald capture", () => {
    const { db, state } = freshState();
    const lines: string[] = [];
    const stderr = { write: (s: string) => lines.push(s) };
    const events = new WatchdogEvents(db, state, stderr);
    events.emit({ ts: 42, container: "c1", type: "escalated" });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.ts).toBe(42);
    expect(parsed.type).toBe("escalated");
  });
});
