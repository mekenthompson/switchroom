/**
 * Unit tests for getSchedulerState (#931).
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSchedulerState, formatSchedulerState } from "./scheduler-state.js";

function withTempLogs(
  agent: string,
  log: string,
  fn: (logsDir: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "sched-state-"));
  try {
    mkdirSync(join(dir, agent), { recursive: true });
    writeFileSync(join(dir, agent, "agent-scheduler.log"), log);
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("getSchedulerState", () => {
  it("returns active with task count when log shows registered N task(s)", () => {
    withTempLogs(
      "clerk",
      "agent-scheduler: clerk registered 5 task(s); chat=-1003 ...\n",
      (dir) => {
        expect(getSchedulerState("clerk", dir)).toEqual({
          kind: "active",
          tasks: 5,
        });
      },
    );
  });

  it("returns idle when log shows no schedule entries — idling", () => {
    withTempLogs(
      "finn",
      "agent-scheduler: finn has no schedule entries — idling (re-checks on container restart)\n",
      (dir) => {
        expect(getSchedulerState("finn", dir)).toEqual({ kind: "idle" });
      },
    );
  });

  it("returns wedged when log shows the supervisor restart-cap (legacy)", () => {
    withTempLogs(
      "old",
      "[supervise] agent-scheduler hit 10 restarts in <60s — giving up\n",
      (dir) => {
        expect(getSchedulerState("old", dir)).toEqual({ kind: "wedged" });
      },
    );
  });

  it("returns the most recent state line when log has historical noise above it", () => {
    // Realistic: the log accumulates restart cycles + scheduler ipc
    // reconnects; the bottom-up scan must pick the most recent
    // state, not the first one we see.
    const log = [
      "agent-scheduler: clerk has no schedule entries — idling (re-checks on container restart)",
      "[supervise] agent-scheduler exited (status=0, restart=10 in 12s window)",
      "[supervise] agent-scheduler hit 10 restarts in <60s — giving up",
      "agent-scheduler: clerk registered 5 task(s); chat=-1003 ...",
      "agent-scheduler: scheduler ipc: connected to ...",
      "",
    ].join("\n");
    withTempLogs("clerk", log, (dir) => {
      expect(getSchedulerState("clerk", dir)).toEqual({
        kind: "active",
        tasks: 5,
      });
    });
  });

  it("returns unknown when the log file doesn't exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "sched-state-missing-"));
    try {
      const r = getSchedulerState("ghost", dir);
      expect(r.kind).toBe("unknown");
      if (r.kind === "unknown") expect(r.reason).toMatch(/not readable/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns unknown when log exists but has no state line", () => {
    withTempLogs(
      "x",
      "agent-scheduler: scheduler ipc: reconnecting in 1000ms\n",
      (dir) => {
        const r = getSchedulerState("x", dir);
        expect(r.kind).toBe("unknown");
        if (r.kind === "unknown") expect(r.reason).toMatch(/no state line/);
      },
    );
  });
});

describe("formatSchedulerState", () => {
  it("singular vs plural task count", () => {
    expect(formatSchedulerState({ kind: "active", tasks: 1 })).toBe("1 task");
    expect(formatSchedulerState({ kind: "active", tasks: 5 })).toBe("5 tasks");
  });

  it("idle / wedged / unknown", () => {
    expect(formatSchedulerState({ kind: "idle" })).toBe("idle");
    expect(formatSchedulerState({ kind: "wedged" })).toBe("wedged");
    expect(formatSchedulerState({ kind: "unknown", reason: "x" })).toBe("?");
  });
});
