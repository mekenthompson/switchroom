/**
 * Scheduler dispatch logic — pure-function core, mockable for tests.
 *
 * Phase 1a slice. Reads the cascade-resolved config, walks every agent's
 * `schedule[]`, registers each entry with node-cron against the same
 * cron expressions cronToOnCalendar parses today, and on fire dispatches
 * via `docker exec agent-<name> claude -p "<prompt>"`.
 *
 * Identity boundary: the scheduler container is privileged (it mounts
 * /var/run/docker.sock to invoke `docker exec`) but does NOT see secret
 * values. The agent resolves its own vault refs through the broker
 * socket inside its container. The scheduler only fires the dispatch
 * and audits the (when, agent, schedule_index, prompt_key, exit_code,
 * output_summary) row to scheduler.db.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { ScheduleEntry, SwitchroomConfig } from "../config/schema.js";

export interface SchedulerEntry {
  agent: string;
  scheduleIndex: number;
  cron: string;
  prompt: string;
  /** SHA-256 prefix of prompt — stable, non-reversible audit key. */
  promptKey: string;
}

/**
 * Walk the resolved config and produce a flat list of (agent, index)
 * schedule entries that the cron loop registers. Pure function: no IO.
 *
 * Deterministic order: agents sorted by name, then schedule entries by
 * declared index. Important for snapshot tests of the audit log shape.
 */
export function collectScheduleEntries(
  config: SwitchroomConfig,
): SchedulerEntry[] {
  const out: SchedulerEntry[] = [];
  const agentNames = Object.keys(config.agents).sort();
  for (const agent of agentNames) {
    const schedule: ScheduleEntry[] = config.agents[agent]?.schedule ?? [];
    for (let i = 0; i < schedule.length; i++) {
      const entry = schedule[i]!;
      out.push({
        agent,
        scheduleIndex: i,
        cron: entry.cron,
        prompt: entry.prompt,
        promptKey: createHash("sha256").update(entry.prompt).digest("hex").slice(0, 12),
      });
    }
  }
  return out;
}

export interface DispatchResult {
  agent: string;
  scheduleIndex: number;
  promptKey: string;
  exitCode: number;
  /** Trimmed stdout/stderr — first 200 chars only, for the audit row. */
  outputSummary: string;
  startedAt: number;
  finishedAt: number;
}

export type ExecRunner = (
  args: string[],
  stdin: string,
) => Promise<{ exitCode: number; output: string }>;

/**
 * Default exec runner — shells `docker exec -i agent-<name> claude -p`,
 * piping the prompt on stdin (avoids embedding the prompt in argv where
 * it'd show up in `ps` and shell history). Tests inject a mock.
 */
export const defaultExecRunner: ExecRunner = (args, stdin) =>
  new Promise((resolveP) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    child.stdout.on("data", (c) => { buf += c.toString("utf8"); });
    child.stderr.on("data", (c) => { buf += c.toString("utf8"); });
    child.on("close", (code) => {
      resolveP({ exitCode: code ?? -1, output: buf });
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });

/**
 * Dispatch a single schedule entry. Pure-ish: takes an injectable runner
 * so tests can drive the full path without a live docker daemon.
 */
export async function dispatchEntry(
  entry: SchedulerEntry,
  runner: ExecRunner = defaultExecRunner,
): Promise<DispatchResult> {
  const startedAt = Date.now();
  const containerName = `agent-${entry.agent}`;
  // -i: keep stdin open so we can pipe the prompt in.
  // claude -p: print mode, single prompt, exits when done.
  const args = ["exec", "-i", containerName, "claude", "-p"];
  const { exitCode, output } = await runner(args, entry.prompt);
  const finishedAt = Date.now();
  return {
    agent: entry.agent,
    scheduleIndex: entry.scheduleIndex,
    promptKey: entry.promptKey,
    exitCode,
    outputSummary: output.trim().slice(0, 200),
    startedAt,
    finishedAt,
  };
}
