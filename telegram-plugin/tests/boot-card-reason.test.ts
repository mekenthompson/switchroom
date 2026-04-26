/**
 * Unit tests for determineRestartReason() — the pure helper that decides
 * which restart reason to show in the boot card.
 *
 * Run with:
 *   bun test telegram-plugin/tests/boot-card-reason.test.ts
 */
import { describe, it, expect } from 'bun:test'
import { determineRestartReason } from '../gateway/boot-reason.js'

const NOW = 1_700_000_000_000 // arbitrary fixed timestamp

// ── Marker fixtures ────────────────────────────────────────────────────────

function recentMarker(offsetMs = 0) {
  return { ts: NOW - offsetMs }
}

function recentCleanMarker(offsetMs = 0) {
  return { ts: NOW - offsetMs }
}

function sessionMarker() {
  return { pid: 1234 }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('determineRestartReason', () => {
  it('returns "planned" when a restart marker is present and fresh (<5 min)', () => {
    const result = determineRestartReason({
      marker: recentMarker(10_000),     // 10s ago
      cleanMarker: null,
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    expect(result).toBe('planned')
  })

  it('returns "graceful" when clean-shutdown marker is present and fresh, no restart marker', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: recentCleanMarker(5_000),   // 5s ago, within 60s default
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    expect(result).toBe('graceful')
  })

  it('returns "crash" when session marker exists but no other markers', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: null,
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    expect(result).toBe('crash')
  })

  it('returns "fresh" when no markers exist at all (first ever start)', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: null,
      sessionMarker: null,
      now: NOW,
    })
    expect(result).toBe('fresh')
  })

  it('returns "crash" (not "graceful") when clean-shutdown marker is stale (>60s)', () => {
    const result = determineRestartReason({
      marker: null,
      cleanMarker: recentCleanMarker(90_000),  // 90s ago, stale
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    // stale clean-shutdown = marker too old to suppress crash detection
    expect(result).toBe('crash')
  })

  it('returns "planned" even when clean-shutdown marker is also present (planned wins)', () => {
    // Both present: planned restart marker takes priority
    const result = determineRestartReason({
      marker: recentMarker(3_000),
      cleanMarker: recentCleanMarker(3_000),
      sessionMarker: sessionMarker(),
      now: NOW,
    })
    expect(result).toBe('planned')
  })

  it('respects custom markerMaxAgeMs — stale marker does not count as planned', () => {
    const result = determineRestartReason({
      marker: recentMarker(10 * 60_000),  // 10 min ago
      cleanMarker: null,
      sessionMarker: sessionMarker(),
      now: NOW,
      markerMaxAgeMs: 5 * 60_000,          // 5 min window
    })
    // Marker is too old to be "planned", session marker present → crash
    expect(result).toBe('crash')
  })
})
