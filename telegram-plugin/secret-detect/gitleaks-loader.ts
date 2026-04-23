/**
 * Minimal loader for the vendored gitleaks.toml.
 *
 * We intentionally avoid adding a full TOML parser dep. The vendored file
 * (gitleaks.toml) is a small handpicked subset, so a naive section-based
 * parser is enough — it handles `[[rules]]`, `id = "..."`, `regex = '''...'''`
 * (triple-single-quoted literals).
 *
 * When v2 lands the full upstream gitleaks.toml, swap this out for a real
 * parser like `@iarna/toml`.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PatternDef } from './patterns.js'

export interface GitleaksRule {
  id: string
  description?: string
  regex: string
}

function defaultPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, 'gitleaks.toml')
}

export function parseGitleaksToml(content: string): GitleaksRule[] {
  const rules: GitleaksRule[] = []
  // Split on [[rules]] headers.
  const sections = content.split(/^\s*\[\[\s*rules\s*\]\]\s*$/m).slice(1)
  for (const section of sections) {
    const rule: Partial<GitleaksRule> = {}
    const idMatch = /^\s*id\s*=\s*"([^"]+)"\s*$/m.exec(section)
    if (idMatch) rule.id = idMatch[1]
    const descMatch = /^\s*description\s*=\s*"([^"]*)"\s*$/m.exec(section)
    if (descMatch) rule.description = descMatch[1]
    // Regex may be wrapped in ''' or " — prefer ''' which preserves regex
    // escapes without TOML string escaping.
    const reTriple = /^\s*regex\s*=\s*'''([\s\S]*?)'''\s*$/m.exec(section)
    const reDouble = /^\s*regex\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m.exec(section)
    const raw = reTriple?.[1] ?? reDouble?.[1]
    if (rule.id && raw) {
      rule.regex = raw
      rules.push(rule as GitleaksRule)
    }
  }
  return rules
}

export function loadGitleaksPatterns(path: string = defaultPath()): PatternDef[] {
  if (!existsSync(path)) return []
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const rules = parseGitleaksToml(content)
  const out: PatternDef[] = []
  for (const r of rules) {
    try {
      const re = new RegExp(r.regex, 'g')
      out.push({
        rule_id: `gitleaks_${r.id.replace(/-/g, '_')}`,
        regex: re,
        captureIndex: 0,
      })
    } catch {
      // Skip invalid regexes silently; the loader is best-effort.
    }
  }
  return out
}
