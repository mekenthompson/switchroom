/**
 * Tests for the always-allow rule resolver — pinned by the Telegram
 * `🔁 Always allow` button (popup callback handler in gateway.ts).
 *
 * The shape we promise to the gateway:
 *   - `null` ⇒ "don't show the Always button" (unknown tool, missing
 *     skill name, characters that could break Claude Code's
 *     permission-rule grammar).
 *   - `{rule, label}` ⇒ a string we can hand to
 *     `switchroom agent grant <agent> <rule>` and a human-readable
 *     label for the chat confirmation.
 */

import { describe, it, expect } from 'vitest'
import { resolveAlwaysAllowRule, matchesAllowRule } from '../permission-rule.js'

describe('resolveAlwaysAllowRule — Skill', () => {
  it('returns Skill(name) for a typical skill input', () => {
    const result = resolveAlwaysAllowRule('Skill', JSON.stringify({ skill: 'mail' }))
    expect(result).toEqual({ rule: 'Skill(mail)', label: 'Skill(mail)' })
  })

  it('falls back to skill_name field', () => {
    const result = resolveAlwaysAllowRule('Skill', JSON.stringify({ skill_name: 'calendar' }))
    expect(result).toEqual({ rule: 'Skill(calendar)', label: 'Skill(calendar)' })
  })

  it('falls back to skillName field', () => {
    const result = resolveAlwaysAllowRule('Skill', JSON.stringify({ skillName: 'garmin' }))
    expect(result).toEqual({ rule: 'Skill(garmin)', label: 'Skill(garmin)' })
  })

  it('falls back to name field', () => {
    const result = resolveAlwaysAllowRule('Skill', JSON.stringify({ name: 'home-assistant' }))
    expect(result).toEqual({ rule: 'Skill(home-assistant)', label: 'Skill(home-assistant)' })
  })

  it('extracts skill name from path with SKILL.md', () => {
    const result = resolveAlwaysAllowRule(
      'Skill',
      JSON.stringify({ path: 'skills/coolify/SKILL.md' }),
    )
    expect(result).toEqual({ rule: 'Skill(coolify)', label: 'Skill(coolify)' })
  })

  it('extracts skill name from a directory path', () => {
    const result = resolveAlwaysAllowRule(
      'Skill',
      JSON.stringify({ skill_path: '/home/x/.switchroom/skills/mail' }),
    )
    expect(result).toEqual({ rule: 'Skill(mail)', label: 'Skill(mail)' })
  })

  it('returns null when no skill identifier is present', () => {
    expect(resolveAlwaysAllowRule('Skill', JSON.stringify({ unrelated: 'x' }))).toBeNull()
    expect(resolveAlwaysAllowRule('Skill', undefined)).toBeNull()
    expect(resolveAlwaysAllowRule('Skill', '')).toBeNull()
    expect(resolveAlwaysAllowRule('Skill', 'not-json')).toBeNull()
  })

  it('refuses skill names with characters that could break the rule grammar', () => {
    // Parens, slashes, quotes, whitespace would break Claude Code's
    // permission-rule parser or expand to unintended matches.
    expect(resolveAlwaysAllowRule('Skill', JSON.stringify({ skill: 'mail(secret)' }))).toBeNull()
    expect(resolveAlwaysAllowRule('Skill', JSON.stringify({ skill: 'mail/calendar' }))).toBeNull()
    expect(resolveAlwaysAllowRule('Skill', JSON.stringify({ skill: 'mail calendar' }))).toBeNull()
    expect(resolveAlwaysAllowRule('Skill', JSON.stringify({ skill: 'mail"calendar' }))).toBeNull()
  })

  it('accepts the safe alphanumeric + ._-+ alphabet', () => {
    expect(resolveAlwaysAllowRule('Skill', JSON.stringify({ skill: 'home-assistant' }))).not.toBeNull()
    expect(resolveAlwaysAllowRule('Skill', JSON.stringify({ skill: 'home_assistant' }))).not.toBeNull()
    expect(resolveAlwaysAllowRule('Skill', JSON.stringify({ skill: 'docs.v2' }))).not.toBeNull()
    expect(resolveAlwaysAllowRule('Skill', JSON.stringify({ skill: 'work+personal' }))).not.toBeNull()
  })
})

describe('resolveAlwaysAllowRule — built-in tools', () => {
  it.each([
    'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
    'Glob', 'Grep', 'WebFetch', 'WebSearch',
    'Task', 'Agent', 'TodoWrite', 'ExitPlanMode',
  ])('returns the bare tool name for %s', (tool) => {
    expect(resolveAlwaysAllowRule(tool, undefined)).toEqual({ rule: tool, label: tool })
  })

  it('returns the bare name even when input_preview is present', () => {
    // The button is for "trust this tool category" — fine-grained
    // pattern rules (Bash(npm:*) etc.) are the operator's job to
    // craft via the CLI.
    const result = resolveAlwaysAllowRule(
      'Bash',
      JSON.stringify({ command: 'rm -rf /tmp/x' }),
    )
    expect(result).toEqual({ rule: 'Bash', label: 'Bash' })
  })
})

