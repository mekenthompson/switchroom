/**
 * Pin the InboundMessage shapes the gateway synthesizes when the
 * operator taps Approve / Deny on a `vault_request_access` card
 * (#1052 / #1150). A regression that drops a `meta.source` field, or
 * changes the source string, would silently break the agent's wake-
 * up — the bridge wouldn't recognize the source, the message would
 * render as a generic channel event, and the model wouldn't know it
 * was an approval response.
 *
 * These tests are the cheap regression guard. The wire shape is
 * load-bearing — downstream filters / dashboards / future replay
 * tooling may anchor on individual meta fields.
 */

import { describe, it, expect } from 'vitest'
import {
  buildVaultGrantApprovedInbound,
  buildVaultGrantDeniedInbound,
  type VaultGrantInboundContext,
} from '../gateway/vault-grant-inbound-builders.js'

const FIXED_NOW = 1_700_000_000_000

const CTX_READ: VaultGrantInboundContext = {
  agent: 'gymbro',
  key: 'fatsecret/credentials',
  scope: 'read',
  chat_id: '8248703757',
  ttl_seconds: 30 * 86400,
}

const CTX_WRITE: VaultGrantInboundContext = {
  ...CTX_READ,
  key: 'analytics/api-token',
  scope: 'write',
  ttl_seconds: 7 * 86400,
}

describe('buildVaultGrantApprovedInbound', () => {
  it('emits the canonical envelope (type, chat_id, user, userId, ts, messageId)', () => {
    const msg = buildVaultGrantApprovedInbound({
      ctx: CTX_READ,
      grantId: 'vg_a1b2c3',
      stageId: 'stage-001',
      operatorId: '8248703757',
      nowMs: FIXED_NOW,
    })
    expect(msg.type).toBe('inbound')
    expect(msg.chatId).toBe('8248703757')
    expect(msg.user).toBe('vault-broker')
    expect(msg.userId).toBe(0)
    expect(msg.ts).toBe(FIXED_NOW)
    // messageId is synthetic — pin that it equals ts so the gateway
    // can produce a stable id under fake-clock tests without colliding
    // with real Telegram messageIds.
    expect(msg.messageId).toBe(FIXED_NOW)
  })

  it('pins meta.source = "vault_grant_approved" — load-bearing for the bridge', () => {
    const msg = buildVaultGrantApprovedInbound({
      ctx: CTX_READ,
      grantId: 'vg_x',
      stageId: 's',
      operatorId: '1',
    })
    expect(msg.meta?.source).toBe('vault_grant_approved')
  })

  it('carries all forensic fields in meta', () => {
    const msg = buildVaultGrantApprovedInbound({
      ctx: CTX_READ,
      grantId: 'vg_a1b2c3',
      stageId: 'stage-001',
      operatorId: '8248703757',
    })
    expect(msg.meta).toEqual({
      source: 'vault_grant_approved',
      agent: 'gymbro',
      key: 'fatsecret/credentials',
      scope: 'read',
      grant_id: 'vg_a1b2c3',
      stage_id: 'stage-001',
      operator_id: '8248703757',
    })
  })

  it('text names the key, scope, ttl-in-days, and grant id', () => {
    const msg = buildVaultGrantApprovedInbound({
      ctx: CTX_READ,
      grantId: 'vg_a1b2c3',
      stageId: 's',
      operatorId: '1',
    })
    expect(msg.text).toContain('approved')
    expect(msg.text).toContain('`fatsecret/credentials`')
    expect(msg.text).toContain('scope=read')
    expect(msg.text).toContain('30d')
    expect(msg.text).toContain('grant=vg_a1b2c3')
    // Instructional: tells the agent how to recover the value.
    expect(msg.text).toContain('switchroom vault get')
  })

  it('rounds ttl_seconds to days', () => {
    const ctx7d: VaultGrantInboundContext = { ...CTX_READ, ttl_seconds: 7 * 86400 }
    const msg = buildVaultGrantApprovedInbound({
      ctx: ctx7d,
      grantId: 'vg_x',
      stageId: 's',
      operatorId: '1',
    })
    expect(msg.text).toContain('7d')
  })

  it('honors write scope in text + meta', () => {
    const msg = buildVaultGrantApprovedInbound({
      ctx: CTX_WRITE,
      grantId: 'vg_x',
      stageId: 's',
      operatorId: '1',
    })
    expect(msg.text).toContain('scope=write')
    expect(msg.meta?.scope).toBe('write')
  })

  it('defaults nowMs to Date.now() when omitted', () => {
    const before = Date.now()
    const msg = buildVaultGrantApprovedInbound({
      ctx: CTX_READ,
      grantId: 'vg_x',
      stageId: 's',
      operatorId: '1',
    })
    const after = Date.now()
    expect(msg.ts).toBeGreaterThanOrEqual(before)
    expect(msg.ts).toBeLessThanOrEqual(after)
    expect(msg.messageId).toBe(msg.ts)
  })
})

