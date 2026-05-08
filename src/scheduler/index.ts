/**
 * Scheduler entrypoint — runs as PID 1 (under tini) inside
 * switchroom/scheduler. Reads the cascade-resolved switchroom.yaml from
 * /state/config, registers each agent's schedule[] with node-cron, and
 * on fire dispatches via `docker exec`.
 *
 * Phase 1a wiring is intentionally minimal: this entrypoint binds the
 * pieces (config loader → collectScheduleEntries → cron → dispatch →
 * audit). The dispatch + audit modules carry the unit-tested logic;
 * this file is the runtime glue and is exercised by the (deferred)
 * Phase 1b live integration tests.
 */

import { resolve } from "node:path";
import { loadConfig } from "../config/loader.js";
import {
  collectScheduleEntries,
  defaultExecRunner,
  dispatchEntry,
  type SchedulerEntry,
} from "./dispatch.js";
import {
  JsonlAuditSink,
  InMemoryAuditSink,
  type AuditSink,
} from "./audit.js";
import { SqliteAuditSink } from "./audit-sqlite.js";

/**
 * Minimal node-cron-shaped surface — we don't add the package as a dep
 * in Phase 1a; the production scheduler container's image build (Phase
 * 1b) installs it inside the layer and the entrypoint resolves it at
 * runtime. Tests inject their own implementation.
 */
export interface CronLib {
  schedule(expr: string, handler: () => void | Promise<void>): { stop(): void };
}

export interface RegisterOptions {
  entries: SchedulerEntry[];
  sink: AuditSink;
  /** Replaceable for tests; in production, resolved at runtime via require("node-cron"). */
  cronLib: CronLib;
  /** Replaceable for tests. */
  runner?: Parameters<typeof dispatchEntry>[1];
}

export interface RegisteredTask {
  entry: SchedulerEntry;
  task: { stop: () => void };
}

/**
 * Register every entry with node-cron. Returns the live tasks so the
 * caller can stop them on shutdown. Pure-ish: side effects are limited
 * to the cron lib's internal scheduler.
 */
export function registerSchedule(opts: RegisterOptions): RegisteredTask[] {
  const lib = opts.cronLib;
  const runner = opts.runner ?? defaultExecRunner;
  const tasks: RegisteredTask[] = [];
  for (const entry of opts.entries) {
    const task = lib.schedule(entry.cron, async () => {
      try {
        const result = await dispatchEntry(entry, runner);
        opts.sink.recordFire(result);
      } catch (err) {
        // Audit even on dispatch failure so the operator can see it.
        opts.sink.recordFire({
          agent: entry.agent,
          scheduleIndex: entry.scheduleIndex,
          promptKey: entry.promptKey,
          exitCode: -1,
          outputSummary: `dispatch error: ${(err as Error).message}`.slice(0, 200),
          startedAt: Date.now(),
          finishedAt: Date.now(),
        });
      }
    });
    tasks.push({ entry, task });
  }
  return tasks;
}

/**
 * Pick the audit sink based on env flags. Exported for tests.
 *
 * Precedence:
 *   1. inMemory=true                   → InMemoryAuditSink
 *   2. sqliteDbPath !== undefined      → SqliteAuditSink at that path.
 *      Set by Phase 1b's scheduler compose service for production
 *      telemetry. Requires better-sqlite3 to be resolvable in the
 *      runtime — installed in the scheduler image, not at the repo
 *      root, so don't invoke this branch from vitest.
 *   3. default                         → JsonlAuditSink at jsonlPath
 */
export interface PickSinkOptions {
  inMemory: boolean;
  sqliteDbPath: string | undefined;
  jsonlPath: string;
  /** Test-only: inject a stub better-sqlite3 ctor. */
  _testSqliteCtor?: ConstructorParameters<typeof SqliteAuditSink>[0]["sqliteCtor"];
}
export function pickSink(opts: PickSinkOptions): AuditSink {
  if (opts.inMemory) return new InMemoryAuditSink();
  if (opts.sqliteDbPath !== undefined) {
    return new SqliteAuditSink({
      dbPath: resolve(opts.sqliteDbPath),
      sqliteCtor: opts._testSqliteCtor,
    });
  }
  return new JsonlAuditSink(resolve(opts.jsonlPath));
}

export async function main(): Promise<void> {
  const configPath = process.env.SWITCHROOM_CONFIG ?? "/state/config/switchroom.yaml";
  const dbPath = process.env.SWITCHROOM_SCHEDULER_DB ?? "/state/scheduler/scheduler.db.jsonl";
  const config = loadConfig(configPath);
  const entries = collectScheduleEntries(config);
  const sink: AuditSink = pickSink({
    inMemory: process.env.SWITCHROOM_SCHEDULER_INMEMORY === "1",
    sqliteDbPath: process.env.SWITCHROOM_SCHEDULER_DB_PATH,
    jsonlPath: dbPath,
  });
  // Lazy-resolve node-cron at runtime — the package is installed inside
  // the scheduler container image (Phase 1b) and is intentionally NOT a
  // top-level switchroom dep (avoids dragging it into every install).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cronLib = require("node-cron") as CronLib;
  const tasks = registerSchedule({ entries, sink, cronLib });
  process.stdout.write(`scheduler: registered ${tasks.length} task(s) across ${new Set(entries.map(e => e.agent)).size} agent(s)\n`);
  const shutdown = () => {
    for (const t of tasks) t.task.stop();
    sink.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`scheduler fatal: ${err instanceof Error ? err.stack : err}\n`);
    process.exit(1);
  });
}