describe('resolveAlwaysAllowRule — MCP tools', () => {
  it('preserves the namespaced MCP tool name', () => {
    expect(resolveAlwaysAllowRule('mcp__switchroom-telegram__reply', undefined))
      .toEqual({ rule: 'mcp__switchroom-telegram__reply', label: 'mcp__switchroom-telegram__reply' })
  })

  it('accepts MCP server-only namespaces', () => {
    expect(resolveAlwaysAllowRule('mcp__hindsight', undefined))
      .toEqual({ rule: 'mcp__hindsight', label: 'mcp__hindsight' })
  })

  it('refuses malformed mcp_ shapes (missing prefix structure)', () => {
    expect(resolveAlwaysAllowRule('mcp_foo', undefined)).toBeNull()
    expect(resolveAlwaysAllowRule('mcp__', undefined)).toBeNull()
  })
})

describe('resolveAlwaysAllowRule — fallback', () => {
  it('returns null for unknown tools', () => {
    expect(resolveAlwaysAllowRule('UnknownTool', undefined)).toBeNull()
    expect(resolveAlwaysAllowRule('', undefined)).toBeNull()
  })
})

describe('matchesAllowRule — bare tool names', () => {
  // The whole point of #1138: a cached `Edit` rule covers every Edit
  // call from the parent claude AND from sub-agents dispatched via the
  // Task tool, no matter the file path.
  it('matches any invocation of the same tool', () => {
    expect(matchesAllowRule('Edit', 'Edit', undefined)).toBe(true)
    expect(matchesAllowRule('Edit', 'Edit', JSON.stringify({ file_path: '/tmp/a' }))).toBe(true)
    expect(matchesAllowRule('Edit', 'Edit', JSON.stringify({ file_path: '/etc/passwd' }))).toBe(true)
  })

  it('does not bleed into other tools', () => {
    expect(matchesAllowRule('Edit', 'Write', undefined)).toBe(false)
    expect(matchesAllowRule('Read', 'Edit', undefined)).toBe(false)
    expect(matchesAllowRule('Bash', 'BashOutput', undefined)).toBe(false)
  })

  it.each(['Bash', 'Read', 'Write', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'TodoWrite'])(
    'roundtrips through resolve → match for %s',
    (tool) => {
      const resolved = resolveAlwaysAllowRule(tool, undefined)
      expect(resolved).not.toBeNull()
      expect(matchesAllowRule(resolved!.rule, tool, undefined)).toBe(true)
    },
  )
})

describe('matchesAllowRule — Skill(name)', () => {
  it('matches only the specific skill', () => {
    expect(matchesAllowRule('Skill(mail)', 'Skill', JSON.stringify({ skill: 'mail' }))).toBe(true)
    expect(matchesAllowRule('Skill(mail)', 'Skill', JSON.stringify({ skill: 'calendar' }))).toBe(false)
  })

  it('uses the same field fallback chain as the resolver', () => {
    expect(matchesAllowRule('Skill(mail)', 'Skill', JSON.stringify({ skill_name: 'mail' }))).toBe(true)
    expect(matchesAllowRule('Skill(mail)', 'Skill', JSON.stringify({ skillName: 'mail' }))).toBe(true)
    expect(matchesAllowRule('Skill(mail)', 'Skill', JSON.stringify({ name: 'mail' }))).toBe(true)
    expect(matchesAllowRule(
      'Skill(coolify)',
      'Skill',
      JSON.stringify({ path: 'skills/coolify/SKILL.md' }),
    )).toBe(true)
  })

  it('does not match a different tool with the same arg', () => {
    expect(matchesAllowRule('Skill(mail)', 'Bash', JSON.stringify({ skill: 'mail' }))).toBe(false)
  })

  it('returns false on malformed Skill input', () => {
    expect(matchesAllowRule('Skill(mail)', 'Skill', undefined)).toBe(false)
    expect(matchesAllowRule('Skill(mail)', 'Skill', 'not-json')).toBe(false)
    expect(matchesAllowRule('Skill(mail)', 'Skill', JSON.stringify({ unrelated: 'x' }))).toBe(false)
  })
})

describe('matchesAllowRule — MCP tools', () => {
  it('matches the exact namespaced tool', () => {
    expect(matchesAllowRule(
      'mcp__switchroom-telegram__reply',
      'mcp__switchroom-telegram__reply',
      undefined,
    )).toBe(true)
  })

  it('does not match a different MCP tool on the same server', () => {
    expect(matchesAllowRule(
      'mcp__switchroom-telegram__reply',
      'mcp__switchroom-telegram__stream_reply',
      undefined,
    )).toBe(false)
  })
})

describe('matchesAllowRule — defensive', () => {
  it('returns false for empty inputs', () => {
    expect(matchesAllowRule('', 'Edit', undefined)).toBe(false)
    expect(matchesAllowRule('Edit', '', undefined)).toBe(false)
  })
})