describe('buildVaultGrantDeniedInbound', () => {
  it('pins meta.source = "vault_grant_denied" — the deny-side wake-up was added in #1156', () => {
    const msg = buildVaultGrantDeniedInbound({
      ctx: CTX_READ,
      stageId: 's',
      operatorId: '1',
    })
    expect(msg.meta?.source).toBe('vault_grant_denied')
  })

  it('omits grant_id (denial never mints a grant)', () => {
    const msg = buildVaultGrantDeniedInbound({
      ctx: CTX_READ,
      stageId: 'stage-001',
      operatorId: '8248703757',
    })
    expect(msg.meta).toEqual({
      source: 'vault_grant_denied',
      agent: 'gymbro',
      key: 'fatsecret/credentials',
      scope: 'read',
      stage_id: 'stage-001',
      operator_id: '8248703757',
    })
    expect((msg.meta as { grant_id?: string }).grant_id).toBeUndefined()
  })

  it('text steers toward a fallback path', () => {
    const msg = buildVaultGrantDeniedInbound({
      ctx: CTX_READ,
      stageId: 's',
      operatorId: '1',
    })
    expect(msg.text).toContain('denied')
    expect(msg.text).toContain('`fatsecret/credentials`')
    expect(msg.text).toContain('fallback')
    // The "DO NOT re-request" line is load-bearing UX — prevents the
    // model from spam-tapping a fresh request immediately after a
    // deny. Pin it.
    expect(msg.text).toMatch(/Do NOT re-request/)
  })

  it('shares envelope shape with the approve builder (type, user, chat)', () => {
    const denied = buildVaultGrantDeniedInbound({
      ctx: CTX_READ,
      stageId: 's',
      operatorId: '1',
      nowMs: FIXED_NOW,
    })
    expect(denied.type).toBe('inbound')
    expect(denied.user).toBe('vault-broker')
    expect(denied.userId).toBe(0)
    expect(denied.chatId).toBe('8248703757')
    expect(denied.ts).toBe(FIXED_NOW)
    expect(denied.messageId).toBe(FIXED_NOW)
  })
})

describe('approve vs deny shape invariants', () => {
  it('both emit type=inbound, user=vault-broker — bridge anchors on these', () => {
    const approve = buildVaultGrantApprovedInbound({
      ctx: CTX_READ, grantId: 'g', stageId: 's', operatorId: '1',
    })
    const deny = buildVaultGrantDeniedInbound({
      ctx: CTX_READ, stageId: 's', operatorId: '1',
    })
    for (const m of [approve, deny]) {
      expect(m.type).toBe('inbound')
      expect(m.user).toBe('vault-broker')
      expect(m.userId).toBe(0)
    }
  })

  it('source strings are disjoint — no shared substring that could route both to the same handler', () => {
    const approve = buildVaultGrantApprovedInbound({
      ctx: CTX_READ, grantId: 'g', stageId: 's', operatorId: '1',
    })
    const deny = buildVaultGrantDeniedInbound({
      ctx: CTX_READ, stageId: 's', operatorId: '1',
    })
    expect(approve.meta?.source).not.toBe(deny.meta?.source)
    // Defensive: a fuzzy match like `meta.source.includes('approve')`
    // shouldn't accidentally fire on the deny side. Pin the prefixes.
    expect(String(approve.meta?.source)).toMatch(/^vault_grant_approved$/)
    expect(String(deny.meta?.source)).toMatch(/^vault_grant_denied$/)
  })
})
