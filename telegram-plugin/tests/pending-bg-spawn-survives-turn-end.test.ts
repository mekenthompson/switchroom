/**
 * Regression gate for RFC Phase 2 §Bug 1
 * (reference/sub-agent-visibility-rfc.md).
 *
 * Background sub-agents arrive AFTER the parent's `turn_end` event —
 * the parent's reply lands in seconds, the bg worker takes longer to
 * spin up its JSONL transcript. Before the fix, the reducer's
 * `turn_end` case cleared `pendingAgentSpawns` wholesale; the eventual
 * `sub_agent_started` then registered as an orphan with
 * `pendingSpawns=0`, derailing both the `isBackgroundDispatch` flag
 * AND the header-phase resolver downstream.
 *
 * After the fix: `turn_end` preserves entries whose `runInBackground`
 * is true. Foreground entries are still cleared (no behaviour change
 * for the common case).
 *
 * Surfaced by `telegram-plugin/uat/scenarios/
 * bg-sub-agent-dispatch-dm.test.ts` running against real Telegram.
 */

import { describe, expect, it } from 'vitest'
import { initialState, reduce } from '../progress-card.js'

const NOW = 1_000_000

function startedTurn(): ReturnType<typeof reduce> {
  // Drive the reducer through `enqueue` → `text` so it's in a real
  // post-`turn_start` state with `turnStartedAt` set. Direct
  // construction of a state with a populated `pendingAgentSpawns`
  // would bypass the tool_use code path we want to exercise.
  let s = reduce(initialState(), {
    kind: 'enqueue',
    rawContent: 'test inbound',
  }, NOW - 100)
  s = reduce(s, { kind: 'text', text: 'starting work' }, NOW - 90)
  return s
}

describe('reducer: turn_end pending-spawn preservation (RFC §Bug 1)', () => {
  it('preserves a pending Agent(run_in_background:true) spawn across turn_end', () => {
    let state = startedTurn()
    state = reduce(state, {
      kind: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'tu-bg-1',
      input: {
        prompt: 'run a long background task',
        description: 'bg worker',
        subagent_type: 'general-purpose',
        run_in_background: true,
      },
    }, NOW - 80)
    expect(state.pendingAgentSpawns.size).toBe(1)
    expect(state.pendingAgentSpawns.get('tu-bg-1')?.runInBackground).toBe(true)

    state = reduce(state, { kind: 'turn_end', durationMs: 50 }, NOW)
    // The bg pending spawn MUST survive. The corresponding
    // sub_agent_started event will arrive later (worker has its own
    // startup latency) and needs to match against this entry to be
    // correlated rather than registered as an orphan.
    expect(state.pendingAgentSpawns.size).toBe(1)
    expect(state.pendingAgentSpawns.get('tu-bg-1')?.runInBackground).toBe(true)
    expect(state.stage).toBe('done')
  })

  it('still clears foreground pending Agent spawns at turn_end (no regression)', () => {
    let state = startedTurn()
    state = reduce(state, {
      kind: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'tu-fg-1',
      input: {
        prompt: 'run a quick foreground task',
        description: 'fg worker',
        subagent_type: 'general-purpose',
        run_in_background: false,
      },
    }, NOW - 80)
    expect(state.pendingAgentSpawns.get('tu-fg-1')?.runInBackground).toBe(false)

    state = reduce(state, { kind: 'turn_end', durationMs: 50 }, NOW)
    // Foreground spawns SHOULD clear — if a foreground Agent's
    // sub_agent_started never arrived during the turn, the pending
    // entry is dead and shouldn't leak into the next turn.
    expect(state.pendingAgentSpawns.size).toBe(0)
  })

  it('partial preservation: bg survives, fg clears, mixed map', () => {
    let state = startedTurn()
    state = reduce(state, {
      kind: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'tu-bg',
      input: { prompt: 'bg', run_in_background: true },
    }, NOW - 80)
    state = reduce(state, {
      kind: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'tu-fg',
      input: { prompt: 'fg', run_in_background: false },
    }, NOW - 70)
    expect(state.pendingAgentSpawns.size).toBe(2)

    state = reduce(state, { kind: 'turn_end', durationMs: 50 }, NOW)
    expect(state.pendingAgentSpawns.size).toBe(1)
    expect(state.pendingAgentSpawns.has('tu-bg')).toBe(true)
    expect(state.pendingAgentSpawns.has('tu-fg')).toBe(false)
  })

  it('Agent without explicit run_in_background defaults to foreground (cleared at turn_end)', () => {
    let state = startedTurn()
    state = reduce(state, {
      kind: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'tu-default',
      input: {
        prompt: 'no flag',
        // run_in_background omitted — should default to false
      },
    }, NOW - 80)
    expect(state.pendingAgentSpawns.get('tu-default')?.runInBackground).toBe(false)

    state = reduce(state, { kind: 'turn_end', durationMs: 50 }, NOW)
    expect(state.pendingAgentSpawns.size).toBe(0)
  })

  it('matches sub_agent_started arriving AFTER turn_end (end-to-end correlation)', () => {
    let state = startedTurn()
    state = reduce(state, {
      kind: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'tu-bg-correlate',
      input: { prompt: 'bg correlate test', run_in_background: true },
    }, NOW - 80)
    // Parent turn ends BEFORE the bg worker's sub_agent_started fires.
    state = reduce(state, { kind: 'turn_end', durationMs: 50 }, NOW)
    expect(state.pendingAgentSpawns.size).toBe(1)

    // Now the bg worker's sub_agent_started lands. It MUST find the
    // preserved pending entry and correlate (NOT register as orphan).
    state = reduce(state, {
      kind: 'sub_agent_started',
      agentId: 'agt-bg-correlated',
      subagentType: 'general-purpose',
      firstPromptText: 'bg correlate test',
    }, NOW + 1_000)

    const sub = state.subAgents.get('agt-bg-correlated')
    expect(sub).toBeDefined()
    // Correlation succeeded — parentToolUseId points back at the
    // pending entry the bg dispatch left behind. Pre-fix this was
    // null (orphan); post-fix it's 'tu-bg-correlate'.
    expect(sub!.parentToolUseId).toBe('tu-bg-correlate')
    // And the pending map is now empty — entry consumed by the match.
    expect(state.pendingAgentSpawns.size).toBe(0)
  })
})
