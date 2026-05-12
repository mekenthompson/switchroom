/**
 * Tests for the history reaper (#1073).
 *
 * Covers:
 *   - `pruneSubagentsOlderThan` / `pruneTurnsOlderThan` correctness:
 *     rows below the cutoff are deleted, rows above are preserved,
 *     coalesce semantics (ended_at | last_activity_at | started_at)
 *     are honored.
 *   - Batch-loop bounded scan: 6000-row backlog drains across multiple
 *     batches when batchLimit=2000.
 *   - WAL checkpoint runs (file-backed DB; assert .db-wal exists and
 *     shrinks, or at least that checkpoint reports success).
 *   - `resolveRetentionDays`: env > access > default precedence, plus
 *     guards against invalid env values.
 *   - `pruneMessagesOlderThanDays` on the history DB respects the
 *     batch cap and preserves recent rows.
 *
 * Runs under bun (uses bun:sqlite via the schema modules' lazy loader).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  pruneSubagentsOlderThan,
  pruneTurnsOlderThan,
  runRegistryReaper,
  resolveRetentionDays,
  DEFAULT_RETENTION_DAYS,
} from '../registry/reaper.js'
import {
  openSubagentsDbInMemory,
  recordSubagentStart,
} from '../registry/subagents-schema.js'
import {
  initHistory,
  recordInbound,
  pruneMessagesOlderThanDays,
  query as queryHistory,
  _resetForTests as resetHistory,
} from '../history.js'

// `bun:sqlite` for direct file-backed DB tests (WAL inspection).
// Same lazy-load pattern as the schemas use, but inline here.
type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
  }
  close(): void
}
type SqliteDatabaseCtor = new (path: string, opts?: { create?: boolean }) => SqliteDatabase
function bunSqlite(): SqliteDatabaseCtor {
  const metaRequire = (import.meta as { require?: (id: string) => unknown }).require
  if (typeof metaRequire !== 'function') throw new Error('bun runtime required')
  const mod = metaRequire('bun:sqlite') as { Database: SqliteDatabaseCtor }
  return mod.Database
}

const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// pruneSubagentsOlderThan
// ---------------------------------------------------------------------------

describe('pruneSubagentsOlderThan', () => {
  it('deletes rows older than the cutoff and preserves recent ones', () => {
    const db = openSubagentsDbInMemory()
    const now = 1_000_000_000_000
    // Three rows: 30 days ago, 5 days ago, 1 day ago.
    recordSubagentStart(db, { id: 'old', background: true, startedAt: now - 30 * DAY_MS })
    recordSubagentStart(db, { id: 'mid', background: true, startedAt: now - 5 * DAY_MS })
    recordSubagentStart(db, { id: 'new', background: true, startedAt: now - 1 * DAY_MS })

    // Cutoff: 14 days ago. Only `old` should go.
    const cutoff = now - 14 * DAY_MS
    const result = pruneSubagentsOlderThan(db, cutoff)
    expect(result.deleted).toBe(1)

    const remaining = db.prepare('SELECT id FROM subagents ORDER BY started_at').all() as Array<{ id: string }>
    expect(remaining.map((r) => r.id)).toEqual(['mid', 'new'])
  })

  it('uses COALESCE(ended_at, last_activity_at, started_at)', () => {
    const db = openSubagentsDbInMemory()
    const now = 1_000_000_000_000
    // started_at is ancient but last_activity_at is recent — should NOT prune.
    recordSubagentStart(db, { id: 'still-active', background: true, startedAt: now - 60 * DAY_MS })
    db.prepare('UPDATE subagents SET last_activity_at = ? WHERE id = ?').run(now - 2 * DAY_MS, 'still-active')

    // started_at + last_activity_at ancient but ended_at recent — should NOT prune.
    recordSubagentStart(db, { id: 'recent-end', background: true, startedAt: now - 60 * DAY_MS })
    db.prepare('UPDATE subagents SET last_activity_at = ?, ended_at = ?, status = ? WHERE id = ?')
      .run(now - 50 * DAY_MS, now - 2 * DAY_MS, 'completed', 'recent-end')

    // Truly old — all three timestamps are ancient.
    recordSubagentStart(db, { id: 'truly-old', background: true, startedAt: now - 60 * DAY_MS })
    db.prepare('UPDATE subagents SET last_activity_at = ?, ended_at = ?, status = ? WHERE id = ?')
      .run(now - 59 * DAY_MS, now - 58 * DAY_MS, 'completed', 'truly-old')

    const cutoff = now - 14 * DAY_MS
    const result = pruneSubagentsOlderThan(db, cutoff)
    expect(result.deleted).toBe(1)

    const ids = (db.prepare('SELECT id FROM subagents ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id)
    expect(ids).toEqual(['recent-end', 'still-active'])
  })

  it('batches a large backlog and drains it across iterations', () => {
    const db = openSubagentsDbInMemory()
    const now = 1_000_000_000_000
    const insert = db.prepare(`
      INSERT INTO subagents
        (id, background, started_at, last_activity_at, status)
      VALUES (?, 1, ?, ?, 'running')
    `)
    const tx = (db as unknown as { transaction: (fn: (n: number) => void) => (n: number) => void })
      .transaction((n: number) => {
        for (let i = 0; i < n; i++) {
          insert.run(`old-${i}`, now - 30 * DAY_MS, now - 30 * DAY_MS)
        }
      })
    tx(6000)
    // Plus 50 recent rows.
    for (let i = 0; i < 50; i++) {
      insert.run(`new-${i}`, now - 1 * DAY_MS, now - 1 * DAY_MS)
    }

    const cutoff = now - 14 * DAY_MS
    const result = pruneSubagentsOlderThan(db, cutoff, 2000)
    expect(result.deleted).toBe(6000)
    // 6000 / 2000 = 3 full batches + a final 0-row sentinel batch.
    expect(result.batches).toBeGreaterThanOrEqual(3)

    const remaining = db.prepare('SELECT COUNT(*) as c FROM subagents').get() as { c: number }
    expect(remaining.c).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// pruneTurnsOlderThan
// ---------------------------------------------------------------------------

describe('pruneTurnsOlderThan', () => {
  it('deletes turns older than the cutoff, preserves recent and open turns', () => {
    const db = openSubagentsDbInMemory()
    const now = 1_000_000_000_000

    const insert = db.prepare(`
      INSERT INTO turns
        (turn_key, chat_id, started_at, ended_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    // ancient + ended → prune
    insert.run('old-ended', '-100', now - 60 * DAY_MS, now - 59 * DAY_MS, now - 60 * DAY_MS, now - 59 * DAY_MS)
    // ancient + open → COALESCE falls through to started_at, also prunes
    insert.run('old-open', '-100', now - 60 * DAY_MS, null, now - 60 * DAY_MS, now - 60 * DAY_MS)
    // recent + ended → preserve
    insert.run('recent', '-100', now - 1 * DAY_MS, now - 1 * DAY_MS, now - 1 * DAY_MS, now - 1 * DAY_MS)
    // ancient started but ended recently → COALESCE picks ended_at, preserves
    insert.run('long-running', '-100', now - 60 * DAY_MS, now - 1 * DAY_MS, now - 60 * DAY_MS, now - 1 * DAY_MS)

    const cutoff = now - 14 * DAY_MS
    const result = pruneTurnsOlderThan(db, cutoff)
    expect(result.deleted).toBe(2)

    const keys = (db.prepare('SELECT turn_key FROM turns ORDER BY turn_key').all() as Array<{ turn_key: string }>).map((r) => r.turn_key)
    expect(keys).toEqual(['long-running', 'recent'])
  })
})

// ---------------------------------------------------------------------------
// runRegistryReaper + WAL checkpoint
// ---------------------------------------------------------------------------

describe('runRegistryReaper', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'reaper-test-'))
  })

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  })

  it('prunes both tables and reports a successful WAL checkpoint', () => {
    const Database = bunSqlite()
    const dbPath = join(tmpDir, 'registry.db')
    const db = new Database(dbPath, { create: true })
    db.exec('PRAGMA journal_mode = WAL')
    // Apply both schemas inline (mirrors openTurnsDb + applySubagentsSchema).
    db.exec(`
      CREATE TABLE turns (
        turn_key TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        thread_id TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        ended_via TEXT,
        last_assistant_msg_id TEXT,
        last_assistant_done INTEGER,
        last_user_msg_id TEXT,
        user_prompt_preview TEXT,
        assistant_reply_preview TEXT,
        tool_call_count INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE subagents (
        id TEXT PRIMARY KEY,
        parent_session_id TEXT,
        parent_turn_key TEXT,
        agent_type TEXT,
        description TEXT,
        background INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER,
        ended_at INTEGER,
        status TEXT NOT NULL,
        result_summary TEXT,
        jsonl_agent_id TEXT
      );
    `)

    const now = Date.now()
    db.prepare(`
      INSERT INTO subagents (id, background, started_at, last_activity_at, status)
      VALUES ('old', 1, ?, ?, 'running')
    `).run(now - 30 * DAY_MS, now - 30 * DAY_MS)
    db.prepare(`
      INSERT INTO turns (turn_key, chat_id, started_at, ended_at, created_at, updated_at)
      VALUES ('old-turn', '-1', ?, ?, ?, ?)
    `).run(now - 30 * DAY_MS, now - 30 * DAY_MS, now - 30 * DAY_MS, now - 30 * DAY_MS)

    // Force some WAL activity before the checkpoint so there's something to flush.
    db.prepare(`INSERT INTO turns (turn_key, chat_id, started_at, created_at, updated_at) VALUES ('recent', '-1', ?, ?, ?)`)
      .run(now, now, now)

    const walPath = `${dbPath}-wal`
    expect(existsSync(walPath)).toBe(true)
    const walSizeBefore = statSync(walPath).size
    expect(walSizeBefore).toBeGreaterThan(0)

    const result = runRegistryReaper(db, { retentionDays: 14, now })
    expect(result.subagents.deleted).toBe(1)
    expect(result.turns.deleted).toBe(1)
    expect(result.walCheckpointed).toBe(true)

    // After TRUNCATE checkpoint, the WAL file is truncated to zero bytes.
    // (Strict equality may vary across SQLite builds, but the post-truncate
    // size must be strictly less than the pre-truncate size.)
    const walSizeAfter = statSync(walPath).size
    expect(walSizeAfter).toBeLessThan(walSizeBefore)

    db.close()
  })
})

// ---------------------------------------------------------------------------
// resolveRetentionDays
// ---------------------------------------------------------------------------

describe('resolveRetentionDays', () => {
  const savedEnv = process.env.HISTORY_RETENTION_DAYS

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.HISTORY_RETENTION_DAYS
    else process.env.HISTORY_RETENTION_DAYS = savedEnv
  })

  it('returns DEFAULT_RETENTION_DAYS when nothing is set', () => {
    delete process.env.HISTORY_RETENTION_DAYS
    expect(resolveRetentionDays()).toBe(DEFAULT_RETENTION_DAYS)
    expect(DEFAULT_RETENTION_DAYS).toBe(14)
  })

  it('prefers env over access', () => {
    process.env.HISTORY_RETENTION_DAYS = '1'
    expect(resolveRetentionDays(30)).toBe(1)
  })

  it('falls back to access when env is missing', () => {
    delete process.env.HISTORY_RETENTION_DAYS
    expect(resolveRetentionDays(7)).toBe(7)
  })

  it('rejects invalid env values', () => {
    process.env.HISTORY_RETENTION_DAYS = 'abc'
    expect(resolveRetentionDays(7)).toBe(7)
    process.env.HISTORY_RETENTION_DAYS = '0'
    expect(resolveRetentionDays(7)).toBe(7)
    process.env.HISTORY_RETENTION_DAYS = '-5'
    expect(resolveRetentionDays(7)).toBe(7)
  })

  it('rejects invalid access values', () => {
    delete process.env.HISTORY_RETENTION_DAYS
    expect(resolveRetentionDays(0)).toBe(DEFAULT_RETENTION_DAYS)
    expect(resolveRetentionDays(-1)).toBe(DEFAULT_RETENTION_DAYS)
    expect(resolveRetentionDays(NaN)).toBe(DEFAULT_RETENTION_DAYS)
  })
})

// ---------------------------------------------------------------------------
// history.ts: pruneMessagesOlderThanDays
// ---------------------------------------------------------------------------

describe('pruneMessagesOlderThanDays', () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'history-reaper-test-'))
    initHistory(stateDir, 0) // 0 disables the init-time prune so we can seed cleanly
  })

  afterEach(() => {
    resetHistory()
    if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true })
  })

  it('deletes only messages older than retentionDays', () => {
    const nowSec = 2_000_000_000
    // Old (60d ago), borderline (15d ago), recent (1d ago).
    recordInbound({
      chat_id: '-100', thread_id: null, message_id: 1, user: 'u', user_id: '1',
      ts: nowSec - 60 * 86400, text: 'old',
    })
    recordInbound({
      chat_id: '-100', thread_id: null, message_id: 2, user: 'u', user_id: '1',
      ts: nowSec - 15 * 86400, text: 'mid',
    })
    recordInbound({
      chat_id: '-100', thread_id: null, message_id: 3, user: 'u', user_id: '1',
      ts: nowSec - 1 * 86400, text: 'new',
    })

    const deleted = pruneMessagesOlderThanDays(14, nowSec)
    expect(deleted).toBe(2)

    const remaining = queryHistory({ chat_id: '-100' })
    expect(remaining.map((r) => r.text)).toEqual(['new'])
  })

  it('batches a >5k backlog and drains it', () => {
    const nowSec = 2_000_000_000
    for (let i = 0; i < 6000; i++) {
      recordInbound({
        chat_id: '-100', thread_id: null, message_id: i + 1, user: 'u', user_id: '1',
        ts: nowSec - 60 * 86400, text: `old-${i}`,
      })
    }
    for (let i = 0; i < 30; i++) {
      recordInbound({
        chat_id: '-100', thread_id: null, message_id: 100_000 + i, user: 'u', user_id: '1',
        ts: nowSec - 1 * 86400, text: `new-${i}`,
      })
    }
    const deleted = pruneMessagesOlderThanDays(14, nowSec, 2000)
    expect(deleted).toBe(6000)
    const remaining = queryHistory({ chat_id: '-100', limit: 50 })
    expect(remaining.length).toBe(30)
  })

  it('respects retentionDays <= 0 as disabled', () => {
    const nowSec = 2_000_000_000
    recordInbound({
      chat_id: '-100', thread_id: null, message_id: 1, user: 'u', user_id: '1',
      ts: nowSec - 60 * 86400, text: 'old',
    })
    expect(pruneMessagesOlderThanDays(0, nowSec)).toBe(0)
    expect(pruneMessagesOlderThanDays(-1, nowSec)).toBe(0)
    expect(queryHistory({ chat_id: '-100' })).toHaveLength(1)
  })
})
