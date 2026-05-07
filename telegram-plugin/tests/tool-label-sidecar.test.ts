import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolLabelSidecar } from '../tool-label-sidecar.js'

/**
 * Unit tests for tool-label-sidecar.ts (#783).
 *
 * Uses an injected scheduler so we drive polls deterministically — no
 * setTimeout, no flake.
 */

function makeManualScheduler() {
  let tickFn: (() => void) | null = null
  return {
    setInterval: (cb: () => void, _ms: number) => {
      tickFn = cb
      return Symbol('handle')
    },
    clearInterval: (_h: unknown) => {
      tickFn = null
    },
    tick: () => { if (tickFn) tickFn() },
  }
}

describe('tool-label-sidecar', () => {
  let stateDir: string
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'tool-label-sidecar-'))
  })
  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true })
  })

  it('returns undefined when sidecar file is missing', () => {
    const sched = makeManualScheduler()
    const s = createToolLabelSidecar({ stateDir, sessionId: 'no-such', scheduler: sched })
    expect(s.getLabel('whatever')).toBeUndefined()
    s.stop()
  })

  it('reads existing sidecar lines on construction', () => {
    const sessionId = 'sess1'
    const f = join(stateDir, `tool-labels-${sessionId}.jsonl`)
    writeFileSync(f, JSON.stringify({ ts: 1, tool_use_id: 'A', agent_id: 'g', label: 'Reading foo.ts', tool_name: 'Read' }) + '\n')
    const sched = makeManualScheduler()
    const s = createToolLabelSidecar({ stateDir, sessionId, scheduler: sched })
    expect(s.getLabel('A')).toBe('Reading foo.ts')
    expect(s.getLabel('B')).toBeUndefined()
    s.stop()
  })

  it('picks up appended lines on poll() (renderer reads, hook then writes)', () => {
    const sessionId = 'sess2'
    const sched = makeManualScheduler()
    const s = createToolLabelSidecar({ stateDir, sessionId, scheduler: sched })
    expect(s.getLabel('A')).toBeUndefined()

    const f = join(stateDir, `tool-labels-${sessionId}.jsonl`)
    appendFileSync(f, JSON.stringify({ ts: 1, tool_use_id: 'A', agent_id: null, label: 'Replying', tool_name: 'mcp__switchroom-telegram__reply' }) + '\n')
    s.poll()
    expect(s.getLabel('A')).toBe('Replying')
    s.stop()
  })

  it('fires onLabel subscribers as new lines arrive', () => {
    const sessionId = 'sess3'
    const sched = makeManualScheduler()
    const s = createToolLabelSidecar({ stateDir, sessionId, scheduler: sched })
    const seen: Array<[string, string]> = []
    s.onLabel((id, label) => seen.push([id, label]))

    const f = join(stateDir, `tool-labels-${sessionId}.jsonl`)
    appendFileSync(f, JSON.stringify({ ts: 1, tool_use_id: 'X', agent_id: null, label: 'Reading a.ts', tool_name: 'Read' }) + '\n')
    s.poll()
    expect(seen).toEqual([['X', 'Reading a.ts']])

    appendFileSync(f, JSON.stringify({ ts: 2, tool_use_id: 'Y', agent_id: null, label: 'Editing b.ts', tool_name: 'Edit' }) + '\n')
    s.poll()
    expect(seen).toEqual([['X', 'Reading a.ts'], ['Y', 'Editing b.ts']])
    s.stop()
  })

  it('ignores malformed JSON lines', () => {
    const sessionId = 'sess4'
    const sched = makeManualScheduler()
    const f = join(stateDir, `tool-labels-${sessionId}.jsonl`)
    writeFileSync(
      f,
      'not-json\n' +
      JSON.stringify({ tool_use_id: 'good', label: 'Saved memory', ts: 1, tool_name: 'mcp__hindsight__retain', agent_id: null }) + '\n' +
      '{partial\n',
    )
    const s = createToolLabelSidecar({ stateDir, sessionId, scheduler: sched })
    expect(s.getLabel('good')).toBe('Saved memory')
    s.stop()
  })

  it('first write wins (idempotent on duplicates)', () => {
    const sessionId = 'sess5'
    const sched = makeManualScheduler()
    const f = join(stateDir, `tool-labels-${sessionId}.jsonl`)
    writeFileSync(
      f,
      JSON.stringify({ tool_use_id: 'A', label: 'first', ts: 1, tool_name: 'Read', agent_id: null }) + '\n' +
      JSON.stringify({ tool_use_id: 'A', label: 'second', ts: 2, tool_name: 'Read', agent_id: null }) + '\n',
    )
    const s = createToolLabelSidecar({ stateDir, sessionId, scheduler: sched })
    expect(s.getLabel('A')).toBe('first')
    s.stop()
  })
})
