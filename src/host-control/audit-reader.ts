/**
 * Reader / formatter for the hostd audit log
 * (~/.switchroom/host-control-audit.log).
 *
 * The log is written by {@link HostControlServer.writeAudit} as
 * append-only JSONL. Each row captures one privileged verb invocation:
 *
 *   {ts, op, caller:{kind,name?}, request_id, result, exit_code,
 *    duration_ms, error?}
 *
 * Pure functions only — the CLI verb at `src/cli/audit.ts` and the
 * Telegram `/audit hostd` handler in the gateway both depend on this
 * module to share parsing + filtering semantics.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export interface AuditEntry {
  ts: string;
  op: string;
  caller: { kind: "agent"; name: string } | { kind: "operator" };
  request_id: string;
  result: string;
  exit_code: number | null;
  duration_ms: number;
  error?: string;
}

export interface AuditFilters {
  agent?: string;
  op?: string;
  errorOnly?: boolean;
}

export function defaultAuditLogPath(home: string = homedir()): string {
  return join(home, ".switchroom", "host-control-audit.log");
}

/** Parse a single JSONL line. Returns null on malformed input — the log
 *  is best-effort append-only so we tolerate the occasional partial
 *  write (interrupted fsync). */
export function parseAuditLine(line: string): AuditEntry | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof obj !== "object" || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.ts !== "string" || typeof o.op !== "string") return null;
  if (typeof o.request_id !== "string" || typeof o.result !== "string") return null;
  if (typeof o.duration_ms !== "number") return null;
  const callerRaw = o.caller as Record<string, unknown> | undefined;
  let caller: AuditEntry["caller"];
  if (callerRaw && callerRaw.kind === "agent" && typeof callerRaw.name === "string") {
    caller = { kind: "agent", name: callerRaw.name };
  } else if (callerRaw && callerRaw.kind === "operator") {
    caller = { kind: "operator" };
  } else {
    return null;
  }
  const exit_code = o.exit_code === null || typeof o.exit_code === "number"
    ? (o.exit_code as number | null)
    : null;
  const entry: AuditEntry = {
    ts: o.ts,
    op: o.op,
    caller,
    request_id: o.request_id,
    result: o.result,
    exit_code,
    duration_ms: o.duration_ms,
  };
  if (typeof o.error === "string") entry.error = o.error;
  return entry;
}

/** Apply filters in-order, return matching entries unchanged. */
export function filterEntries(
  entries: readonly AuditEntry[],
  filters: AuditFilters,
): AuditEntry[] {
  return entries.filter((e) => {
    if (filters.agent != null) {
      if (e.caller.kind !== "agent") return false;
      if (e.caller.name !== filters.agent) return false;
    }
    if (filters.op != null && e.op !== filters.op) return false;
    if (filters.errorOnly) {
      // Treat `error` and `denied` as failure-shaped. `started` is in-
      // flight (long-running async ops), excluded from error filter
      // because by itself it's not a failure.
      if (e.result !== "error" && e.result !== "denied") return false;
    }
    return true;
  });
}

/** Parse + filter + take last N (most-recent). Bounded reads — caller
 *  passes the whole file contents; for huge logs the CLI/gateway should
 *  pre-tail before calling. */
export function readAndFilter(
  raw: string,
  filters: AuditFilters,
  limit: number,
): AuditEntry[] {
  const lines = raw.split("\n");
  const parsed: AuditEntry[] = [];
  for (const line of lines) {
    const e = parseAuditLine(line);
    if (e != null) parsed.push(e);
  }
  const filtered = filterEntries(parsed, filters);
  return filtered.slice(-Math.max(1, limit));
}

function shortCaller(caller: AuditEntry["caller"]): string {
  return caller.kind === "agent" ? caller.name : "operator";
}

function shortTs(ts: string): string {
  // 2026-05-15T04:15:13.465Z → 2026-05-15 04:15:13
  return ts.replace("T", " ").replace(/\.\d+Z$/, "").slice(0, 19);
}

/** Plain-text formatter for CLI stdout. Fixed-width columns. */
export function formatForCli(entries: readonly AuditEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const ts = shortTs(e.ts).padEnd(20);
    const caller = shortCaller(e.caller).padEnd(15);
    const op = e.op.padEnd(16);
    const result = e.result.padEnd(10);
    const exit = e.exit_code == null ? "  -" : String(e.exit_code).padStart(3);
    const ms = `${e.duration_ms}ms`.padStart(8);
    out.push(`${ts} ${caller} ${op} ${result} ${exit} ${ms}`);
  }
  return out;
}

/** Telegram-flavoured formatter — same columns, suited for fenced code
 *  block. Caller wraps in <pre>…</pre>. */
export function formatForTelegram(entries: readonly AuditEntry[]): string {
  if (entries.length === 0) return "(no matching entries)";
  const lines = formatForCli(entries);
  return lines.join("\n");
}
