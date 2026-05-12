/**
 * Pin the per-agent inbound buffer that closes the #1150 root cause:
 * if the gateway tries to deliver a synthetic inbound while the agent's
 * bridge isn't connected (mid-reconnect, claude-session bouncing, etc),
 * the inbound used to be silently dropped. Now it's buffered and
 * drained on the next bridge-register.
 */

import { describe, it, expect } from 'vitest'
import { createPendingInboundBuffer, DEFAULT_PENDING_INBOUND_CAP } from '../gateway/pending-inbound-buffer.js'
import type { InboundMessage } from '../gateway/ipc-protocol.js'

function inbound(source: string, ts = Date.now()): InboundMessage {
  return {
    type: 'inbound',
    chatId: 'c1',
    messageId: ts,
    user: 'vault-broker',
    userId: 0,
    ts,
    text: `synthetic ${source}`,
    meta: { source },
  }
}

describe('pending-inbound-buffer', () => {
  it('push + drain — FIFO order per agent', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('a', inbound('vault_grant_approved', 1))
    buf.push('a', inbound('cron', 2))
    buf.push('a', inbound('reaction', 3))
    const drained = buf.drain('a')
    expect(drained.map((m) => m.meta?.source)).toEqual([
      'vault_grant_approved',
      'cron',
      'reaction',
    ])
  })

  it('drain is idempotent — second call returns empty', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('a', inbound('x'))
    expect(buf.drain('a')).toHaveLength(1)
    expect(buf.drain('a')).toHaveLength(0)
  })

  it('drain only affects the named agent', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    buf.push('a', inbound('x'))
    buf.push('b', inbound('y'))
    expect(buf.drain('a').map((m) => m.meta?.source)).toEqual(['x'])
    expect(buf.depth('b')).toBe(1)
    expect(buf.drain('b').map((m) => m.meta?.source)).toEqual(['y'])
  })

  it('respects per-agent cap — oldest evicted when full', () => {
    const buf = createPendingInboundBuffer({ capPerAgent: 3, log: () => {} })
    // Push 1 .. 5; cap is 3 so 1, 2 should be evicted.
    buf.push('a', inbound('m1', 1))
    buf.push('a', inbound('m2', 2))
    buf.push('a', inbound('m3', 3))
    buf.push('a', inbound('m4', 4))
    buf.push('a', inbound('m5', 5))
    expect(buf.depth('a')).toBe(3)
    const drained = buf.drain('a')
    expect(drained.map((m) => m.meta?.source)).toEqual(['m3', 'm4', 'm5'])
  })

  it('push returns false when eviction occurred', () => {
    const buf = createPendingInboundBuffer({ capPerAgent: 2, log: () => {} })
    expect(buf.push('a', inbound('m1'))).toBe(true)
    expect(buf.push('a', inbound('m2'))).toBe(true)
    expect(buf.push('a', inbound('m3'))).toBe(false) // evicted m1
  })

  it('default cap is 32', () => {
    expect(DEFAULT_PENDING_INBOUND_CAP).toBe(32)
    const buf = createPendingInboundBuffer({ log: () => {} })
    for (let i = 0; i < 32; i++) buf.push('a', inbound(`m${i}`, i))
    expect(buf.depth('a')).toBe(32)
    buf.push('a', inbound('m33', 33))
    expect(buf.depth('a')).toBe(32) // still at cap
  })

  it('logs on eviction', () => {
    const logs: string[] = []
    const buf = createPendingInboundBuffer({ capPerAgent: 1, log: (l) => logs.push(l) })
    buf.push('a', inbound('m1', 1))
    buf.push('a', inbound('m2', 2)) // evicts m1
    expect(logs.some((l) => l.includes('cap=1') && l.includes('dropped oldest'))).toBe(true)
    expect(logs.some((l) => l.includes('m1'))).toBe(true)
  })

  it('logs on push (depth tracking visibility)', () => {
    const logs: string[] = []
    const buf = createPendingInboundBuffer({ log: (l) => logs.push(l) })
    buf.push('a', inbound('vault_grant_approved'))
    expect(logs.some((l) => l.includes('agent=a buffered source=vault_grant_approved depth_after=1'))).toBe(true)
  })

  it('logs on drain with source listing', () => {
    const logs: string[] = []
    const buf = createPendingInboundBuffer({ log: (l) => logs.push(l) })
    buf.push('a', inbound('vault_grant_approved'))
    buf.push('a', inbound('cron'))
    logs.length = 0
    buf.drain('a')
    expect(logs.some((l) => l.includes('drained agent=a count=2'))).toBe(true)
    expect(logs.some((l) => l.includes('sources=[vault_grant_approved,cron]'))).toBe(true)
  })

  it('drain on empty agent does not log', () => {
    const logs: string[] = []
    const buf = createPendingInboundBuffer({ log: (l) => logs.push(l) })
    expect(buf.drain('never-pushed')).toEqual([])
    expect(logs).toEqual([])
  })

  it('depth and totalDepth track correctly across agents', () => {
    const buf = createPendingInboundBuffer({ log: () => {} })
    expect(buf.totalDepth()).toBe(0)
    buf.push('a', inbound('x'))
    buf.push('a', inbound('y'))
    buf.push('b', inbound('z'))
    expect(buf.depth('a')).toBe(2)
    expect(buf.depth('b')).toBe(1)
    expect(buf.depth('c')).toBe(0)
    expect(buf.totalDepth()).toBe(3)
    buf.drain('a')
    expect(buf.totalDepth()).toBe(1)
  })
})
