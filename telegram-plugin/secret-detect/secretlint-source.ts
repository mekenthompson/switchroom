/**
 * Secretlint wrapper — adapts `@secretlint/core` + the recommend preset into
 * our `Detection` shape so it can merge with the vendored pattern engine.
 *
 * Secretlint is async (it loads rules, applies preset config, walks the
 * source). This module exposes `detectViaSecretlint(text)` returning a
 * Promise. The synchronous `detectSecrets()` path in `index.ts` stays the
 * fast default; callers that want the full engine use `detectSecretsAsync()`
 * which fans out both and merges.
 *
 * Slug derivation: Secretlint rules don't give us a clean LHS (KEY=value),
 * so we derive from the rule id (e.g. `@secretlint/secretlint-rule-slack`
 * becomes the slug `@secretlint-rule-slack_YYYYMMDD` via `deriveSlug`'s
 * rule_id + date fallback path).
 *
 * Confidence tier: Secretlint is a curated engine with checksum-validated
 * rules for most providers, so every hit is `high`.
 */

import { lintSource } from '@secretlint/core'
import { creator as presetRecommendCreator } from '@secretlint/secretlint-rule-preset-recommend'
import type { Detection } from './index.js'
import { deriveSlug } from './slug.js'
import { isSuppressed } from './suppressor.js'

/**
 * Map a single Secretlint rule id to a short rule slug used as the
 * `Detection.rule_id`. The full `@secretlint/secretlint-rule-foo` names are
 * long; we strip the scope/prefix to keep rule_ids readable in logs.
 */
function normalizeRuleId(secretlintRuleId: string): string {
  // "@secretlint/secretlint-rule-slack" → "secretlint_slack"
  // "secretlint-rule-custom-thing"       → "secretlint_custom_thing"
  const stripped = secretlintRuleId
    .replace(/^@secretlint\//, '')
    .replace(/^secretlint-rule-/, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return `secretlint_${stripped || 'unknown'}`
}

export async function detectViaSecretlint(text: string): Promise<Detection[]> {
  if (!text || text.length === 0) return []

  let result
  try {
    result = await lintSource({
      source: {
        content: text,
        filePath: 'message.txt',
        ext: '.txt',
        contentType: 'text',
      },
      options: {
        config: {
          rules: [
            {
              id: '@secretlint/secretlint-rule-preset-recommend',
              rule: presetRecommendCreator,
            },
          ],
        },
        noPhysicFilePath: true,
      },
    })
  } catch {
    // Fail-open: Secretlint crashes must never break the detector path.
    return []
  }

  const existing = new Set<string>()
  const out: Detection[] = []
  for (const msg of result.messages) {
    const [start, end] = msg.range
    if (typeof start !== 'number' || typeof end !== 'number' || end <= start) continue
    const matched_text = text.slice(start, end)
    if (!matched_text) continue
    const rule_id = normalizeRuleId(msg.ruleId)
    const suggested_slug = deriveSlug({ rule_id }, existing)
    existing.add(suggested_slug)
    out.push({
      rule_id,
      matched_text,
      start,
      end,
      confidence: 'high',
      suppressed: isSuppressed(text, start, end),
      suggested_slug,
    })
  }
  return out
}

export { normalizeRuleId as __normalizeRuleId }
