/**
 * Integration test: V1Extractor against REAL captured Claude Code TUI output.
 *
 * The existing pty-tail.test.ts cases use synthesized input that
 * matches "what we think the TUI looks like." This file uses the
 * actual bytes captured from a live agent's service.log to test
 * what V1Extractor extracts from current production output.
 *
 * Why this exists (the testing gap that PR #486 missed):
 *
 * V1Extractor scans Claude Code's TUI for `● switchroom-telegram - reply`
 * markers to extract the in-flight `text:` argument. The synthesized
 * tests assume a verbose marker shape. Real Claude Code recently
 * collapsed tool-call rendering by default — the TUI now shows just
 * `Calling switchroom-telegram` until the user presses ctrl+o to expand.
 *
 * That format change silently dropped V1Extractor to "always returns
 * null" — and the unit tests couldn't catch it because they tested
 * the synthesized old format, not the live one.
 *
 * Lesson: any extractor that parses external-system output needs at
 * least one test that uses captured-from-production bytes, not just
 * the test author's mental model of what the format looks like.
 *
 * Maintenance: when Claude Code TUI changes shape, recapture the
 * fixture from a fresh `~/.switchroom/agents/<agent>/service.log`:
 *
 *   tail -c 30000 ~/.switchroom/agents/<agent>/service.log > \
 *     telegram-plugin/tests/fixtures/service-log-current-claude-code.bin
 *
 * Then verify this test still passes (or update V1Extractor to
 * handle the new format).
 */

import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { V1Extractor } from '../pty-tail.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = resolve(__dirname, 'fixtures', 'service-log-current-claude-code.bin')
const FIXTURE_BYTES = readFileSync(FIXTURE_PATH, 'utf8')

async function feedToTerm(input: string): Promise<Terminal> {
  const term = new Terminal({
    cols: 132,
    rows: 40,
    scrollback: 5000,
    allowProposedApi: true,
  })
  await new Promise<void>((resolve) => {
    term.write(input, () => resolve())
  })
  return term
}

describe('V1Extractor — real production TUI output (regression catch for PR #486)', () => {
  it('the fixture contains current Claude Code TUI output (smoke check)', () => {
    // If this fails, the fixture file is empty or corrupted.
    expect(FIXTURE_BYTES.length).toBeGreaterThan(1000)
    // The TUI always emits the bot/agent name at minimum.
    expect(FIXTURE_BYTES).toContain('switchroom-telegram')
  })

  /**
   * The next two assertions document the CURRENT BROKEN STATE.
   * They pin "V1Extractor returns null on real production output" so:
   *
   *   1. The bug is loudly visible — the test name says "returns null
   *      (regression)", not "extracts text correctly"
   *   2. If V1Extractor is ever fixed (via a new extractor that
   *      handles the compact format, or upstream restores verbose
   *      rendering), these assertions will FAIL → forces a deliberate
   *      review + update of the test
   *   3. The fixture is canonical evidence of the bug; comparing
   *      against future captures shows what changed
   *
   * When this is fixed, replace the negative assertions with the
   * positive ones (`toBeNull` → `not.toBeNull`, etc.) and update the
   * test names. Don't just delete — the fixture-based pattern is the
   * point.
   */
  it('current Claude Code TUI does NOT contain the verbose marker (regression)', () => {
    // Format observed today (compact / collapsed):
    //   `Calling switchroom-telegram`
    // Format V1Extractor expects (verbose / pre-collapse):
    //   `● switchroom-telegram - reply (MCP)(text: "...")`
    // The bug: Claude Code now collapses tool-call rendering by
    // default. The marker `switchroom-telegram - reply` (with the
    // dash + tool name) is hidden until the user presses ctrl+o to
    // expand. V1Extractor never sees it, so it always returns null.
    expect(FIXTURE_BYTES).not.toContain('switchroom-telegram - reply')
  })

  it('V1Extractor.extract returns null on real fixture (regression — PR #486 PTY-tail wiring is dead code)', async () => {
    // The acceptance test that should have existed in PR #486:
    // given real production output, what does V1Extractor return?
    // Today: null. PTY-tail produces zero pty_partial events.
    // Bridge → gateway IPC wired correctly; just nothing on the wire.
    //
    // Replacement strategy is "heartbeat placeholder driven by JSONL
    // events" — doesn't depend on TUI parsing, never breaks on
    // Claude Code updates. See streaming roadmap for next steps.
    //
    // When V1Extractor is restored, flip this to .not.toBeNull and
    // pick a more useful assertion (e.g. extracted text contains
    // expected substring).
    const term = await feedToTerm(FIXTURE_BYTES)
    const result = new V1Extractor().extract(term)
    expect(result).toBeNull()
  })
})
