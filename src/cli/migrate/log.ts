/**
 * JSONL writer for ~/.switchroom/migration.log.
 *
 * One line per migration event. Append-only, idempotent on file
 * creation. Concurrency-safe within a single Node process via a
 * promise chain; cross-process concurrency relies on POSIX append
 * being atomic for writes < PIPE_BUF (we keep entries short).
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import type { MigrateVerb } from "./plan.js";

export interface MigrationLogEntry {
  ts: string; // ISO8601
  verb: MigrateVerb;
  step: string;
  status: "ok" | "error" | "rollback";
  detail?: string;
  error?: string;
}

export function defaultMigrationLogPath(): string {
  return join(homedir(), ".switchroom", "migration.log");
}

let chain: Promise<void> = Promise.resolve();

export async function appendMigrationLogEntry(
  entry: Omit<MigrationLogEntry, "ts"> & { ts?: string },
  path: string = defaultMigrationLogPath(),
): Promise<void> {
  const full: MigrationLogEntry = {
    ts: entry.ts ?? new Date().toISOString(),
    verb: entry.verb,
    step: entry.step,
    status: entry.status,
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    ...(entry.error !== undefined ? { error: entry.error } : {}),
  };
  const line = JSON.stringify(full) + "\n";
  // Serialize all writes through a process-local promise chain so that
  // concurrent appendMigrationLogEntry callers can't interleave writes.
  const next = chain.then(async () => {
    mkdirSync(dirname(path), { recursive: true });
    await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
  });
  // Don't let one failure poison the chain.
  chain = next.catch(() => undefined);
  return next;
}

/** Test helper: reset the in-process serialization chain. */
export function _resetLogChainForTests(): void {
  chain = Promise.resolve();
}
