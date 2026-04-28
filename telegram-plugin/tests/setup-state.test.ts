/**
 * Tests for /setup wizard SQLite state (setup-state.ts).
 *
 * Uses bun:test (not vitest) because setup-state.ts imports bun:sqlite.
 * Run with: bun test telegram-plugin/tests/setup-state.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(tmpdir() + '/setup-state-test-')
  process.env.SWITCHROOM_FOREMAN_DIR = tmpDir
})

afterEach(async () => {
  const { _resetSetupDbForTest } = await import('../foreman/setup-state.js')
  _resetSetupDbForTest()
  delete process.env.SWITCHROOM_FOREMAN_DIR
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

function makeState(chatId = 'chat1') {
  const now = Date.now()
  return {
    chatId,
    step: 'asked-slug' as const,
    slug: null,
    persona: null,
    model: null,
    emoji: null,
    botToken: null,
    allowedUserId: null,
    startedAt: now,
    updatedAt: now,
  }
}

// ─── Round-trip: setSetupState + getSetupState ────────────────────────────

describe('setup-state: round-trip', () => {
  it('stores and retrieves initial state', async () => {
    const { setSetupState, getSetupState } = await import('../foreman/setup-state.js')
    const state = makeState()
    setSetupState(state)
    const retrieved = getSetupState('chat1')
    expect(retrieved).not.toBeNull()
    expect(retrieved?.step).toBe('asked-slug')
    expect(retrieved?.slug).toBeNull()
    expect(retrieved?.chatId).toBe('chat1')
  })

  it('returns null for unknown chatId', async () => {
    const { getSetupState } = await import('../foreman/setup-state.js')
    expect(getSetupState('nonexistent')).toBeNull()
  })

  it('upserts state on repeat setSetupState', async () => {
    const { setSetupState, getSetupState } = await import('../foreman/setup-state.js')
    const state = makeState()
    setSetupState(state)
    setSetupState({ ...state, step: 'asked-persona', slug: 'gymbro' })
    const retrieved = getSetupState('chat1')
    expect(retrieved?.step).toBe('asked-persona')
    expect(retrieved?.slug).toBe('gymbro')
  })

  it('stores all fields', async () => {
    const { setSetupState, getSetupState } = await import('../foreman/setup-state.js')
    const now = Date.now()
    setSetupState({
      chatId: 'chat2',
      step: 'asked-bot-token',
      slug: 'myagent',
      persona: 'My Agent',
      model: 'sonnet',
      emoji: '🤖',
      botToken: '1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxx',
      allowedUserId: '99999999',
      startedAt: now - 1000,
      updatedAt: now,
    })
    const retrieved = getSetupState('chat2')
    expect(retrieved?.slug).toBe('myagent')
    expect(retrieved?.persona).toBe('My Agent')
    expect(retrieved?.model).toBe('sonnet')
    expect(retrieved?.emoji).toBe('🤖')
    expect(retrieved?.botToken).toBe('1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxx')
    expect(retrieved?.allowedUserId).toBe('99999999')
  })
})

// ─── clearSetupState ──────────────────────────────────────────────────────

describe('setup-state: clearSetupState', () => {
  it('removes state for given chat', async () => {
    const { setSetupState, clearSetupState, getSetupState } = await import('../foreman/setup-state.js')
    setSetupState(makeState('chatA'))
    setSetupState(makeState('chatB'))
    clearSetupState('chatA')
    expect(getSetupState('chatA')).toBeNull()
    expect(getSetupState('chatB')).not.toBeNull()
  })

  it('is a no-op when chat has no state', async () => {
    const { clearSetupState, getSetupState } = await import('../foreman/setup-state.js')
    // Should not throw
    clearSetupState('nobody')
    expect(getSetupState('nobody')).toBeNull()
  })
})

// ─── listActiveSetupFlows ─────────────────────────────────────────────────

describe('setup-state: listActiveSetupFlows', () => {
  it('returns only non-done flows within maxAge', async () => {
    const { setSetupState, listActiveSetupFlows } = await import('../foreman/setup-state.js')
    const now = Date.now()

    setSetupState({ ...makeState('chat1'), step: 'asked-slug', updatedAt: now })
    setSetupState({ ...makeState('chat2'), step: 'done', updatedAt: now })
    setSetupState({ ...makeState('chat3'), step: 'asked-persona', updatedAt: now - 2 * 60 * 60 * 1000 }) // 2 hours old

    const active = listActiveSetupFlows(60 * 60 * 1000) // 1 hour
    expect(active.length).toBe(1)
    expect(active[0].chatId).toBe('chat1')
  })

  it('returns empty list when nothing active', async () => {
    const { listActiveSetupFlows } = await import('../foreman/setup-state.js')
    const active = listActiveSetupFlows()
    expect(active).toEqual([])
  })

  it('returns multiple active flows', async () => {
    const { setSetupState, listActiveSetupFlows } = await import('../foreman/setup-state.js')
    const now = Date.now()
    setSetupState({ ...makeState('c1'), updatedAt: now })
    setSetupState({ ...makeState('c2'), step: 'asked-persona', updatedAt: now })
    const active = listActiveSetupFlows()
    expect(active.length).toBe(2)
  })
})
