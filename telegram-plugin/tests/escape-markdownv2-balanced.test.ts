/**
 * Cross-check: production's `escapeMarkdownV2` (gateway.ts:951) must
 * always produce text that the lenient `parseModeBalanced` validator
 * accepts. If it doesn't, production is emitting markdown Telegram
 * will reject with 400.
 *
 * The forward direction (validator catches malformed text) is covered
 * by `harness-parse-mode-validation.test.ts`. This file goes the other
 * way: validator-tests-the-escaper. A flag here means escapeMarkdownV2
 * has a hole — a special character it isn't escaping, or a code-block
 * carve-out that lets unbalanced markers through.
 *
 * Why mirror the source: importing escapeMarkdownV2 from gateway.ts
 * would drag in a 7000-line module with side effects. The escaper is
 * 14 lines and pure; mirroring it here is fine. If gateway.ts's
 * version drifts, this test will start passing falsely — so the next
 * "fails when:" guard:
 *
 * fails when: gateway.ts:951's `escapeMarkdownV2` adds a new special
 *   character not escaped (Telegram adds one to MarkdownV2 spec), or
 *   the code-block carve-out lets unbalanced inner markers through.
 *   Update both this mirror and the cross-check inputs together.
 */

import { describe, it, expect } from 'vitest'
import { parseModeBalanced } from './fake-bot-api.js'

// MIRROR of gateway.ts:951 — keep in sync.
function escapeMarkdownV2(text: string): string {
  const specialChars = /[_*\[\]()~`>#+\-=|{}.!\\]/g
  const parts: string[] = []
  let last = 0
  const codeRe = /(```[\s\S]*?```|`[^`\n]+`)/g
  let m: RegExpExecArray | null
  while ((m = codeRe.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index).replace(specialChars, '\\$&'))
    parts.push(m[0])
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push(text.slice(last).replace(specialChars, '\\$&'))
  return parts.join('')
}

// Tricky inputs that production might receive from a streaming agent
// emitting natural prose. If escape produces malformed MarkdownV2 for
// any of these, production sends a 400-bound message.
const trickyInputs: Array<{ name: string; input: string }> = [
  { name: 'plain text', input: 'plain text' },
  { name: 'raw bold marker', input: '*bold*' },
  { name: 'raw italic marker', input: '_italic_' },
  { name: 'inline code', input: '`code`' },
  { name: 'fenced code', input: '```\nfenced\n```' },
  { name: 'link', input: '[link](url)' },
  { name: 'unbalanced raw asterisk', input: 'a*b' },
  { name: 'odd underscore count', input: 'a_b_c_d' },
  { name: 'apostrophe', input: "don't" },
  { name: 'parens', input: 'hello (world)' },
  { name: 'unclosed inline code', input: '`unclosed code' },
  { name: 'unclosed fence', input: 'half ```fenced' },
  { name: 'mixed markers', input: 'mix * and _ markers' },
  { name: 'inline-code-with-bold-outside', input: 'a `code with * inside` and *bold*' },
  { name: 'inline code with newline (regex requires no newline → not matched as code)', input: 'newline mid-`code\nbreak`' },
  { name: 'unbalanced bracket', input: '[unclosed bracket' },
  { name: 'code block with markers inside', input: '```code\nwith _underscores_ and *asterisks*\n```' },
  { name: 'quote', input: 'quote > text' },
  { name: 'all special chars at once', input: 'a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s\\t' },
  { name: 'empty', input: '' },
  { name: 'literal backslash', input: 'just\\backslash' },
  { name: 'multiline prose with formatting', input: 'Here is **what** I _did_:\n* item 1\n* item 2 with `code`' },
]

describe('escapeMarkdownV2 always produces balanced output', () => {
  for (const { name, input } of trickyInputs) {
    it(`balanced after escape: ${name}`, () => {
      const escaped = escapeMarkdownV2(input)
      const issue = parseModeBalanced(escaped)
      // If this fires, production is emitting MarkdownV2 Telegram will reject.
      // Diagnostic: include the input + escaped so the failure is debuggable.
      expect(issue, `input=${JSON.stringify(input)} escaped=${JSON.stringify(escaped)} → ${issue ?? 'ok'}`).toBeNull()
    })
  }
})
