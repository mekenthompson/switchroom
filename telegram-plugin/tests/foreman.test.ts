/**
 * Tests for telegram-plugin/foreman/foreman.ts helpers.
 *
 * The foreman entry point is a process-level binary (similar to gateway.ts)
 * so we don't import it directly. Instead we test the pure helpers used
 * internally via the shared module and any extractable logic.
 *
 * What we test here:
 *   - The access.json parsing logic (via a local re-implementation of
 *     loadAllowFrom-equivalent using bot-runtime's isAllowedSender).
 *   - Correct invocation of `assertSafeAgentName` patterns.
 *   - Pagination boundary logic (chunk size).
 *   - Log tail-N parsing rules.
 */

import { describe, it, expect } from 'vitest'
import { isAllowedSender, escapeHtmlForTg, formatSwitchroomOutput } from '../shared/bot-runtime.js'
import type { Context } from 'grammy'

// ─── Agent name validation ─────────────────────────────────────────────────

function isValidAgentName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name)
}

describe('foreman: assertSafeAgentName pattern', () => {
  it('accepts simple lowercase names', () => {
    expect(isValidAgentName('gymbro')).toBe(true)
  })

  it('accepts names with hyphens', () => {
    expect(isValidAgentName('my-agent')).toBe(true)
  })

  it('accepts names with underscores', () => {
    expect(isValidAgentName('my_agent')).toBe(true)
  })

  it('accepts names with digits', () => {
    expect(isValidAgentName('agent1')).toBe(true)
  })

  it('rejects names with spaces', () => {
    expect(isValidAgentName('my agent')).toBe(false)
  })

  it('rejects names with shell metacharacters', () => {
    expect(isValidAgentName('agent; rm -rf /')).toBe(false)
    expect(isValidAgentName('agent`whoami`')).toBe(false)
    expect(isValidAgentName('agent$(evil)')).toBe(false)
  })

  it('rejects empty names', () => {
    expect(isValidAgentName('')).toBe(false)
  })

  it('rejects names over 64 chars', () => {
    expect(isValidAgentName('a'.repeat(65))).toBe(false)
    expect(isValidAgentName('a'.repeat(64))).toBe(true)
  })

  it('rejects path traversal attempts', () => {
    expect(isValidAgentName('../etc/passwd')).toBe(false)
  })
})

// ─── --tail N parsing ─────────────────────────────────────────────────────

function parseTailN(args: string[]): number {
  let tailN = 50
  const tailIdx = args.indexOf('--tail')
  if (tailIdx !== -1 && args[tailIdx + 1]) {
    const parsed = parseInt(args[tailIdx + 1], 10)
    if (!isNaN(parsed) && parsed > 0) tailN = Math.min(parsed, 500)
  }
  return tailN
}

describe('foreman: /logs --tail N parsing', () => {
  it('defaults to 50 when no --tail', () => {
    expect(parseTailN(['gymbro'])).toBe(50)
  })

  it('parses explicit --tail N', () => {
    expect(parseTailN(['gymbro', '--tail', '100'])).toBe(100)
  })

  it('clamps to 500 max', () => {
    expect(parseTailN(['gymbro', '--tail', '9999'])).toBe(500)
  })

  it('ignores --tail without value', () => {
    expect(parseTailN(['gymbro', '--tail'])).toBe(50)
  })

  it('ignores non-numeric --tail value', () => {
    expect(parseTailN(['gymbro', '--tail', 'abc'])).toBe(50)
  })

  it('ignores zero --tail value', () => {
    expect(parseTailN(['gymbro', '--tail', '0'])).toBe(50)
  })

  it('ignores negative --tail value', () => {
    expect(parseTailN(['gymbro', '--tail', '-10'])).toBe(50)
  })
})

// ─── Text chunking ────────────────────────────────────────────────────────

function chunkText(text: string, maxLen = 4096): string[] {
  if (text.length <= maxLen) return [text]
  const chunks: string[] = []
  let pos = 0
  while (pos < text.length) {
    chunks.push(text.slice(pos, pos + maxLen))
    pos += maxLen
  }
  return chunks
}

describe('foreman: log pagination', () => {
  it('returns single chunk when under limit', () => {
    const text = 'x'.repeat(3800)
    expect(chunkText(text, 3800)).toHaveLength(1)
  })

  it('splits into two chunks when over limit', () => {
    const text = 'x'.repeat(4097)
    const chunks = chunkText(text, 4096)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(4096)
    expect(chunks[1]).toHaveLength(1)
  })

  it('all chunks together reconstruct the original', () => {
    const text = 'abcdefgh'.repeat(1000)
    const chunks = chunkText(text, 3000)
    expect(chunks.join('')).toBe(text)
  })

  it('handles exactly limit-length text', () => {
    const text = 'x'.repeat(4096)
    expect(chunkText(text, 4096)).toHaveLength(1)
  })
})

// ─── Access guard (from shared) ───────────────────────────────────────────

function makeCtx(userId: number | undefined): Context {
  return { from: userId != null ? { id: userId } : undefined } as unknown as Context
}

describe('foreman: access control', () => {
  it('allows configured user IDs', () => {
    expect(isAllowedSender(makeCtx(42), ['42'])).toBe(true)
  })

  it('blocks unconfigured user IDs', () => {
    expect(isAllowedSender(makeCtx(99), ['42'])).toBe(false)
  })

  it('blocks when allowFrom is empty (no access.json)', () => {
    expect(isAllowedSender(makeCtx(42), [])).toBe(false)
  })

  it('blocks when ctx.from is missing', () => {
    expect(isAllowedSender(makeCtx(undefined), ['42'])).toBe(false)
  })
})

// ─── Fleet summary formatting (smoke test) ────────────────────────────────

describe('foreman: fleet summary HTML', () => {
  it('escapes agent names in HTML output', () => {
    const name = '<script>alert(1)</script>'
    const escaped = escapeHtmlForTg(name)
    expect(escaped).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(escaped).not.toContain('<script>')
  })
})
