/**
 * /setup wizard conversation state — SQLite-backed per-chat state.
 *
 * Survives foreman restarts so a wizard started before a restart can resume.
 *
 * Location: ~/.switchroom/foreman/state.sqlite (same DB as create_flow)
 * Override via SWITCHROOM_FOREMAN_DIR env var.
 *
 * Schema:
 *   CREATE TABLE IF NOT EXISTS setup_flow (
 *     chat_id         TEXT PRIMARY KEY,
 *     step            TEXT NOT NULL,
 *     slug            TEXT,
 *     persona         TEXT,
 *     model           TEXT,
 *     emoji           TEXT,
 *     bot_token       TEXT,
 *     allowed_user_id TEXT,
 *     started_at      INTEGER NOT NULL,
 *     updated_at      INTEGER NOT NULL
 *   );
 */

import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ─── Types ────────────────────────────────────────────────────────────────

export type SetupFlowStep =
  | 'asked-slug'
  | 'asked-persona'
  | 'asked-model'
  | 'asked-emoji'
  | 'asked-bot-token'
  | 'confirming-allowlist'
  | 'reconciling'
  | 'done'

export interface SetupFlowState {
  chatId: string
  step: SetupFlowStep
  slug: string | null
  persona: string | null
  model: string | null
  emoji: string | null
  botToken: string | null
  allowedUserId: string | null
  startedAt: number
  updatedAt: number
}

// ─── DB singleton ─────────────────────────────────────────────────────────

let _setupDb: Database | null = null

function getSetupDb(): Database {
  if (_setupDb) return _setupDb

  const foremanDir =
    process.env.SWITCHROOM_FOREMAN_DIR ?? join(homedir(), '.switchroom', 'foreman')

  mkdirSync(foremanDir, { recursive: true, mode: 0o700 })

  const dbPath = join(foremanDir, 'state.sqlite')
  _setupDb = new Database(dbPath)
  try {
    chmodSync(dbPath, 0o600)
  } catch {
    // best-effort
  }

  _setupDb.exec(`
    CREATE TABLE IF NOT EXISTS setup_flow (
      chat_id         TEXT PRIMARY KEY,
      step            TEXT NOT NULL,
      slug            TEXT,
      persona         TEXT,
      model           TEXT,
      emoji           TEXT,
      bot_token       TEXT,
      allowed_user_id TEXT,
      started_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
  `)

  return _setupDb
}

// ─── Row type ─────────────────────────────────────────────────────────────

interface SetupFlowRow {
  chat_id: string
  step: string
  slug: string | null
  persona: string | null
  model: string | null
  emoji: string | null
  bot_token: string | null
  allowed_user_id: string | null
  started_at: number
  updated_at: number
}

function rowToState(row: SetupFlowRow): SetupFlowState {
  return {
    chatId: row.chat_id,
    step: row.step as SetupFlowStep,
    slug: row.slug,
    persona: row.persona,
    model: row.model,
    emoji: row.emoji,
    botToken: row.bot_token,
    allowedUserId: row.allowed_user_id,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/** Upsert the setup wizard state for a given chat. */
export function setSetupState(state: SetupFlowState): void {
  const db = getSetupDb()
  db.prepare(`
    INSERT INTO setup_flow
      (chat_id, step, slug, persona, model, emoji, bot_token, allowed_user_id, started_at, updated_at)
    VALUES
      ($chatId, $step, $slug, $persona, $model, $emoji, $botToken, $allowedUserId, $startedAt, $updatedAt)
    ON CONFLICT(chat_id) DO UPDATE SET
      step            = excluded.step,
      slug            = excluded.slug,
      persona         = excluded.persona,
      model           = excluded.model,
      emoji           = excluded.emoji,
      bot_token       = excluded.bot_token,
      allowed_user_id = excluded.allowed_user_id,
      updated_at      = excluded.updated_at
  `).run({
    $chatId: state.chatId,
    $step: state.step,
    $slug: state.slug,
    $persona: state.persona,
    $model: state.model,
    $emoji: state.emoji,
    $botToken: state.botToken,
    $allowedUserId: state.allowedUserId,
    $startedAt: state.startedAt,
    $updatedAt: state.updatedAt,
  })
}

/** Retrieve the setup wizard state for a given chat, or null if none. */
export function getSetupState(chatId: string): SetupFlowState | null {
  const db = getSetupDb()
  const row = db.prepare<SetupFlowRow, [string]>(`
    SELECT chat_id, step, slug, persona, model, emoji, bot_token, allowed_user_id, started_at, updated_at
    FROM setup_flow
    WHERE chat_id = ?
  `).get(chatId)

  return row ? rowToState(row) : null
}

/** Remove the setup wizard state for a given chat. */
export function clearSetupState(chatId: string): void {
  const db = getSetupDb()
  db.prepare('DELETE FROM setup_flow WHERE chat_id = ?').run(chatId)
}

/**
 * List all in-progress setup flows updated within the last `maxAgeMs` ms.
 * Used at foreman startup to resume flows that survived a restart.
 */
export function listActiveSetupFlows(maxAgeMs = 60 * 60 * 1000): SetupFlowState[] {
  const db = getSetupDb()
  const cutoff = Date.now() - maxAgeMs
  const rows = db.prepare<SetupFlowRow, [number]>(`
    SELECT chat_id, step, slug, persona, model, emoji, bot_token, allowed_user_id, started_at, updated_at
    FROM setup_flow
    WHERE step != 'done' AND updated_at > ?
    ORDER BY updated_at DESC
  `).all(cutoff)

  return rows.map(rowToState)
}

/** Reset the DB singleton (useful in tests to avoid sharing state). */
export function _resetSetupDbForTest(): void {
  if (_setupDb) {
    _setupDb.close()
    _setupDb = null
  }
}
