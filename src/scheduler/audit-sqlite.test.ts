/**
 * Unit test for SqliteAuditSink.
 *
 * Two slices:
 *   - With an injected stub ctor: deterministic, no native dep, runs in
 *     vitest. Verifies DDL is applied, inserts hit the prepared statement
 *     with the right column ordering, and close() is forwarded.
 *   - With the real better-sqlite3 (skipIf the module isn't resolvable):
 *     end-to-end against an in-memory DB to catch DDL drift between
 *     audit.ts and audit-sqlite.ts.
 */

import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { SqliteAuditSink } from "./audit-sqlite.js";
import { SCHEDULER_DB_DDL } from "./audit.js";
import type { DispatchResult } from "./dispatch.js";

const sampleResult: DispatchResult = {
  agent: "klanker",
  scheduleIndex: 0,
  promptKey: "abc12345",
  exitCode: 0,
  outputSummary: "ran clean",
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_001_500,
};

describe("SqliteAuditSink (injected stub)", () => {
  it("applies DDL on construction and inserts rows in the audit column order", () => {
    const execLog: string[] = [];
    const runLog: unknown[][] = [];
    let closed = false;

    const stubCtor = function (_path: string) {
      return {
        exec(sql: string) {
          execLog.push(sql);
        },
        prepare(_sql: string) {
          return {
            run(...args: unknown[]) {
              runLog.push(args);
              return { changes: 1, lastInsertRowid: runLog.length };
            },
          };
        },
        close() {
          closed = true;
        },
      };
    } as unknown as ConstructorParameters<
      typeof SqliteAuditSink
    >[0]["sqliteCtor"];

    const sink = new SqliteAuditSink({ dbPath: ":memory:", sqliteCtor: stubCtor });

    expect(execLog).toEqual([SCHEDULER_DB_DDL]);

    sink.recordFire(sampleResult);
    expect(runLog).toHaveLength(1);
    // Column order MUST match: when_ms, agent, schedule_index, prompt_key,
    // exit_code, output_summary. when_ms is finishedAt.
    expect(runLog[0]).toEqual([
      sampleResult.finishedAt,
      sampleResult.agent,
      sampleResult.scheduleIndex,
      sampleResult.promptKey,
      sampleResult.exitCode,
      sampleResult.outputSummary,
    ]);

    sink.close();
    expect(closed).toBe(true);
  });
});

// Live test: only runs when better-sqlite3 is actually on the host's
// resolver path. In vitest under switchroom's repo, it isn't a host
// devDependency — it lives inside the scheduler image. CI's image-build
// step covers the live path; this guard keeps the unit suite portable.
let hasBetterSqlite = false;
try {
  createRequire(import.meta.url).resolve("better-sqlite3");
  hasBetterSqlite = true;
} catch {
  hasBetterSqlite = false;
}

describe.skipIf(!hasBetterSqlite)(
  "SqliteAuditSink (live better-sqlite3, skipped without native dep)",
  () => {
    it("round-trips a fire through an in-memory DB", () => {
      const sink = new SqliteAuditSink({ dbPath: ":memory:" });
      sink.recordFire(sampleResult);
      // Reaching into the private db handle is intentional here — we want
      // to assert the row landed without exposing a query API on the sink.
      const db = (sink as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }).db;
      const rows = db.prepare("SELECT * FROM fires").all() as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.agent).toBe(sampleResult.agent);
      expect(rows[0]?.exit_code).toBe(sampleResult.exitCode);
      sink.close();
    });
  },
);
