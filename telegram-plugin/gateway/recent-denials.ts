/**
 * Recent-denial scanner (issue #969 P2b).
 *
 * Parses the vault broker's NDJSON audit log to surface keys an agent
 * was recently denied access to. Used by the Telegram gateway's
 * `/vault audit <agent>` to render a one-tap "always allow" affordance
 * for each unique denial — closing the loop where a cron schedule
 * silently fails because `schedule[i].secrets[]` didn't list the key
 * the skill ended up needing.
 *
 * Extracted out of gateway.ts so the parse + filter + group logic is
 * unit-testable without spinning up a Telegram bot context.
 */

export interface RecentDenial {
  /** The vault key that was denied. */
  key: string;
  /** How many times this (agent, key) tuple was denied in the window. */
  count: number;
  /** Most-recent denial timestamp, unix ms. */
  lastSeenMs: number;
}

export interface RecentDenialsOpts {
  agentName: string;
  /** Time window, in ms, ending now. Entries older than this are dropped. */
  windowMs: number;
  /** Max number of unique-key denials to return (sorted newest-first). */
  limit: number;
  /** Optional "now" override for tests. */
  nowMs?: number;
}

/**
 * Parse a raw NDJSON audit log blob and return recent denials for one
 * agent. Best-effort: bad lines are skipped silently.
 *
 * Pure-functional — caller does the file IO.
 */
export function recentDenialsFromAuditLog(
  rawAuditLog: string,
  opts: RecentDenialsOpts,
): RecentDenial[] {
  const now = opts.nowMs ?? Date.now();
  const cutoffMs = now - opts.windowMs;
  const grouped = new Map<string, { count: number; lastMs: number }>();
  for (const line of rawAuditLog.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.agent_name !== "string" || obj.agent_name !== opts.agentName) continue;
    if (typeof obj.result !== "string" || !obj.result.startsWith("denied")) continue;
    if (typeof obj.key !== "string") continue;
    const tsStr = typeof obj.ts === "string" ? obj.ts : null;
    const tsMs = tsStr ? Date.parse(tsStr) : NaN;
    if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
    // Sanity-check the key shape — only the same charset accepted on
    // the grant + audit flows. Defensive against a tampered log line.
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(obj.key)) continue;
    const prev = grouped.get(obj.key);
    if (prev) {
      prev.count += 1;
      if (tsMs > prev.lastMs) prev.lastMs = tsMs;
    } else {
      grouped.set(obj.key, { count: 1, lastMs: tsMs });
    }
  }
  return [...grouped.entries()]
    .map(([key, v]) => ({ key, count: v.count, lastSeenMs: v.lastMs }))
    .sort((a, b) => b.lastSeenMs - a.lastSeenMs)
    .slice(0, opts.limit);
}
