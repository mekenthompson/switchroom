/**
 * PR-C2 — additional golden snapshots for renderTwoZoneCard not
 * covered by two-zone-card-snapshot.test.ts:
 *
 *   1. silent-end + bg fleet running (silentEnd lifted above
 *      Background; the bg member still appears in the FLEET zone).
 *   2. stalled-close header (`stalledClose` precedence dominates).
 *   3. Parent zone "(+N earlier)" overflow when items.length >
 *      PARENT_BULLET_CAP (=8).
 *
 * fails when: phaseFor's precedence regresses (silentEnd no longer
 * lifted above background), the stalledClose label changes, or
 * PARENT_BULLET_CAP overflow rendering drops the "(+N earlier)" prefix.
 */
import { describe, it, expect } from 'vitest'
import { renderTwoZoneCard } from '../two-zone-card.js'
import type { FleetMember } from '../fleet-state.js'
import type { ProgressCardState } from '../progress-card.js'

function fm(over: Partial<FleetMember>): FleetMember {
  return {
    agentId: 'aaaaaa00',
    role: 'agent',
    startedAt: 0,
    toolCount: 0,
    lastActivityAt: 0,
    lastTool: null,
    status: 'running',
    terminalAt: null,
    errorSeen: false,
    originatingTurnKey: 'k',
    ...over,
  }
}

function st(over: Partial<ProgressCardState> & { stage: ProgressCardState['stage'] }): ProgressCardState {
  return {
    turnStartedAt: 0,
    items: [],
    narratives: [],
    stage: over.stage,
    thinking: false,
    subAgents: new Map(),
    pendingAgentSpawns: new Map(),
    tasks: [],
    ...over,
  }
}

const NOW = 100_000

describe('PR-C2: two-zone card snapshot extras', () => {
  it('silent-end + bg fleet still running → header is "Ended without reply", FLEET shows bg member', () => {
    const fleet = new Map([
      ['a', fm({
        agentId: 'aaaaaa01', role: 'background', status: 'background',
        toolCount: 7, lastActivityAt: NOW - 2000,
        lastTool: { name: 'Bash', sanitisedArg: 'long.sh' },
      })],
    ])
    const out = renderTwoZoneCard({
      state: st({ stage: 'done', turnStartedAt: NOW - 30_000 }),
      fleet,
      now: NOW,
      opts: { silentEnd: true },
    })
    expect(out).toBe(
      '🙊 <b>Ended without reply</b> · ⏱ 00:30 · 🔧 7 · 🤖 1\n' +
      '\n' +
      '<b>FLEET (1)</b>\n' +
      '🌀 background <code>aaaaaa</code> · 7t · Bash <code>long.sh</code> (2s ago)',
    )
  })

  it('stalled-close header dominates regardless of fleet state', () => {
    const fleet = new Map([
      ['a', fm({ agentId: 'aaaaaa01', role: 'worker', status: 'running', toolCount: 3, lastActivityAt: NOW - 1000 })],
    ])
    const out = renderTwoZoneCard({
      state: st({ stage: 'run', turnStartedAt: NOW - 60_000 }),
      fleet,
      now: NOW,
      opts: { stalledClose: true },
    })
    // Header begins with the "Forced close" phase. We don't snapshot the
    // full body — just lock down the header and the icon.
    expect(out.startsWith('⚠ <b>Forced close</b> · ⏱ 01:00')).toBe(true)
  })

  it('parent zone overflow: "(+N earlier)" prefix when items > PARENT_BULLET_CAP=8', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      tool: 'Read',
      label: `f${i}.ts`,
    }))
    const out = renderTwoZoneCard({
      state: st({ stage: 'run', turnStartedAt: NOW - 5000, items }),
      fleet: new Map(),
      now: NOW,
    })
    // 12 items, cap 8 → 4 hidden.
    expect(out).toContain('(+4 earlier)')
    // The visible bullets are the LAST 8 (slice(-8) → f4..f11).
    // f11 is the in-flight bullet (stage=run, last index) → ◉.
    expect(out).toContain('◉ f11.ts')
    expect(out).toContain('● f4.ts')
    // f3 (the latest hidden) must not appear as a bullet.
    expect(out).not.toContain('f3.ts')
    // No <code> wrapping around row labels anymore.
    expect(out).not.toContain('<code>f11.ts</code>')
  })

  it('parent zone: in-flight last bullet uses ◉ <plain>; earlier use ● <plain>', () => {
    const items = [
      { tool: 'Read', label: 'a.ts' },
      { tool: 'Read', label: 'b.ts' },
      { tool: 'Bash', label: 'ls' },
    ]
    const out = renderTwoZoneCard({
      state: st({ stage: 'run', turnStartedAt: NOW - 5000, items }),
      fleet: new Map(),
      now: NOW,
    })
    // last item active — plain text, no <b>, no <code>, no tool prefix
    expect(out).toContain('◉ ls')
    expect(out).not.toContain('◉ <b>')
    // earlier items — plain text only, no tool prefix
    expect(out).toContain('● a.ts')
    expect(out).toContain('● b.ts')
    expect(out).not.toContain('Read <code>')
    // No <code> wrapping anywhere on parent rows.
    expect(out).not.toContain('<code>ls</code>')
    expect(out).not.toContain('<code>a.ts</code>')
  })

  it('parent zone: when stage=done all bullets render as ● (no active marker)', () => {
    const items = [
      { tool: 'Read', label: 'a.ts' },
      { tool: 'Bash', label: 'ls' },
    ]
    const out = renderTwoZoneCard({
      state: st({ stage: 'done', turnStartedAt: NOW - 5000, items }),
      fleet: new Map(),
      now: NOW,
    })
    expect(out).toContain('● a.ts')
    expect(out).toContain('● ls')
    expect(out).not.toContain('◉')
  })

  it('parent zone: row with no label falls back to humanised tool name', () => {
    const items = [
      { tool: 'TodoWrite', label: '' },
      { tool: 'Edit', label: '' },
    ]
    const out = renderTwoZoneCard({
      state: st({ stage: 'run', turnStartedAt: NOW - 5000, items }),
      fleet: new Map(),
      now: NOW,
    })
    expect(out).toContain('● updating tasks')
    expect(out).toContain('◉ editing file')
  })

  it('parent zone: row with no label on mcp tool uses mcpDisplayName', () => {
    const items = [
      { tool: 'mcp__switchroom-telegram__reply', label: '' },
    ]
    const out = renderTwoZoneCard({
      state: st({ stage: 'run', turnStartedAt: NOW - 5000, items }),
      fleet: new Map(),
      now: NOW,
    })
    expect(out).toContain('◉ Telegram: reply')
  })

  it('parent zone: HTML in label is escaped (no raw <code> styling)', () => {
    const items = [
      { tool: 'Bash', label: 'echo <hi>' },
    ]
    const out = renderTwoZoneCard({
      state: st({ stage: 'done', turnStartedAt: NOW - 5000, items }),
      fleet: new Map(),
      now: NOW,
    })
    expect(out).toContain('● echo &lt;hi&gt;')
  })
})
