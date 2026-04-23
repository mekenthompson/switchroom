/**
 * Heuristic KEY=VALUE scanner. Fallback when the structured patterns miss —
 * e.g. lowercase env var names like `my_password=...` that the all-caps
 * `env_key_value` pattern skips.
 *
 * Flow:
 *   1. Regex-scan for `(password|token|secret|key|api_key)\s*[:=]\s*...`
 *   2. Extract the RHS value
 *   3. Gate on Shannon entropy ≥ 4.0 to cut obvious placeholders like
 *      `password=foo` or `key=changeme`.
 *
 * Returns `RawHit` entries pointing at the VALUE bytes (not the whole
 * `key=value` match), so the rewriter can preserve the `key=` prefix.
 */
import { shannonEntropy } from './entropy.js'

export interface RawHit {
  rule_id: string
  start: number
  end: number
  matched_text: string
  /** The identifier on the left of `=` or `:`, if any. Used for slug derivation. */
  key_name?: string
  /** Confidence tier — high = anchored pattern, ambiguous = entropy-only. */
  confidence: 'high' | 'ambiguous'
}

// Lower-case / mixed-case KEY=VALUE. Uppercase-only is handled by the
// structured `env_key_value` pattern for higher confidence.
const KV_RE = /\b([A-Za-z_][A-Za-z0-9_-]*(?:password|passwd|token|secret|key|api[_-]?key))\s*[:=]\s*["']?([^\s"'\\]{8,})["']?/gi

export const KV_ENTROPY_THRESHOLD = 4.0

export function scanKeyValue(text: string): RawHit[] {
  const hits: RawHit[] = []
  KV_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = KV_RE.exec(text)) !== null) {
    const [, keyName, value] = m
    if (!value) continue
    // Shannon entropy gate — only flag values that actually look random.
    const h = shannonEntropy(value)
    if (h < KV_ENTROPY_THRESHOLD) continue
    // The value starts at match.index + the length of everything before
    // it in the match. Compute by finding the value inside the match.
    const valueOffsetInMatch = m[0].indexOf(value, keyName!.length)
    if (valueOffsetInMatch < 0) continue
    const start = m.index + valueOffsetInMatch
    const end = start + value.length
    hits.push({
      rule_id: 'kv_entropy',
      start,
      end,
      matched_text: value,
      key_name: keyName,
      confidence: 'ambiguous',
    })
  }
  return hits
}
