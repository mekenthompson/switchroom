import { describe, expect, it } from 'vitest'

import { decideDmCommandGate } from '../dm-command-gate.js'

/**
 * Regression coverage for the upstream backport of
 * claude-plugins-official `5a71459` (#894): /start, /help, /status
 * must respect dmPolicy and the allowlist instead of replying to any
 * private DM. The wrapper in server.ts and gateway.ts adds grammy ctx
 * + access.json side effects — those are integration-tested via the
 * production traffic the gateway sees. The decision logic is here.
 */
describe('decideDmCommandGate — bot command access', () => {
  describe('drop branches', () => {
    it('drops non-private chat (group)', () => {
      const result = decideDmCommandGate({
        chatType: 'group',
        senderId: '12345',
        dmPolicy: 'allowlist',
        allowFrom: ['12345'],
      })
      expect(result).toEqual({ allow: false, reason: 'not-private' })
    })

    it('drops non-private chat (supergroup)', () => {
      const result = decideDmCommandGate({
        chatType: 'supergroup',
        senderId: '12345',
        dmPolicy: 'pairing',
        allowFrom: [],
      })
      expect(result).toEqual({ allow: false, reason: 'not-private' })
    })

    it('drops non-private chat (channel)', () => {
      const result = decideDmCommandGate({
        chatType: 'channel',
        senderId: '12345',
        dmPolicy: 'pairing',
        allowFrom: [],
      })
      expect(result).toEqual({ allow: false, reason: 'not-private' })
    })

    it('drops when chatType is undefined', () => {
      const result = decideDmCommandGate({
        chatType: undefined,
        senderId: '12345',
        dmPolicy: 'pairing',
        allowFrom: [],
      })
      expect(result).toEqual({ allow: false, reason: 'not-private' })
    })

    it('drops when senderId is missing (anonymous channel post)', () => {
      const result = decideDmCommandGate({
        chatType: 'private',
        senderId: undefined,
        dmPolicy: 'pairing',
        allowFrom: [],
      })
      expect(result).toEqual({ allow: false, reason: 'no-sender' })
    })

    it('drops when senderId is empty', () => {
      const result = decideDmCommandGate({
        chatType: 'private',
        senderId: '',
        dmPolicy: 'pairing',
        allowFrom: [],
      })
      expect(result).toEqual({ allow: false, reason: 'no-sender' })
    })

    it('drops when dmPolicy is disabled — even for allowlisted senders', () => {
      // The "disabled" branch wins over allowlist membership. Operator
      // can turn the bot off for everyone with one knob.
      const result = decideDmCommandGate({
        chatType: 'private',
        senderId: '12345',
        dmPolicy: 'disabled',
        allowFrom: ['12345'],
      })
      expect(result).toEqual({ allow: false, reason: 'disabled' })
    })

    it('drops when dmPolicy is allowlist and sender not on the list', () => {
      // The exact bug the backport closes: pre-fix, /start replied here
      // and leaked the bot's existence to a non-allowlisted user.
      const result = decideDmCommandGate({
        chatType: 'private',
        senderId: '99999',
        dmPolicy: 'allowlist',
        allowFrom: ['12345', '67890'],
      })
      expect(result).toEqual({ allow: false, reason: 'not-allowlisted' })
    })
  })

  describe('allow branches', () => {
    it('allows allowlisted sender in allowlist mode', () => {
      const result = decideDmCommandGate({
        chatType: 'private',
        senderId: '12345',
        dmPolicy: 'allowlist',
        allowFrom: ['12345'],
      })
      expect(result).toEqual({ allow: true, senderId: '12345' })
    })

    it('allows pairing-mode sender even when not on allowFrom', () => {
      // /status surfacing a user's pending pairing code is the
      // canonical example. The handler downstream of this decision
      // checks `access.pending` and renders the right text. The gate
      // itself must let pairing-mode senders through regardless of
      // allowFrom membership.
      const result = decideDmCommandGate({
        chatType: 'private',
        senderId: '99999',
        dmPolicy: 'pairing',
        allowFrom: [],
      })
      expect(result).toEqual({ allow: true, senderId: '99999' })
    })

    it('allows pairing-mode sender who happens to also be on allowFrom', () => {
      const result = decideDmCommandGate({
        chatType: 'private',
        senderId: '12345',
        dmPolicy: 'pairing',
        allowFrom: ['12345'],
      })
      expect(result).toEqual({ allow: true, senderId: '12345' })
    })
  })

  describe('reject ordering', () => {
    // The drop reasons cascade in a specific order that matters for
    // operator intent. Pin the order so refactors don't accidentally
    // tell a non-allowlisted sender "the bot is disabled" when both
    // conditions hold (or vice versa).

    it('not-private wins over no-sender', () => {
      const result = decideDmCommandGate({
        chatType: 'group',
        senderId: undefined,
        dmPolicy: 'disabled',
        allowFrom: [],
      })
      expect(result).toEqual({ allow: false, reason: 'not-private' })
    })

    it('no-sender wins over disabled', () => {
      const result = decideDmCommandGate({
        chatType: 'private',
        senderId: undefined,
        dmPolicy: 'disabled',
        allowFrom: [],
      })
      expect(result).toEqual({ allow: false, reason: 'no-sender' })
    })

    it('disabled wins over not-allowlisted', () => {
      // Operator turning the bot off is a stronger statement than the
      // allowlist filter; both are silent drops at the wire, but
      // observability is better when the right reason fires.
      const result = decideDmCommandGate({
        chatType: 'private',
        senderId: '99999',
        dmPolicy: 'disabled',
        allowFrom: ['12345'],
      })
      expect(result).toEqual({ allow: false, reason: 'disabled' })
    })
  })
})
