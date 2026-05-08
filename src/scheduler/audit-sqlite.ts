/**
 * Scheduler SQLite audit sink — Phase 1b.
 *
 * Implements `AuditSink` against better-sqlite3 using the DDL frozen in
 * src/scheduler/audit.ts (SCHEDULER_DB_DDL). The native dep is
 * resolved via dynamic require so that vitest, which doesn't ship
 * better-sqlite3 in the host devDependencies, can import this module
 * without paying the load cost. The dep is installed inside
 * docker/Dockerfile.scheduler — see Phase 1b's image build.
 *
 * The class is intentionally thin: prepare-once, run-many on the
 * insert statement. Higher-level "summarize last N fires" / "GC fires
 * older than N days" queries belong on the operator side, not in the
 * dispatch hot path.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { SCHEDULER_DB_DDL, type AuditSink } from "./audit.js";
import type { DispatchResult } from "./dispatch.js";

// Use createRequire so this module can be statically imported without
// failing if better-sqlite3 isn't on the resolver path. The require
// itself runs lazily inside the constructor.
const requireFn = createRequire(import.meta.url);

interface BetterSqliteDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  };
  close(): void;
}

interface BetterSqliteCtor {
  new (path: string, options?: { readonly?: boolean }): BetterSqliteDatabase;
}

export interface SqliteAuditSinkOptions {
  /** Filesystem path; pass ":memory:" for an ephemeral test DB. */
  dbPath: string;
  /**
   * Optional override for the better-sqlite3 module. Tests use this to
   * inject a stub; production resolves the real native module via the
   * scheduler image's `npm install`.
   */
  sqliteCtor?: BetterSqliteCtor;
}

export class SqliteAuditSink implements AuditSink {
  private readonly db: BetterSqliteDatabase;
  private readonly insertStmt: ReturnType<BetterSqliteDatabase["prepare"]>;

  constructor(opts: SqliteAuditSinkOptions) {
    if (opts.dbPath !== ":memory:") {
      mkdirSync(dirname(opts.dbPath), { recursive: true, mode: 0o700 });
    }
    const Ctor: BetterSqliteCtor =
      opts.sqliteCtor ?? (requireFn("better-sqlite3") as BetterSqliteCtor);
    this.db = new Ctor(opts.dbPath);
    this.db.exec(SCHEDULER_DB_DDL);
    this.insertStmt = this.db.prepare(
      `INSERT INTO fires (when_ms, agent, schedule_index, prompt_key, exit_code, output_summary)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
  }

  recordFire(r: DispatchResult): void {
    this.insertStmt.run(
      r.finishedAt,
      r.agent,
      r.scheduleIndex,
      r.promptKey,
      r.exitCode,
      r.outputSummary,
    );
  }

  close(): void {
    this.db.close();
  }
}
