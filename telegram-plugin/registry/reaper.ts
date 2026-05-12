/**
 * Registry reaper — prunes long-lived `subagents` and `turns` rows.
 *
 * Issue #1073. The init-time prune in `history.ts` only sweeps the `messages`
 * table. `subagents` and `turns` in `registry.db` grew unbounded — a
 * long-running agent accumulates a row per `Agent()` call and per turn
 * forever. The SQLite WAL also grew without bound because no path issued
 * a checkpoint.
 *
 * This module adds:
 *
 *   - `pruneSubagentsOlderThan(db, cutoffMs, batchLimit)` — batch DELETE on
 *     `subagents` where `COALESCE(ended_at, last_activity_at, started_at)`
 *     is older than the cutoff. Batched so a huge backlog can't lock the
 *     DB for minutes; stops when a batch deletes 0 rows.
 *   - `pruneTurnsOlderThan(db, cutoffMs, batchLimit)` — same shape for
 *     `turns`, using `COALESCE(ended_at, started_at)`.
 *   - `runRegistryReaper(db, opts)` — one-shot orchestrator that runs both
 *     prunes, issues `PRAGMA wal_checkpoint(TRUNCATE)`, and returns counts.
 *
 * Timestamp model
 *   `subagents.started_at` / `last_activity_at` / `ended_at` and
 *   `turns.started_at` / `ended_at` are all unix MILLISECONDS (see
 *   subagents-schema.ts and turns-schema.ts), distinct from
 *   `messages.ts` which is unix SECONDS. Callers pass `cutoffMs`
 *   directly — no conversion is done here.
 *
 * Retention selection
 *   Default retention window is 14 days. Resolved by the gateway from:
 *     1. `process.env.HISTORY_RETENTION_DAYS` (integer days)
 *     2. `access.json:historyRetentionDays` (legacy: shared with the
 *        messages-table init prune)
 *     3. fallback constant `DEFAULT_RETENTION_DAYS = 14`
 *
 * Concurrency
 *   bun:sqlite holds the DB connection in WAL mode. Reader/writer
 *   concurrency is fine. The batch DELETE statements use short
 *   transactions so the gateway's record paths (recordSubagentStart,
 *   bumpSubagentActivity, recordTurnStart, recordTurnEnd) never block
 *   for more than a single batch's worth of work.
 *
 * Hard rules
 *   - Never touch the `messages` table from here. That table has its
 *     own (separately-configured) retention policy.
 *   - Bound the loop: every prune call must have a max-iteration safety
 *     so a runaway clock or schema-corruption bug can't spin forever.
 */

type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
  transaction(fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown
  close(): void
}

/** Default retention window for subagents + turns. */
export const DEFAULT_RETENTION_DAYS = 14

/** Default batch size — empirically a good ceiling for SQLite write
 *  transactions on a busy WAL. Tuneable by callers via `batchLimit`. */
export const DEFAULT_BATCH_LIMIT = 5000

/** Defence-in-depth ceiling on the batch-delete loop. At
 *  DEFAULT_BATCH_LIMIT this caps a single prune call at 5 million rows,
 *  far more than any healthy agent registry will ever hold. */
const MAX_BATCH_ITERATIONS = 1000

export interface PruneResult {
  /** Total rows deleted across all batches. */
  deleted: number
  /** Number of batch iterations executed. */
  batches: number
}

/**
 * Delete `subagents` rows whose latest-known activity is older than
 * `cutoffMs`. Activity is `COALESCE(ended_at, last_activity_at,
 * started_at)` — a row gets the most generous timestamp available,
 * so a still-running row that simply hasn't pinged liveness in 14d
 * is NOT pruned if its `last_activity_at` is recent.
 *
 * Batched: deletes up to `batchLimit` rows per iteration, looping until
 * a batch returns 0. Bounded by MAX_BATCH_ITERATIONS.
 */
