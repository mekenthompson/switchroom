/**
 * At-least-once cron replay for the in-agent scheduler. On boot, the
 * scheduler scans the recent JSONL audit log and the past N minutes
 * of cron expression matches: any (entry, expected-fire-time) that
 * has no corresponding audit row gets replayed before the live cron
 * loop registers.
 *
 * Why: agents restart. If a container is down (image pull, host
 * reboot, scheduled rotation, OOM kill) across an 8am cron fire,
 * the fire is silently missed in a strict at-most-once setup. Phase
 * 4's at-least-once trade is "we'll occasionally fire a few minutes
 * late after a restart, but we won't silently drop your morning
 * briefing." Within the replay window only — fires older than that
 * are dropped on the floor (cron is not a queue and shouldn't pretend
 * to be one).
 *
 * The cron expression matcher is a small standalone parser that
 * matches node-cron's behaviour for the supported syntax: 5-field
 * expressions with wildcards, exact values, ranges (a-b), comma-
 * separated lists (a,b,c), and steps (a-b/N or wildcard/N) per
 * field. Day-of-week 7 normalises to 0 (both = Sunday). Day-of-month
 * + day-of-week interaction follows Vixie cron (OR when both are
 * restrictive, AND when either is `*`), matching node-cron's actual
 * behaviour.
 */

import type { DispatchResult } from "../scheduler/dispatch.js";
import type { SchedulerEntry } from "../scheduler/dispatch.js";

/**
 * Tolerance window when matching audit rows to expected fire times.
 * Audit rows are written at fire start; the "expected" time is a
 * round minute. Most fires record within a second, so 90s gives
 * generous slop without risk of double-counting two adjacent
 * minute-aligned fires.
 */
const AUDIT_TOLERANCE_MS = 90_000;

/** Standard cron-field range, per cron(5). */
type FieldKind = "minute" | "hour" | "dom" | "month" | "dow";
const FIELD_RANGES: Record<FieldKind, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dom: [1, 31],
  month: [1, 12],
  dow: [0, 6],
};

/**
 * Name aliases node-cron 3.x accepts in month + day-of-week fields
 * (#896). Case-insensitive. Substituted to numeric form before
 * `matchField` runs, so the parser stays integer-only.
 */
const MONTH_ALIASES: Record<string, string> = {
  JAN: "1", FEB: "2", MAR: "3", APR: "4", MAY: "5", JUN: "6",
  JUL: "7", AUG: "8", SEP: "9", OCT: "10", NOV: "11", DEC: "12",
};
const DOW_ALIASES: Record<string, string> = {
  SUN: "0", MON: "1", TUE: "2", WED: "3", THU: "4", FRI: "5", SAT: "6",
};

/**
 * Substitute month/dow name aliases (`JAN`, `MON`, etc.) with their
 * numeric equivalents. Operates on a single cron field; idempotent
 * for already-numeric input. Word-boundary regex so a stray `MON` in
 * a malformed expression doesn't cross-pollute adjacent characters.
 */
export function normalizeAliases(field: string, kind: FieldKind): string {
  const map = kind === "month" ? MONTH_ALIASES : kind === "dow" ? DOW_ALIASES : null;
  if (map == null) return field;
  return field.replace(/[A-Za-z]+/g, (token) => {
    const sub = map[token.toUpperCase()];
    return sub ?? token;
  });
}

/**
 * Returns true if `value` matches the cron field expression `field`.
 * Each field expression is a comma-separated list of parts; a value
 * matches the field iff it matches any part. Each part is one of:
 *   *           — any value in range
 *   N           — exact value
 *   A-B         — inclusive range
 *   A-B/S       — every Sth value within A-B
 *   *\/S         — every Sth value across the full range
 */
export function matchField(
  field: string,
  value: number,
  kind: FieldKind,
): boolean {
  const [min, max] = FIELD_RANGES[kind];
  for (const part of field.split(",")) {
    if (matchPart(part, value, min, max)) return true;
  }
  return false;
}

function matchPart(part: string, value: number, min: number, max: number): boolean {
  let core = part;
  let step = 1;
  const slash = part.indexOf("/");
  if (slash !== -1) {
    core = part.slice(0, slash);
    const stepN = Number.parseInt(part.slice(slash + 1), 10);
    if (!Number.isInteger(stepN) || stepN <= 0) return false;
    step = stepN;
  }
  let lo: number;
  let hi: number;
  if (core === "*") {
    lo = min;
    hi = max;
  } else if (core.includes("-")) {
    const dash = core.indexOf("-");
    const a = Number.parseInt(core.slice(0, dash), 10);
    const b = Number.parseInt(core.slice(dash + 1), 10);
    if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
    lo = a;
    hi = b;
  } else {
    const v = Number.parseInt(core, 10);
    if (!Number.isInteger(v)) return false;
    lo = v;
    hi = v;
  }
  if (lo < min || hi > max || lo > hi) return false;
  if (value < lo || value > hi) return false;
  return (value - lo) % step === 0;
}

/**
 * Match a 5-field cron expression against a Date. Day-of-week 7 and
 * day-of-week 0 both mean Sunday; the input expression is normalized
 * so a user who writes `0` or `7` gets the same behaviour. DOM and
 * DOW interact per Vixie cron: when either is `*`, matching is AND
 * across all five fields; when both are restrictive, matching is OR
 * for those two (with AND for the other three).
 */
