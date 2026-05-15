import { describe, expect, it } from 'vitest'
import {
  type BrokerStateView,
  type ClaudeJsonView,
  buildAuthSummaryFromBroker,
  formatExpiresInRelative,
} from '../gateway/auth-status-adapter.js'

const NOW = 1_700_000_000_000

function state(over: Partial<BrokerStateView> = {}): BrokerStateView {
  return {
    active: 'ken@example.com',
    fallback_order: ['ken@example.com'],
    accounts: [
      { label: 'ken@example.com', expiresAt: NOW + 29 * 86_400_000, exhausted: false },
    ],
    agents: [{ name: 'clerk', account: 'ken@example.com', override: null }],
    ...over,
  }
}

const claudeMax: ClaudeJsonView = { oauthAccount: { billingType: 'claude_max' } }

describe('formatExpiresInRelative', () => {
  it('returns null for missing / non-finite', () => {
    expect(formatExpiresInRelative(undefined, NOW)).toBeNull()
    expect(formatExpiresInRelative(NaN, NOW)).toBeNull()
  })

  it('returns "expired" when in the past', () => {
    expect(formatExpiresInRelative(NOW - 1, NOW)).toBe('expired')
    expect(formatExpiresInRelative(NOW - 86_400_000, NOW)).toBe('expired')
  })

  it('formats days for ≥ 24h', () => {
    expect(formatExpiresInRelative(NOW + 29 * 86_400_000, NOW)).toBe('in 29 days')
    expect(formatExpiresInRelative(NOW + 86_400_000, NOW)).toBe('in 1 day')
  })

  it('formats hours when < 24h but ≥ 1h', () => {
    expect(formatExpiresInRelative(NOW + 5 * 3_600_000, NOW)).toBe('in 5 hours')
    expect(formatExpiresInRelative(NOW + 3_600_000, NOW)).toBe('in 1 hour')
  })

  it('formats minutes when < 1h', () => {
    expect(formatExpiresInRelative(NOW + 30 * 60_000, NOW)).toBe('in 30 minutes')
    expect(formatExpiresInRelative(NOW + 60_000, NOW)).toBe('in 1 minute')
  })
})

describe('buildAuthSummaryFromBroker', () => {
  it('returns null when state is null', () => {
    expect(buildAuthSummaryFromBroker(null, 'clerk', claudeMax, NOW)).toBeNull()
  })

  it('happy path — agent bound to a known account with future expiry', () => {
    const summary = buildAuthSummaryFromBroker(state(), 'clerk', claudeMax, NOW)
    expect(summary).toEqual({
      authenticated: true,
      subscription_type: 'Max',
      expires_in: 'in 29 days',
      auth_source: 'ken@example.com',
    })
  })

  it('agent missing from broker.agents → not authenticated, no source', () => {
    const summary = buildAuthSummaryFromBroker(state(), 'unknown-agent', claudeMax, NOW)
    expect(summary).toEqual({
      authenticated: false,
      subscription_type: 'Max',
      expires_in: null,
      auth_source: null,
    })
  })

  it('agent bound to an account broker has no record of → not authenticated', () => {
    const s = state({
      accounts: [], // no matching account
      agents: [{ name: 'clerk', account: 'ghost@example.com', override: null }],
    })
    const summary = buildAuthSummaryFromBroker(s, 'clerk', claudeMax, NOW)
    expect(summary?.authenticated).toBe(false)
    expect(summary?.auth_source).toBe('ghost@example.com')
    expect(summary?.expires_in).toBeNull()
  })

  it('expired account → authenticated stays true; expires_in says "expired"', () => {
    const s = state({
      accounts: [{ label: 'ken@example.com', expiresAt: NOW - 1, exhausted: false }],
    })
    const summary = buildAuthSummaryFromBroker(s, 'clerk', claudeMax, NOW)
    expect(summary?.authenticated).toBe(true)
    expect(summary?.expires_in).toBe('expired')
  })

  it('subscription_type pulled from claude.json — Pro tier', () => {
    const summary = buildAuthSummaryFromBroker(
      state(),
      'clerk',
      { oauthAccount: { billingType: 'claude_pro' } },
      NOW,
    )
    expect(summary?.subscription_type).toBe('Pro')
  })

  it('subscription_type is null when claudeJson is missing', () => {
    const summary = buildAuthSummaryFromBroker(state(), 'clerk', null, NOW)
    expect(summary?.subscription_type).toBeNull()
  })

  it('passes through unknown billingType verbatim', () => {
    const summary = buildAuthSummaryFromBroker(
      state(),
      'clerk',
      { oauthAccount: { billingType: 'team' } },
      NOW,
    )
    expect(summary?.subscription_type).toBe('team')
  })

  it('exhausted account still authenticated (quota state separate from auth state)', () => {
    const s = state({
      accounts: [{ label: 'ken@example.com', expiresAt: NOW + 86_400_000, exhausted: true }],
    })
    const summary = buildAuthSummaryFromBroker(s, 'clerk', claudeMax, NOW)
    expect(summary?.authenticated).toBe(true)
  })
})
