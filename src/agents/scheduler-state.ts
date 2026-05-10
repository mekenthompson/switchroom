/**
 * Scheduler-state probe (#931) — distinguishes scheduler-active
 * (registered N tasks) from scheduler-idle (no schedule entries) by
 * tail-reading agent-scheduler.log.
 *
 * Pre-#931, `switchroom agent status` and `switchroom agent list`
 * reported the same string for both states, so the operator had to
 * `docker logs <agent>` and grep to confirm scheduler health on a
 * fleet of N agents — friction that grows linearly with fleet size.
 *
 * Cheap log-tail-parse implementation (per the issue's "cheap version
 * vs JSON state file" choice). The log lines are stable since #921 /
 * #917 / #911:
 *   - active:  "agent-scheduler: <name> registered N task(s); ..."
 *   - idle:    "agent-scheduler: <name> has no schedule entries — idling ..."
 *   - wedged:  "[supervise] agent-scheduler hit 10 restarts in <60s — giving up"
 *               (legacy, pre-#921; surfaced for diagnosis on stale fleets)
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

export type SchedulerState =
  | { kind: "active"; tasks: number }
  | { kind: "idle" }
  | { kind: "wedged" }
  | { kind: "unknown"; reason: string };

/**
 * Returns the most-recent scheduler-state line for the named agent.
 * Tail-reads up to the last 64KB of the log to keep the cost bounded
 * for long-running fleets — state lines fire on every container
 * restart so the most recent is always near the end.
 */
export function getSchedulerState(
  agentName: string,
  logsDir: string,
): SchedulerState {
  const path = join(logsDir, agentName, "agent-scheduler.log");
  let buf: string;
  try {
    const stat = statSync(path);
    if (stat.size === 0) return { kind: "unknown", reason: "log empty" };
    // Read up to the last 64KB. State lines are <300 bytes each and
    // fire ≤1× per container restart so this is plenty of slack.
    // ESM-safe: top-of-file imports, not require() — see #938 reviewer.
    const fd = openSync(path, "r");
    try {
      const chunkSize = Math.min(65536, stat.size);
      const chunk = Buffer.alloc(chunkSize);
      readSync(fd, chunk, 0, chunkSize, stat.size - chunkSize);
      buf = chunk.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    return {
      kind: "unknown",
      reason: `log not readable: ${(err as Error).message}`,
    };
  }

  // Scan lines bottom-up; first state-line wins.
  const lines = buf.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (!line) continue;

    if (line.includes("hit 10 restarts in <60s")) {
      return { kind: "wedged" };
    }
    if (line.includes("has no schedule entries — idling")) {
      return { kind: "idle" };
    }
    const m = line.match(/registered (\d+) task\(s\)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return { kind: "active", tasks: n };
    }
  }
  return { kind: "unknown", reason: "no state line in log tail" };
}

/**
 * Pretty-print a SchedulerState for the `agent list` table column
 * and `agent status` line. Kept short so it fits in narrow terminals.
 */
export function formatSchedulerState(state: SchedulerState): string {
  switch (state.kind) {
    case "active": return `${state.tasks} task${state.tasks === 1 ? "" : "s"}`;
    case "idle":   return "idle";
    case "wedged": return "wedged";
    case "unknown": return `?`;
  }
}
