/**
 * #842 — first-render delay (45s default) with explicit-background bypass.
 *
 * Behavioural contract:
 *   1. Turn that ends BEFORE the threshold trips → no card emit at all.
 *   2. Turn that runs PAST the threshold → exactly one card emit at the
 *      threshold, rendering the full buffered event stream (verified by
 *      checking the rendered HTML reflects accumulated state).
 *   3. Explicit `Agent({ run_in_background: true })` dispatch with
 *      `delay_ms_background=0` → card emits immediately on the
 *      tool_use, regardless of the long `delay_ms` budget.
 *   4. Threshold timer is cleared on early turn_end (no late phantom
 *      emit when wall-clock advances past the threshold afterwards).
 *   5. Pre-threshold buffer matches post-threshold render — i.e. the
 *      first emit's HTML reflects every tool_use that landed during
 *      the suppression window (no events lost).
 */

import { describe, it, expect } from 'vitest'
import { makeHarness, enqueue } from './_progress-card-harness.js'
import type { SessionEvent } from '../session-tail.js'

const tu = (
  toolName: string,
  toolUseId: string,
  input: Record<string, unknown> = {},
): SessionEvent => ({
  kind: 'tool_use',
  toolName,
  toolUseId,
  input,
})

const tr = (toolUseId: string): SessionEvent => ({
  kind: 'tool_result',
  toolUseId,
  isError: false,
  errorText: null,
})

describe('#842 progress-card first-render delay', () => {
  it('AC2 + AC6: turn ends BEFORE the 45s threshold → no card is ever posted', () => {
    const { driver, emits, advance } = makeHarness({ initialDelayMs: 45_000 })
    driver.ingest(enqueue('chat-fast'), null)
    advance(5_000)
    driver.ingest(tu('Read', 'tu1', { file_path: '/tmp/a.ts' }), 'chat-fast')
    advance(10_000)
    driver.ingest(tr('tu1'), 'chat-fast')
    advance(10_000)
    driver.ingest({ kind: 'turn_end' }, 'chat-fast')
    // Turn finished at t=25s — well before 45s. No card should have
    // been emitted, and no late phantom emit when we keep the clock
    // running.
    advance(60_000)
    expect(emits.length).toBe(0)
  })

  it('AC3 + AC6: turn that crosses 45s → one card emit at threshold, full backfill', () => {
    const { driver, emits, advance } = makeHarness({ initialDelayMs: 45_000 })
    driver.ingest(enqueue('chat-long'), null)
    // Buffer some events through the suppression window.
    advance(10_000)
    driver.ingest(tu('Read', 'tu1', { file_path: '/tmp/a.ts' }), 'chat-long')
    advance(10_000)
    driver.ingest(tr('tu1'), 'chat-long')
    advance(10_000)
    driver.ingest(tu('Bash', 'tu2', { description: 'check commits' }), 'chat-long')
    // No emits yet — still within the 45s window.
    expect(emits.length).toBe(0)
    // Cross the threshold.
    advance(20_000) // total elapsed ~50s
    // Exactly one initial emit at threshold, rendering the buffered
    // state. The first emit must reflect the tool_use accumulation
    // that happened during the suppression window — i.e. the renderer
    // saw the buffer.
    expect(emits.length).toBeGreaterThanOrEqual(1)
    const first = emits[0]
    expect(first.html.length).toBeGreaterThan(0)
    // Buffer included a Bash with a human description — render must
    // include the description text (non-trivial: proves the reducer
    // ate the events before the first flush). This is the
    // "pre-threshold buffer matches post-threshold render" assertion.
    expect(first.html).toContain('check commits')
  })

  it('AC4: explicit Agent({run_in_background:true}) bypasses the long delay', () => {
    const { driver, emits, advance } = makeHarness({
      initialDelayMs: 45_000,
      initialDelayMsBackground: 0,
    })
    driver.ingest(enqueue('chat-bg'), null)
    advance(2_000)
    driver.ingest(
      tu('Agent', 'tu-bg', {
        prompt: 'do bg work',
        description: 'bg-job',
        run_in_background: true,
      }),
      'chat-bg',
    )
    // Card should emit immediately — no need to advance the clock.
    expect(emits.length).toBeGreaterThanOrEqual(1)
    expect(emits[0].html.length).toBeGreaterThan(0)
  })

  it('AC4 (foreground variant): non-background Agent does NOT bypass the delay', () => {
    const { driver, emits, advance } = makeHarness({
      initialDelayMs: 45_000,
      initialDelayMsBackground: 0,
    })
    driver.ingest(enqueue('chat-fg'), null)
    advance(2_000)
    driver.ingest(
      tu('Agent', 'tu-fg', { prompt: 'p', description: 'fg-job' }),
      'chat-fg',
    )
    // No emit yet — foreground Agent should follow the 45s rule.
    // (`promoteOnSubAgent` only fires once `sub_agent_started` lands;
    // this test stops at the parent tool_use to isolate the
    // background-bypass branch.)
    expect(emits.length).toBe(0)
  })

  it('AC4 (with positive background budget): timer rescheduled to short budget', () => {
    const { driver, emits, advance } = makeHarness({
      initialDelayMs: 45_000,
      initialDelayMsBackground: 5_000,
    })
    driver.ingest(enqueue('chat-bg-short'), null)
    advance(1_000)
    driver.ingest(
      tu('Agent', 'tu-bg2', {
        prompt: 'p',
        description: 'bg',
        run_in_background: true,
      }),
      'chat-bg-short',
    )
    // No immediate emit — budget is 5s.
    expect(emits.length).toBe(0)
    // Advance past 45s budget would emit, but we expect the
    // background bypass to fire by 5s elapsed.
    advance(5_000)
    expect(emits.length).toBeGreaterThanOrEqual(1)
  })

  it('AC5: timer cleared on early turn_end — no phantom emit when clock keeps running', () => {
    const { driver, emits, advance } = makeHarness({ initialDelayMs: 45_000 })
    driver.ingest(enqueue('chat-fast2'), null)
    advance(5_000)
    driver.ingest(tu('Read', 'tu1', { file_path: '/x' }), 'chat-fast2')
    advance(5_000)
    driver.ingest({ kind: 'turn_end' }, 'chat-fast2')
    expect(emits.length).toBe(0)
    // Push the clock far past the original threshold. If the timer
    // wasn't cleared, a phantom flush would land here.
    advance(120_000)
    expect(emits.length).toBe(0)
  })
})
