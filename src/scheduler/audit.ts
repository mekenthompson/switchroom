/**
 * Scheduler audit log — scheduler.db.
 *
 * Schema (frozen for Phase 1a, enforced by tests):
 *   columns: when_ms, agent, schedule_index, prompt_key, exit_code, output_summary
 *   indices: (agent, when_ms)
 *
 * Implementation note: the production scheduler container runs Node and
 * will be wired against better-sqlite3 in Phase 1b's image build; for
 * Phase 1a we ship the storage as an injectable interface so that
 * (a) vitest tests don't drag a native dep into the test toolchain, and
 * (b) the SQL DDL is defined exactly once, here, ready for Phase 1b to
 * lift verbatim into a Database.exec() call.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DispatchResult } from "./dispatch.js";

export const SCHEDULER_DB_DDL = `
CREATE TABLE IF NOT EXISTS fires (
  when_ms        INTEGER NOT NULL,
  agent          TEXT NOT NULL,
  schedule_index INTEGER NOT NULL,
  prompt_key     TEXT NOT NULL,
  exit_code      INTEGER NOT NULL,
  output_summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS fires_by_agent ON fires(agent, when_ms);
`.trim();

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
