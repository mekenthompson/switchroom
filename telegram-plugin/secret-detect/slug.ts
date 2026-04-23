/**
 * Vault slug derivation for a detected secret.
 *
 * Preference order:
 *   1. If the detection knows the LHS of `KEY=value`, sanitize it to
 *      `[A-Z0-9_]+` (uppercase, underscores for separators, strip other chars).
 *   2. Otherwise use `${rule_name}_${YYYYMMDD}`.
 *
 * Collision handling: if `slug` already exists in `existing`, append
 * `_2`, `_3`, ... until free.
 */

export function sanitizeKeyName(raw: string): string {
  // Upper, replace non-[A-Z0-9_] with `_`, collapse runs, trim leading/trailing `_`.
  const up = raw.toUpperCase()
  const cleaned = up.replace(/[^A-Z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned.length > 0 ? cleaned : 'SECRET'
}

export function datePart(now: Date = new Date()): string {
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  const d = String(now.getUTCDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

export interface SlugInputs {
  key_name?: string
  rule_id: string
  now?: Date
}

export function deriveSlug(inputs: SlugInputs, existing: Set<string>): string {
  let base: string
  if (inputs.key_name && inputs.key_name.trim().length > 0) {
    base = sanitizeKeyName(inputs.key_name)
  } else {
    base = `${inputs.rule_id}_${datePart(inputs.now)}`
  }
  if (!existing.has(base)) return base
  let n = 2
  while (existing.has(`${base}_${n}`)) n++
  return `${base}_${n}`
}
