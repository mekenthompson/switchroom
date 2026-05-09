/**
 * Validation contract for the Phase 2 cron-fold-in `inject_inbound`
 * IPC message — the wire envelope the in-agent scheduler sibling
 * uses to ask the gateway to forward a synthesized InboundMessage to
 * a registered bridge.
 *
 * The gateway's `validateClientMessage` is the security boundary on
 * the client→gateway direction. The wrapped `inbound` payload is
 * forwarded verbatim to the bridge as a `type: "inbound"` envelope —
 * the bridge's validateGatewayMessage runs on the other end and is
 * lenient (only checks `chatId` + `text`), so this validator carries
 * the structural checks the bridge silently relies on.
 *
 * Companion to ipc-server-validate-{operator,pty-partial,update-placeholder}.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { validateClientMessage } from '../gateway/ipc-server.js'

function baseInbound() {
  return {
    type: 'inbound' as const,
    chatId: '-1001234567890',
    messageId: 1_700_000_000_000,
    user: 'cron',
    userId: 0,
    ts: 1_700_000_000_000,
    text: 'Morning briefing',
    meta: {
      source: 'cron',
      schedule_index: '0',
      prompt_key: 'abcdef012345',
    },
  }
}

function base() {
  return {
    type: 'inject_inbound' as const,
    agentName: 'klanker',
    inbound: baseInbound(),
  }
}

describe('validateClientMessage — inject_inbound', () => {
  it('accepts a well-formed cron fire', () => {
    expect(validateClientMessage(base())).toBe(true)
  })

  it('rejects when agentName is missing or malformed', () => {
    const noName = { ...base() } as Record<string, unknown>
    delete noName.agentName
    expect(validateClientMessage(noName)).toBe(false)
    expect(validateClientMessage({ ...base(), agentName: '' })).toBe(false)
    // Same regex as register/heartbeat — uppercase rejected.
    expect(validateClientMessage({ ...base(), agentName: 'Klanker' })).toBe(false)
    // Path traversal / shell metacharacters rejected.
    expect(validateClientMessage({ ...base(), agentName: '../etc/passwd' })).toBe(false)
    expect(validateClientMessage({ ...base(), agentName: 'a$(rm -rf)' })).toBe(false)
    expect(validateClientMessage({ ...base(), agentName: 42 })).toBe(false)
  })

  it('rejects when inbound is not an object', () => {
    expect(validateClientMessage({ ...base(), inbound: null })).toBe(false)
    expect(validateClientMessage({ ...base(), inbound: 'string' })).toBe(false)
    expect(validateClientMessage({ ...base(), inbound: 42 })).toBe(false)
    const noInbound = { ...base() } as Record<string, unknown>
    delete noInbound.inbound
    expect(validateClientMessage(noInbound)).toBe(false)
  })

  it("requires inbound.type === 'inbound'", () => {
    expect(validateClientMessage({
      ...base(),
      inbound: { ...baseInbound(), type: 'permission' },
    })).toBe(false)
    expect(validateClientMessage({
      ...base(),
      inbound: { ...baseInbound(), type: 'Inbound' },
    })).toBe(false)
  })

  it('requires non-empty inbound.chatId (string) and string inbound.text', () => {
    expect(validateClientMessage({
      ...base(),
      inbound: { ...baseInbound(), chatId: '' },
    })).toBe(false)
    expect(validateClientMessage({
      ...base(),
      inbound: { ...baseInbound(), chatId: 42 },
    })).toBe(false)
    expect(validateClientMessage({
      ...base(),
      inbound: { ...baseInbound(), text: 42 },
    })).toBe(false)
  })

  it('requires numeric messageId, userId, ts (the bridge does not coerce)', () => {
    expect(validateClientMessage({
      ...base(),
      inbound: { ...baseInbound(), messageId: '0' },
    })).toBe(false)
    expect(validateClientMessage({
      ...base(),
      inbound: { ...baseInbound(), userId: '0' },
    })).toBe(false)
    expect(validateClientMessage({
      ...base(),
      inbound: { ...baseInbound(), ts: '0' },
    })).toBe(false)
  })

  it('requires meta to be an object (Record<string, string> on the wire)', () => {
    expect(validateClientMessage({
      ...base(),
      inbound: { ...baseInbound(), meta: null },
    })).toBe(false)
    const noMeta = { ...baseInbound() } as Record<string, unknown>
    delete noMeta.meta
    expect(validateClientMessage({ ...base(), inbound: noMeta })).toBe(false)
    // Empty meta is acceptable — the gateway doesn't enforce specific keys
    // here; meta.source filtering is policy that lives at the handler.
    expect(validateClientMessage({
      ...base(),
      inbound: { ...baseInbound(), meta: {} },
    })).toBe(true)
  })

  it('rejects unknown type aliases that look similar', () => {
    expect(validateClientMessage({ ...base(), type: 'inject_inbounds' })).toBe(false)
    expect(validateClientMessage({ ...base(), type: 'inject-inbound' })).toBe(false)
    expect(validateClientMessage({ ...base(), type: 'inbound' })).toBe(false)
  })
})
