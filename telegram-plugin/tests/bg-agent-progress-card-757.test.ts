/**
 * Regression tests for #757 — progress card goes silent for background
 * Agent workers (run_in_background: true).
 *
 * Root cause: `applyToolUse` in fleet-state.ts only promoted `stuck →
 * running`; background members stayed at `status: 'background'` even
 * while actively running tools. The fleet row rendered ⏸ idle instead
 * of ↻ + last-tool, so the card appeared frozen.
 *
 * Fix: applyToolUse now also promotes `background → running` on the
 * first live tool event. A separate sticky `isBackgroundDispatch` flag
 * preserves the background-carry semantics used by hasLiveBackground
 * (keeps PerChatState alive past parent turn_end until bg member
 * reaches terminal status).
 */

import { describe, it, expect } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import { applyToolUse, createFleetMember, hasLiveBackground } from '../fleet-state.js'
import type { SessionEvent } from '../session-tail.js'

const T0 = 1_700_000_000_000

// ─── Pure-function unit tests ────────────────────────────────────────────────

describe('applyToolUse: background → running promotion (#757)', () => {
  it('promotes background to running on first tool event', () => {
    const m = { ...createFleetMember({ agentId: 'a', role: 'worker', startedAt: T0, originatingTurnKey: 'k', isBackgroundDispatch: true }), status: 'background' as const }
    const after = applyToolUse(m, 'Read', { file_path: '/foo/bar.ts' }, T0 + 1000)
    expect(after.status).toBe('running')
    expect(after.lastTool?.name).toBe('Read')
  })

  it('preserves isBackgroundDispatch after promotion', () => {
    const m = { ...createFleetMember({ agentId: 'a', role: 'worker', startedAt: T0, originatingTurnKey: 'k', isBackgroundDispatch: true }), status: 'background' as const }
    const after = applyToolUse(m, 'Bash', { command: 'ls' }, T0 + 1000)
    expect(after.isBackgroundDispatch).toBe(true)
  })

  it('does not affect foreground members (status stays running)', () => {
    const m = createFleetMember({ agentId: 'a', role: 'worker', startedAt: T0, originatingTurnKey: 'k' })
    const after = applyToolUse(m, 'Read', { file_path: '/x' }, T0 + 1000)
    expect(after.status).toBe('running')
    expect(after.isBackgroundDispatch).toBe(false)
  })
})

describe('hasLiveBackground: sticky flag survives status promotion (#757)', () => {
  it('returns true when background member is promoted to running (not yet terminal)', () => {
    const fleet = new Map([
      ['a', { ...createFleetMember({ agentId: 'a', role: 'w', startedAt: T0, originatingTurnKey: 'k', isBackgroundDispatch: true }), status: 'running' as const }],
    ])
    expect(hasLiveBackground(fleet)).toBe(true)
  })

  it('returns false when background member reaches terminal status', () => {
    const fleet = new Map([
      ['a', { ...createFleetMember({ agentId: 'a', role: 'w', startedAt: T0, originatingTurnKey: 'k', isBackgroundDispatch: true }), status: 'done' as const, terminalAt: T0 + 5000 }],
    ])
    expect(hasLiveBackground(fleet)).toBe(false)
  })

  it('returns false when no members are background dispatches', () => {
    const fleet = new Map([
      ['a', createFleetMember({ agentId: 'a', role: 'w', startedAt: T0, originatingTurnKey: 'k' })],
    ])
    expect(hasLiveBackground(fleet)).toBe(false)
  })
})

// ─── Integration: driver-level lifecycle ─────────────────────────────────────

function harness() {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const completions: string[] = []
  const driver = createProgressDriver({
    emit: () => {},
    minIntervalMs: 500,
    coalesceMs: 400,
    initialDelayMs: 0,
    promoteAfterMs: 999_999,
    onTurnComplete: (s) => completions.push(s.turnKey),
    now: () => now,
    setTimeout: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref })
      return { ref }
    },
    clearTimeout: (h) => {
      const ref = (h as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === ref)
      if (idx !== -1) timers.splice(idx, 1)
    },
    setInterval: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref, repeat: ms })
      return { ref }
    },
    clearInterval: (h) => {
      const ref = (h as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === ref)
      if (idx !== -1) timers.splice(idx, 1)
    },
  })
  function advance(ms: number) {
    const target = now + ms
    while (true) {
      const due = timers.filter((t) => t.fireAt <= target).sort((a, b) => a.fireAt - b.fireAt)
      if (due.length === 0) break
      const t = due[0]
      now = t.fireAt
      t.fn()
      if (t.repeat) t.fireAt = now + t.repeat
      else timers.splice(timers.indexOf(t), 1)
    }
    now = target
  }
  return { driver, completions, advance, getNow: () => now }
}

