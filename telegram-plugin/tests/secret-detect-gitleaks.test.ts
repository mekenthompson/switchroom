import { describe, it, expect } from 'vitest'
import { parseGitleaksToml, loadGitleaksPatterns } from '../secret-detect/gitleaks-loader.js'

describe('gitleaks-loader.parseGitleaksToml', () => {
  it('parses the vendored subset', () => {
    const sample = `
      title = "x"

      [[rules]]
      id = "slack-webhook"
      regex = '''https://hooks\\.slack\\.com/services/[A-Za-z0-9_/]+'''

      [[rules]]
      id = "stripe-live-key"
      description = "Stripe live secret"
      regex = '''\\b(sk_live_[A-Za-z0-9]{24,})\\b'''
    `
    const rules = parseGitleaksToml(sample)
    expect(rules).toHaveLength(2)
    expect(rules[0]!.id).toBe('slack-webhook')
    expect(rules[1]!.id).toBe('stripe-live-key')
    expect(rules[1]!.description).toBe('Stripe live secret')
  })
  it('loads the vendored file into PatternDef[]', () => {
    const patterns = loadGitleaksPatterns()
    expect(patterns.length).toBeGreaterThan(0)
    for (const p of patterns) {
      expect(p.rule_id).toMatch(/^gitleaks_/)
      expect(p.regex).toBeInstanceOf(RegExp)
    }
  })
})