export function pruneSubagentsOlderThan(
  db: SqliteDatabase,
  cutoffMs: number,
  batchLimit: number = DEFAULT_BATCH_LIMIT,
): PruneResult {
  // SQLite's DELETE ... LIMIT requires the SQLITE_ENABLE_UPDATE_DELETE_LIMIT
  // compile flag. bun:sqlite ships with it OFF, so a literal LIMIT clause
  // on DELETE fails parsing. Wrap with a sub-SELECT on rowid — that works
  // on every SQLite build and behaves identically. The same pattern is
  // used by pruneTurnsOlderThan below.
  const stmt = db.prepare(`
    DELETE FROM subagents
    WHERE rowid IN (
      SELECT rowid FROM subagents
      WHERE COALESCE(ended_at, last_activity_at, started_at) < ?
      LIMIT ?
    )
  `)
  let total = 0
  let batches = 0
  for (let i = 0; i < MAX_BATCH_ITERATIONS; i++) {
    const result = stmt.run(cutoffMs, batchLimit) as { changes: number }
    batches += 1
    const n = result.changes ?? 0
    total += n
    if (n === 0) break
  }
  return { deleted: total, batches }
}

/**
 * Delete `turns` rows whose latest-known activity is older than `cutoffMs`.
 * Activity is `COALESCE(ended_at, started_at)` — an open turn (ended_at
 * NULL) is preserved if its `started_at` is recent. Batched like
 * pruneSubagentsOlderThan.
 */
export function pruneTurnsOlderThan(
  db: SqliteDatabase,
  cutoffMs: number,
  batchLimit: number = DEFAULT_BATCH_LIMIT,
): PruneResult {
  const stmt = db.prepare(`
    DELETE FROM turns
    WHERE rowid IN (
      SELECT rowid FROM turns
      WHERE COALESCE(ended_at, started_at) < ?
      LIMIT ?
    )
  `)
  let total = 0
  let batches = 0
  for (let i = 0; i < MAX_BATCH_ITERATIONS; i++) {
    const result = stmt.run(cutoffMs, batchLimit) as { changes: number }
    batches += 1
    const n = result.changes ?? 0
    total += n
    if (n === 0) break
  }
  return { deleted: total, batches }
}

export interface RegistryReaperResult {
  subagents: PruneResult
  turns: PruneResult
  /** True if the WAL checkpoint ran without throwing. The result of the
   *  pragma is logged but not propagated (it can legitimately report
   *  "busy" under reader pressure — not a failure). */
  walCheckpointed: boolean
}

export interface RegistryReaperOpts {
  /** Retention window in days. */
  retentionDays?: number
  /** Override "now" for tests. Defaults to Date.now(). */
  now?: number
  /** Override batch size (mostly for tests). */
  batchLimit?: number
}

/**
 * Run the full registry reaper: prune subagents, prune turns, checkpoint
 * the WAL. Caller logs the result.
 */
export function runRegistryReaper(
  db: SqliteDatabase,
  opts: RegistryReaperOpts = {},
): RegistryReaperResult {
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS
  const now = opts.now ?? Date.now()
  const batchLimit = opts.batchLimit ?? DEFAULT_BATCH_LIMIT
  const cutoffMs = now - retentionDays * 86_400_000

  const subagents = pruneSubagentsOlderThan(db, cutoffMs, batchLimit)
  const turns = pruneTurnsOlderThan(db, cutoffMs, batchLimit)

  // WAL checkpoint releases the .db-wal file's pages back to the main DB
  // and truncates the WAL to zero bytes. TRUNCATE mode does both;
  // PASSIVE/FULL leave WAL pages behind. Wrap in try/catch — the
  // checkpoint can return SQLITE_BUSY under concurrent reads, which
  // bun:sqlite surfaces as a thrown error. That's a transient,
  // non-fatal condition: the next reaper tick will retry.
  let walCheckpointed = false
  try {
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run()
    walCheckpointed = true
  } catch {
    walCheckpointed = false
  }

  return { subagents, turns, walCheckpointed }
}

/**
 * Resolve the retention window in days from environment + access-file
 * sources. Order: env `HISTORY_RETENTION_DAYS` → `accessRetentionDays`
 * (caller passes whatever's in access.json) → `DEFAULT_RETENTION_DAYS`.
 *
 * Returns a clamped positive integer. Invalid env values (non-numeric,
 * <= 0, NaN) fall through to the access value, then to the default.
 */
export function resolveRetentionDays(accessRetentionDays?: number): number {
  const envRaw = process.env.HISTORY_RETENTION_DAYS
  if (envRaw != null && envRaw !== '') {
    const n = Number.parseInt(envRaw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  if (
    typeof accessRetentionDays === 'number'
    && Number.isFinite(accessRetentionDays)
    && accessRetentionDays > 0
  ) {
    return accessRetentionDays
  }
  return DEFAULT_RETENTION_DAYS
}
