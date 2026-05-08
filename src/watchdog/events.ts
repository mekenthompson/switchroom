/**
 * Structured audit-event emitter — Phase 3b-1.
 *
 * Each lifecycle decision the watchdog makes (restart attempt, restart
 * success, escalation, healthcheck-fail tally, etc.) is appended to
 * the `audit_events` table in `watchdog.db`. Downstream consumers
 * (Telegram-plugin notification, web dashboard, operator CLI) read
 * the tail later — this module does NOT itself ship events anywhere.
 *
 * The event-type strings are part of the public contract; downstream
 * consumers will dispatch on them.
 */

import type { WatchdogState } from "./state.js";
import type { Database } from "bun:sqlite";

export type WatchdogEventType =
  | "restart-attempt"
  | "restart-skipped-escalated"
  | "healthcheck-fail"
  | "healthcheck-recovery"
  | "container-exit"
  | "container-oom"
  | "container-start"
  | "escalated"
  | "watchdog-start"
  | "watchdog-stop";

export interface WatchdogEvent {
  ts: number;
  container: string;
  type: WatchdogEventType;
  detail?: Record<string, unknown>;
}

export interface AuditEventRow {
  id: number;
  ts: number;
  container: string;
  event_type: string;
  detail: string | null;
}

export class WatchdogEvents {
  constructor(
    private readonly db: Database,
    private readonly _state: WatchdogState,
    private readonly stderr: { write: (s: string) => void } = process.stderr,
  ) {}

  emit(ev: WatchdogEvent): void {
    const detailJson = ev.detail ? JSON.stringify(ev.detail) : null;
    this.db
      .prepare(
        `INSERT INTO audit_events (ts, container, event_type, detail)
         VALUES (?, ?, ?, ?)`,
      )
      .run(ev.ts, ev.container, ev.type, detailJson);
    // Also log to stderr in JSON-line format so journald captures it.
    this.stderr.write(
      JSON.stringify({
        ts: ev.ts,
        container: ev.container,
        type: ev.type,
        detail: ev.detail ?? null,
      }) + "\n",
    );
  }

  recent(limit: number): AuditEventRow[] {
    return this.db
      .prepare(`SELECT * FROM audit_events ORDER BY ts DESC LIMIT ?`)
      .all(limit) as AuditEventRow[];
  }
}
