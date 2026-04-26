/**
 * Unit tests for the shared card-format utilities.
 *
 * These functions are imported by both progress-card.ts and
 * subagent-watcher.ts to ensure consistent output across both status-card
 * surfaces.
 */
import { describe, it, expect } from 'vitest'
import { formatDuration, escapeHtml, truncate } from '../card-format.js'

describe('formatDuration', () => {
  it('returns Nms for sub-second values', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(1)).toBe('1ms')
    expect(formatDuration(500)).toBe('500ms')
    expect(formatDuration(999)).toBe('999ms')
  })

  it('returns 00:SS for values between 1s and 59s', () => {
    expect(formatDuration(1000)).toBe('00:01')
    expect(formatDuration(30_000)).toBe('00:30')
    expect(formatDuration(59_000)).toBe('00:59')
  })

  it('returns MM:SS for values >= 60s', () => {
    expect(formatDuration(60_000)).toBe('01:00')
    expect(formatDuration(90_000)).toBe('01:30')
    expect(formatDuration(3_600_000)).toBe('60:00')
  })

  it('output never contains raw angle brackets (HTML-safe)', () => {
    for (const ms of [0, 1, 500, 999, 1000, 30_000, 90_000]) {
      expect(formatDuration(ms)).not.toContain('<')
      expect(formatDuration(ms)).not.toContain('>')
    }
  })
})

describe('escapeHtml', () => {
  it('escapes &, <, and > characters', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b')
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;')
    expect(escapeHtml('a > b < c')).toBe('a &gt; b &lt; c')
  })

  it('leaves plain strings unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world')
    expect(escapeHtml('')).toBe('')
  })
})

describe('truncate', () => {
  it('returns the string unchanged when shorter than limit', () => {
    expect(truncate('hello', 10)).toBe('hello')
    expect(truncate('', 5)).toBe('')
  })

  it('truncates and appends ellipsis when over limit', () => {
    const result = truncate('hello world', 8)
    expect(result).toBe('hello w…')
    expect(result.length).toBe(8)
  })

  it('returns the string unchanged when exactly at limit', () => {
    expect(truncate('hello', 5)).toBe('hello')
  })
})
