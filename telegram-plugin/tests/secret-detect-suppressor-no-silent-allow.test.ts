import { describe, it, expect } from 'vitest'
import { detectSecrets } from '../secret-detect/index.js'
import { runPipeline } from '../secret-detect/pipeline.js'
import type { VaultWriteFn, VaultListFn } from '../secret-detect/vault-write.js'

/**
 * Regression: a suppressor hit (test/mock/example/dummy/fixture nearby)
 * must NEVER silent-allow a structured-pattern match. The asymmetric
 * risk model is: a false-negative leaks a real credential into the
 * agent's session log, a false-positive just briefly redacts a fake
 * one and the user can `ignore` / `forget` to dismiss.
 *
 * The contract:
 *   1. detectSecrets() returns the detection with `suppressed: true`,
 *      not an empty list.
 *   2. runPipeline() routes suppressed-high hits into the `ambiguous`
 *      bucket (NOT `stored`, NOT silently dropped).
 *
 * Both layers are exercised here so future refactors can't regress
 * this without breaking a test.
 */
describe('suppressor: never silent-allows on structured matches', () => {
  const phrasings = [
    'this is a test, here is sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22',
    'mock token: sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22',
    'example: sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22',
    'dummy sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22',
    'fixture sk-ant-Apq13yqRnPzx4MxK0TfAbY98Qw22',
  ]

  for (const text of phrasings) {
    it(`detectSecrets surfaces suppressed=true for: ${text.slice(0, 32)}…`, () => {
      const detections = detectSecrets(text)
      expect(detections.length).toBeGreaterThan(0)
      const hit = detections.find((d) => d.rule_id === 'anthropic_api_key')
      expect(hit).toBeDefined()
      expect(hit!.suppressed).toBe(true)
      // confidence is still 'high' — suppressed is the orthogonal flag
      // that downgrades it into the ambiguous tier.
      expect(hit!.confidence).toBe('high')
    })

    it(`runPipeline routes the suppressed hit to ambiguous (not stored, not dropped) for: ${text.slice(0, 32)}…`, () => {
      const store = new Map<string, string>()
      const write: VaultWriteFn = (slug, value) => {
        store.set(slug, value)
        return { ok: true, output: 'ok' }
      }
      const list: VaultListFn = () => ({ ok: true, keys: [...store.keys()] })
      const res = runPipeline({
        chat_id: 'c',
        message_id: 1,
        text,
        passphrase: 'pw',
        vaultWrite: write,
        vaultList: list,
      })
      // Critical: suppressed hit must NOT silent-pass.
      expect(res.ambiguous.length).toBeGreaterThan(0)
      // Critical: suppressed hit must NOT auto-store.
      expect(res.stored).toHaveLength(0)
      expect(store.size).toBe(0)
      // Text unchanged — the user gets to decide.
      expect(res.rewritten_text).toBe(text)
    })
  }
})
