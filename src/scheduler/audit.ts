/**
 * Scheduler audit log — append-only JSONL written by the in-agent
 * scheduler at /state/agent/scheduler.jsonl. Each row is a
 * `DispatchResult` (see ./dispatch.ts). Operators can `tail -f` the
 * file; the at-least-once replay logic on agent-scheduler boot scans
 * recent rows to determine which scheduled fires already ran.
 *
 * Pre-Phase-4 the singleton scheduler also wrote a SQLite audit
 * (audit-sqlite.ts + SCHEDULER_DB_DDL) — both have been removed
 * now that cron runs in-container.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DispatchResult } from "./dispatch.js";

export interface AuditSink {
  recordFire(result: DispatchResult): void;
  close(): void;
}

/**
 * In-memory sink — used by unit tests and as a fallback when no DB
 * path is configured. The fires array is appended in dispatch order.
 */
export class InMemoryAuditSink implements AuditSink {
  public readonly fires: DispatchResult[] = [];
  recordFire(r: DispatchResult): void { this.fires.push(r); }
  close(): void { /* nothing to release */ }
}

/**
 * JSONL file sink — append-only, one fire per line. The scheduler
 * container's persistent volume holds the file; operators can `tail -f`
 * it in production. Phase 1b swaps this for a SQLite-backed sink that
 * implements the same interface; the JSONL output remains as a
 * convenience replica for `docker compose logs` muscle memory.
 */
export class JsonlAuditSink implements AuditSink {
  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  }
  recordFire(r: DispatchResult): void {
    appendFileSync(this.path, JSON.stringify(r) + "\n", { mode: 0o600 });
  }
  close(): void { /* fs.appendFileSync is synchronous; nothing held open */ }
}