export function cronMatchesDate(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [mField, hField, domField, moFieldRaw, dowFieldRaw] = fields as [
    string, string, string, string, string,
  ];
  // Substitute name aliases (JAN-DEC, SUN-SAT) before any other
  // normalization. node-cron 3.x accepts these for live fires; the
  // replay parser must too or boot replay is silently dropped (#896).
  const moField = normalizeAliases(moFieldRaw, "month");
  // Normalize 7 → 0 in dow AFTER alias substitution. Operators
  // sometimes write `0` (Sun-Sat) and sometimes `7` (Sun-Sat-Sun);
  // cron(5) accepts both.
  const dowField = normalizeAliases(dowFieldRaw, "dow").replace(/\b7\b/g, "0");

  const minuteOk = matchField(mField, date.getMinutes(), "minute");
  const hourOk = matchField(hField, date.getHours(), "hour");
  const monthOk = matchField(moField, date.getMonth() + 1, "month");
  if (!minuteOk || !hourOk || !monthOk) return false;

  const domOk = matchField(domField, date.getDate(), "dom");
  const dowOk = matchField(dowField, date.getDay(), "dow");

  // Vixie cron OR-rule: if both DOM and DOW are restrictive (not "*"),
  // either match suffices. Otherwise both must match (which, with one
  // of them being "*" returning true for any value, reduces to the
  // other being true).
  const domRestrictive = domField !== "*";
  const dowRestrictive = dowField !== "*";
  if (domRestrictive && dowRestrictive) {
    return domOk || dowOk;
  }
  return domOk && dowOk;
}

/** A missed fire identified during boot replay. */
export interface MissedFire {
  entry: SchedulerEntry;
  /** The minute-aligned timestamp the fire would have happened at. */
  expectedFireMs: number;
}

/**
 * Walk back `windowMinutes` minutes minute-by-minute from `now`. For
 * each entry, identify the most recent past minute whose cron
 * expression matched and which has NO corresponding audit row. Returns
 * at most one missed fire per entry — we don't try to backfill a long
 * outage's worth of misses, only the most recent miss.
 *
 * Pure function: no IO. The caller passes recent audit rows (already
 * read from the JSONL) and the current time; the helper does the
 * arithmetic and matching.
 */
export function findMissedFires(opts: {
  entries: SchedulerEntry[];
  recentFires: DispatchResult[];
  now: Date;
  windowMinutes: number;
}): MissedFire[] {
  const out: MissedFire[] = [];
  const nowMs = opts.now.getTime();
  // Index audit rows by (agent, scheduleIndex) for O(1) lookup per
  // candidate minute, then within each bucket sort by startedAt
  // descending — most-recent-first lookups are common.
  const auditByKey = new Map<string, number[]>();
  for (const row of opts.recentFires) {
    // Only successful fires count as "happened" — a row with
    // exitCode=-1 means the gateway wasn't connected, the bridge
    // never saw the inbound, so the fire is still a miss. Replaying
    // until we get a successful audit is the at-least-once contract.
    if (row.exitCode !== 0) continue;
    const key = `${row.agent}::${row.scheduleIndex}`;
    let bucket = auditByKey.get(key);
    if (!bucket) {
      bucket = [];
      auditByKey.set(key, bucket);
    }
    bucket.push(row.startedAt);
  }
  for (const bucket of auditByKey.values()) bucket.sort((a, b) => b - a);

  for (const entry of opts.entries) {
    const key = `${entry.agent}::${entry.scheduleIndex}`;
    const audits = auditByKey.get(key) ?? [];
    // Walk back minute-by-minute from "this minute" (zeroed seconds).
    // The current minute is included — if the agent restarted during
    // its own scheduled fire, that fire is the prime replay candidate.
    const baseMs = nowMs - (nowMs % 60_000);
    for (let i = 0; i < opts.windowMinutes; i++) {
      const candidateMs = baseMs - i * 60_000;
      const candidate = new Date(candidateMs);
      if (!cronMatchesDate(entry.cron, candidate)) continue;
      // First match wins — most recent miss only.
      const hasAudit = audits.some(
        (ts) => Math.abs(ts - candidateMs) <= AUDIT_TOLERANCE_MS,
      );
      if (!hasAudit) {
        out.push({ entry, expectedFireMs: candidateMs });
      }
      break;
    }
  }
  return out;
}

/**
 * Read the most recent N audit rows from a JSONL file. Returns an
 * empty array if the file doesn't exist (first boot of a fresh agent).
 * Lines are tab/space-tolerant; malformed JSON is silently skipped.
 *
 * We only need rows within the replay window, so the caller can pre-
 * filter aggressively — but reading the whole file is fine for
 * realistic ledger sizes (a year of hourly schedules is ~9000 rows
 * at a few hundred bytes each).
 */
export function readRecentFires(jsonlPath: string): DispatchResult[] {
  // Lazy require so unit tests can mock fs without the side-effect.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  if (!fs.existsSync(jsonlPath)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return [];
  }
  const out: DispatchResult[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed) as DispatchResult);
    } catch {
      // Corrupt line — skip; next boot will append cleanly.
    }
  }
  return out;
}
