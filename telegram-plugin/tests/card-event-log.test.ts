/**
 * Tests for the structured card-event logger — the audit trail for the
 * pinned progress card lifecycle. Mirrors `pin-event-log.test.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  logCardEvent,
  emitCardEvent,
  resolveCardEventPath,
  _resetForTests,
  type CardEvent,
} from '../card-event-log.js'

let tmpDir: string
const prevStateDir = process.env.STATE_DIR

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'card-event-log-'))
  _resetForTests()
})

afterEach(() => {
  _resetForTests()
  if (prevStateDir === undefined) delete process.env.STATE_DIR
  else process.env.STATE_DIR = prevStateDir
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('logCardEvent (injected writer)', () => {
  it('writes one JSON line per call', () => {
    const lines: string[] = []
    const ev: CardEvent = {
      ts: 1700000000000,
      agent: 'klanker',
      chatId: '100',
      turnKey: '100::1',
      cardMessageId: 4242,
      event: 'rendered',
      htmlHash: 'abc123def456',
    }
    logCardEvent(ev, (l) => lines.push(l))
    expect(lines).toHaveLength(1)
    expect(lines[0].endsWith('\n')).toBe(true)
    const payload = JSON.parse(lines[0].trimEnd())
    expect(payload).toEqual(ev)
  })

  it('omits undefined optional fields cleanly', () => {
    const lines: string[] = []
    logCardEvent(
      {
        ts: 1,
        agent: 'a',
        chatId: 'c',
        turnKey: 'c::1',
        event: 'finalized',
      },
      (l) => lines.push(l),
    )
    const raw = lines[0].trimEnd()
    expect(raw).not.toContain('undefined')
    const payload = JSON.parse(raw)
    expect(payload.cardMessageId).toBeUndefined()
    expect(payload.reason).toBeUndefined()
    expect(payload.subagents).toBeUndefined()
  })

  it('preserves subagents array and durationMs', () => {
    const lines: string[] = []
    logCardEvent(
      {
        ts: 2,
        agent: 'a',
        chatId: 'c',
        turnKey: 'c::1',
        event: 'deferred',
        reason: 'in-flight-sub-agents',
        subagents: ['agent-1', 'agent-2'],
        durationMs: 12345,
      },
      (l) => lines.push(l),
    )
    const payload = JSON.parse(lines[0].trimEnd())
    expect(payload.subagents).toEqual(['agent-1', 'agent-2'])
    expect(payload.durationMs).toBe(12345)
    expect(payload.reason).toBe('in-flight-sub-agents')
  })
})

describe('emitCardEvent', () => {
  it('fills ts when omitted', () => {
    const lines: string[] = []
    const before = Date.now()
    emitCardEvent(
      { agent: 'a', chatId: 'c', turnKey: 'c::1', event: 'edited' },
      (l) => lines.push(l),
    )
    const after = Date.now()
    const payload = JSON.parse(lines[0].trimEnd())
    expect(payload.ts).toBeGreaterThanOrEqual(before)
    expect(payload.ts).toBeLessThanOrEqual(after)
  })

  it('respects an explicit ts', () => {
    const lines: string[] = []
    emitCardEvent(
      { ts: 999, agent: 'a', chatId: 'c', turnKey: 'c::1', event: 'edited' },
      (l) => lines.push(l),
    )
    expect(JSON.parse(lines[0].trimEnd()).ts).toBe(999)
  })
})

describe('resolveCardEventPath', () => {
  it('returns <STATE_DIR>/card-events.jsonl when STATE_DIR is set', () => {
    expect(resolveCardEventPath({ STATE_DIR: '/tmp/x' })).toBe('/tmp/x/card-events.jsonl')
  })

  it('returns null when STATE_DIR is unset', () => {
    expect(resolveCardEventPath({})).toBeNull()
  })

  it('returns null when STATE_DIR is empty', () => {
    expect(resolveCardEventPath({ STATE_DIR: '' })).toBeNull()
  })
})

describe('default writer (filesystem)', () => {
  it('appends to <STATE_DIR>/card-events.jsonl when STATE_DIR is set', () => {
    process.env.STATE_DIR = tmpDir
    _resetForTests()
    emitCardEvent({ agent: 'a', chatId: 'c', turnKey: 'c::1', event: 'rendered' })
    emitCardEvent({ agent: 'a', chatId: 'c', turnKey: 'c::1', event: 'finalized' })
    const target = join(tmpDir, 'card-events.jsonl')
    expect(existsSync(target)).toBe(true)
    const contents = readFileSync(target, 'utf8').trimEnd().split('\n')
    expect(contents).toHaveLength(2)
    expect(JSON.parse(contents[0]).event).toBe('rendered')
    expect(JSON.parse(contents[1]).event).toBe('finalized')
  })
})