const enqueue = (chatId: string): SessionEvent => ({
  kind: 'enqueue',
  chatId,
  messageId: '1',
  threadId: null,
  rawContent: `<channel chat_id="${chatId}">go</channel>`,
})

describe('driver integration: bg worker tool activity (#757)', () => {
  it('background fleet member promotes to running when tool events arrive', () => {
    const { driver } = harness()
    const CHAT = 'c1'
    driver.ingest(enqueue(CHAT), null)
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'tu1', input: { prompt: 'bg work', run_in_background: true } },
      CHAT,
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'sa1', firstPromptText: 'bg work' }, CHAT)

    // Initial state: background.
    expect(driver.peekFleet(CHAT)!.get('sa1')!.status).toBe('background')

    // Tool activity arrives from the sub-agent JSONL.
    driver.ingest({ kind: 'sub_agent_tool_use', agentId: 'sa1', toolUseId: 't1', toolName: 'Bash', input: { command: 'npm test' } }, CHAT)

    const m = driver.peekFleet(CHAT)!.get('sa1')!
    // Promoted to running — card now shows active tool work.
    expect(m.status).toBe('running')
    expect(m.lastTool?.name).toBe('Bash')
    // Sticky flag preserved — bg-carry still works.
    expect(m.isBackgroundDispatch).toBe(true)
  })

  it('background carry survives promotion: turn completion holds until bg reaches terminal', () => {
    const { driver, completions } = harness()
    const CHAT = 'c2'
    driver.ingest(enqueue(CHAT), null)
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'tu1', input: { prompt: 'bg', run_in_background: true } },
      CHAT,
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'sa1', firstPromptText: 'bg' }, CHAT)
    // Bg worker starts doing tool work — status becomes running.
    driver.ingest({ kind: 'sub_agent_tool_use', agentId: 'sa1', toolUseId: 't1', toolName: 'Read', input: { file_path: '/a' } }, CHAT)
    expect(driver.peekFleet(CHAT)!.get('sa1')!.status).toBe('running')

    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply' }, CHAT)
    driver.recordOutboundDelivered(CHAT)
    // Parent ends while bg worker is still running.
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, CHAT)

    // Turn completion must NOT fire — bg worker is still active.
    expect(completions.length).toBe(0)

    // Bg worker finishes.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'sa1' }, CHAT)
    expect(completions.length).toBe(1)
  })

  it('terminal state reached after promotion fires completion correctly', () => {
    const { driver, completions } = harness()
    const CHAT = 'c3'
    driver.ingest(enqueue(CHAT), null)
    driver.ingest(
      { kind: 'tool_use', toolName: 'Agent', toolUseId: 'tu1', input: { prompt: 'bg', run_in_background: true } },
      CHAT,
    )
    driver.ingest({ kind: 'sub_agent_started', agentId: 'sa1', firstPromptText: 'bg' }, CHAT)
    driver.ingest({ kind: 'sub_agent_tool_use', agentId: 'sa1', toolUseId: 't1', toolName: 'Write', input: { file_path: '/out.ts' } }, CHAT)

    driver.ingest({ kind: 'tool_use', toolName: 'mcp__switchroom-telegram__reply' }, CHAT)
    driver.recordOutboundDelivered(CHAT)
    driver.ingest({ kind: 'turn_end', durationMs: 100 }, CHAT)
    // Peek before sub_agent_turn_end so fleet is still live.
    expect(driver.peekFleet(CHAT)!.get('sa1')!.status).toBe('running')
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'sa1' }, CHAT)
    expect(completions.length).toBe(1)
  })
})
