/**
 * Tests for telegram-plugin/operator-events-history.ts — in-memory
 * per-agent OperatorEvent TTL store used by /status enrichment.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordOperatorEvent,
  getLastOperatorEvent,
  clearOperatorEventHistory,
  formatLastEventLine,
  EVENT_TTL_MS,
} from '../operator-events-history.js'
import type { OperatorEvent } from '../operator-events.js'

function makeEvent(agent: string, kind: OperatorEvent['kind'] = 'credentials-expired'): OperatorEvent {
  return {
    kind,
    agent,
    detail: `test detail for ${agent}`,
    suggestedActions: [],
    firstSeenAt: new Date('2026-04-24T12:00:00Z'),
  }
}

describe('operator-events-history', () => {
  beforeEach(() => {
    clearOperatorEventHistory()
  })

  describe('recordOperatorEvent + getLastOperatorEvent', () => {
    it('stores and retrieves the last event per agent', () => {
      const ev = makeEvent('gymbro')
      recordOperatorEvent(ev)
      expect(getLastOperatorEvent('gymbro')).toEqual(ev)
    })

    it('returns null for unknown agents', () => {
      expect(getLastOperatorEvent('unknown')).toBeNull()
    })

    it('overwrites a previous event for the same agent', () => {
      recordOperatorEvent(makeEvent('gymbro', 'credentials-expired'))
      const latest = makeEvent('gymbro', 'rate-limited')
      recordOperatorEvent(latest)
      expect(getLastOperatorEvent('gymbro')).toEqual(latest)
    })

    it('keeps separate slots per agent', () => {
      const a = makeEvent('gymbro', 'credentials-expired')
      const b = makeEvent('clerk', 'rate-limited')
      recordOperatorEvent(a)
      recordOperatorEvent(b)
      expect(getLastOperatorEvent('gymbro')).toEqual(a)
      expect(getLastOperatorEvent('clerk')).toEqual(b)
    })
  })

  describe('TTL expiry', () => {
    it('returns null when the stored event is older than TTL', () => {
      const now = 1_000_000
      recordOperatorEvent(makeEvent('gymbro'), now)
      const future = now + EVENT_TTL_MS + 1
      expect(getLastOperatorEvent('gymbro', future)).toBeNull()
    })

    it('returns the event when exactly at TTL boundary', () => {
      const now = 1_000_000
      recordOperatorEvent(makeEvent('gymbro'), now)
      expect(getLastOperatorEvent('gymbro', now + EVENT_TTL_MS)).not.toBeNull()
    })

    it('evicts expired events from the map on read', () => {
      const now = 1_000_000
      recordOperatorEvent(makeEvent('gymbro'), now)
      const future = now + EVENT_TTL_MS + 1
      getLastOperatorEvent('gymbro', future) // triggers eviction
      // Now a fresh read at `now` should still miss (row was evicted)
      expect(getLastOperatorEvent('gymbro', now)).toBeNull()
    })

    it('honors a custom TTL', () => {
      const now = 1_000_000
      recordOperatorEvent(makeEvent('gymbro'), now)
      const ttl = 60_000 // 1 min
      expect(getLastOperatorEvent('gymbro', now + ttl - 1, ttl)).not.toBeNull()
      expect(getLastOperatorEvent('gymbro', now + ttl + 1, ttl)).toBeNull()
    })
  })

  describe('clearOperatorEventHistory', () => {
    it('drops all stored events', () => {
      recordOperatorEvent(makeEvent('gymbro'))
      recordOperatorEvent(makeEvent('clerk'))
      clearOperatorEventHistory()
      expect(getLastOperatorEvent('gymbro')).toBeNull()
      expect(getLastOperatorEvent('clerk')).toBeNull()
    })
  })

  describe('formatLastEventLine', () => {
    it('returns null for agents with no event', () => {
      expect(formatLastEventLine('unknown')).toBeNull()
    })

    it('renders a single-line summary for fresh events', () => {
      recordOperatorEvent(makeEvent('gymbro', 'credentials-expired'))
      const line = formatLastEventLine('gymbro')
      expect(line).toContain('credentials-expired')
    })

    it('includes an age string', () => {
      recordOperatorEvent(makeEvent('gymbro', 'rate-limited'))
      const line = formatLastEventLine('gymbro')
      expect(line).toMatch(/\((\d+[smh]) ago\)/)
    })

    it('returns null for expired events', () => {
      const now = 1_000_000
      recordOperatorEvent(makeEvent('gymbro'), now)
      const future = now + EVENT_TTL_MS + 1
      expect(formatLastEventLine('gymbro', future)).toBeNull()
    })
  })
})
