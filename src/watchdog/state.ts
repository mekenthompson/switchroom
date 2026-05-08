/**
 * Watchdog persistent state — Phase 3b-1.
 *
 * Stores per-container restart counters, escalation flags, and the
 * audit-event tail in a dedicated SQLite db (`~/.switchroom/watchdog.db`
 * by default).
 *
 * Schema is intentionally narrow and ISOLATED from the broker
 * (vault_grants.db) and the kernel (kernel.db) — Phase 3b-1 must not
 * mutate either of those schemas. New file, new schema, no shared
 * tables.
 *
 * Three tables:
 *   - containers (1 row per watched container, current state)
 *   - restart_history (append-only, used by bounded-retries policy)
 *   - audit_events (append-only event tail, escalation + lifecycle)
 *
 * The `Database` handle is injected — tests use `:memory:` so no
 * production state is touched. Production code calls
 * `openWatchdogDb(path)` which mkdirs the parent and opens the file
 * with restrictive perms.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Database } from "bun:sqlite";

/** DDL frozen at Phase 3b-1. Add via additive migrations only. */
export const WATCHDOG_DB_DDL = `
CREATE TABLE IF NOT EXISTS containers (
  name TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  agent TEXT,
  last_event_ts INTEGER NOT NULL,
  consecutive_health_fails INTEGER NOT NULL DEFAULT 0,
  escalated INTEGER NOT NULL DEFAULT 0,
  escalated_ts INTEGER
);

CREATE TABLE IF NOT EXISTS restart_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  container TEXT NOT NULL,
  ts INTEGER NOT NULL,
  reason TEXT NOT NULL,
  attempt INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_restart_history_container_ts
  ON restart_history (container, ts);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  container TEXT NOT NULL,
  event_type TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_events_ts
  ON audit_events (ts);
`;

export interface ContainerRow {
  name: string;
  role: string;
  agent: string | null;
  last_event_ts: number;
  consecutive_health_fails: number;
  escalated: number;
  escalated_ts: number | null;
}

export interface RestartHistoryRow {
  id: number;
  container: string;
  ts: number;
  reason: string;
  attempt: number;
}

export class WatchdogState {
  constructor(private readonly db: Database) {
    db.run(WATCHDOG_DB_DDL);
  }

  upsertContainer(args: {
    name: string;
    role: string;
    agent: string | null;
    nowMs: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO containers (name, role, agent, last_event_ts)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           role = excluded.role,
           agent = excluded.agent,
           last_event_ts = excluded.last_event_ts`,
      )
      .run(args.name, args.role, args.agent, args.nowMs);
  }

  getContainer(name: string): ContainerRow | null {
    const row = this.db
      .prepare(`SELECT * FROM containers WHERE name = ?`)
      .get(name) as ContainerRow | null;
    return row ?? null;
  }

  setConsecutiveHealthFails(name: string, count: number, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE containers SET consecutive_health_fails = ?, last_event_ts = ? WHERE name = ?`,
      )
      .run(count, nowMs, name);
  }

  markEscalated(name: string, nowMs: number): void {
    this.db
      .prepare(
        `UPDATE containers SET escalated = 1, escalated_ts = ?, last_event_ts = ? WHERE name = ?`,
      )
      .run(nowMs, nowMs, name);
  }

  isEscalated(name: string): boolean {
    const row = this.getContainer(name);
    return row != null && row.escalated === 1;
  }

  recordRestart(args: {
    container: string;
    ts: number;
    reason: string;
    attempt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO restart_history (container, ts, reason, attempt)
         VALUES (?, ?, ?, ?)`,
      )
      .run(args.container, args.ts, args.reason, args.attempt);
  }

  /**
   * Count restarts for `container` whose ts is within [sinceMs, nowMs].
   * Used by the bounded-retries policy.
   */
  countRecentRestarts(
    container: string,
    sinceMs: number,
    nowMs: number,
  ): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS c FROM restart_history
         WHERE container = ? AND ts >= ? AND ts <= ?`,
      )
      .get(container, sinceMs, nowMs) as { c: number };
    return row.c;
  }

  recentRestarts(container: string, limit: number): RestartHistoryRow[] {
    return this.db
      .prepare(
        `SELECT * FROM restart_history WHERE container = ?
         ORDER BY ts DESC LIMIT ?`,
      )
      .all(container, limit) as RestartHistoryRow[];
  }
}

/**
 * Open the watchdog db at `path`, creating its parent dir if needed.
 * Caller must `import { Database } from "bun:sqlite"` — we accept a
 * constructor so tests can sub in `:memory:` without dragging the
 * native module into the vitest worker.
 */
export function openWatchdogDb(
  path: string,
  Ctor: new (p: string) => Database,
): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  return new Ctor(path);
}
