/**
 * RFC §Bug 7 — `SubAgentState.runInBackground` is the single source of
 * truth for the bg-vs-fg classification of a sub-agent. Previously the
 * driver consulted a parallel `cs.backgroundParentToolUseIds` Set; in
 * production the Set lookup missed at `sub_agent_started` time despite
 * the reducer correlating `parentToolUseId` correctly. The fix
 * collapses both signals onto the reducer-owned `SubAgentState`.
 *
 * Tests:
 *   1. A pending bg spawn that survives turn_end (Bug 1+5) MUST end up
 *      as a `SubAgentState` with `runInBackground:true` when its late
 *      `sub_agent_started` correlates.
 *   2. A foreground spawn yields `runInBackground:false`.
 *   3. Reverse-race adoption (orphan first, parent later) propagates
 *      the bg flag into the existing `SubAgentState`.
 *   4. An orphan sub-agent (no correlation ever happens) defaults to
 *      `runInBackground:false` — the safe default for the fleet's
 *      bg/fg classification.
 *
 * Driver-side coupling is exercised by the existing
 * `two-zone-bg-detection.test.ts` suite which now (post-fix) reads the
 * flag off `SubAgentState` instead of the Set.
 */

import { describe, expect, it } from 'vitest'
import { initialState, reduce } from '../progress-card.js'

const NOW = 1_000_000

function startedTurn(): ReturnType<typeof reduce> {
  let s = reduce(initialState(), { kind: 'enqueue', rawContent: 'go' }, NOW - 100)
  s = reduce(s, { kind: 'text', text: 'starting work' }, NOW - 90)
  return s
}

describe('reducer: SubAgentState.runInBackground propagation (RFC §Bug 7)', () => {
  it('late sub_agent_started after turn_end yields runInBackground:true SubAgentState', () => {
    // Chronology: tool_use(bg) → tool_result → turn_end → late sub_agent_started.
    // Bug 1+5 guarantees the pending entry survives turn_end; Bug 7
    // adds that the consumed pending entry's runInBackground flag
    // lands on the new SubAgentState.
    let state = startedTurn()
    state = reduce(state, {
      kind: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'tu-bg',
      input: { prompt: 'bg work', description: 'bg-job', run_in_background: true },
    }, NOW - 80)
    state = reduce(state, {
      kind: 'tool_result',
      toolUseId: 'tu-bg',
      isError: false,
      content: 'spawned',
    }, NOW - 70)
    state = reduce(state, { kind: 'turn_end', durationMs: 50 }, NOW - 60)
    // Pending entry survives (proven by pending-bg-spawn-survives-turn-end.test.ts).
    expect(state.pendingAgentSpawns.get('tu-bg')?.runInBackground).toBe(true)

    // Late sub_agent_started — reducer correlates via promptText match.
    state = reduce(state, {
      kind: 'sub_agent_started',
      agentId: 'sa-bg',
      firstPromptText: 'bg work',
      subagentType: 'worker',
    }, NOW)

    const sa = state.subAgents.get('sa-bg')
    expect(sa).toBeDefined()
    expect(sa!.parentToolUseId).toBe('tu-bg')
    expect(sa!.runInBackground).toBe(true)
  })

  it('foreground sub_agent_started yields runInBackground:false SubAgentState', () => {
    let state = startedTurn()
    state = reduce(state, {
      kind: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'tu-fg',
      input: { prompt: 'fg work', description: 'fg-job', run_in_background: false },
    }, NOW - 80)
    state = reduce(state, {
      kind: 'sub_agent_started',
      agentId: 'sa-fg',
      firstPromptText: 'fg work',
    }, NOW - 70)

    const sa = state.subAgents.get('sa-fg')
    expect(sa).toBeDefined()
    expect(sa!.runInBackground).toBe(false)
  })

  it('reverse-race adoption propagates run_in_background:true onto the existing SubAgentState', () => {
    // sub_agent_started arrives before parent's tool_use (the worker
    // JSONL appears before the assistant message containing the
    // tool_use lands). The reducer registers the sub-agent as orphan
    // (no pending match, runInBackground defaults to false). When the
    // parent's tool_use catches up, the reverse-race adoption MUST
    // re-write the SubAgentState with the late bg flag.
    let state = startedTurn()
    state = reduce(state, {
      kind: 'sub_agent_started',
      agentId: 'sa-orphan',
      firstPromptText: 'orphan-prompt',
    }, NOW - 80)
    expect(state.subAgents.get('sa-orphan')?.runInBackground).toBe(false)
    expect(state.subAgents.get('sa-orphan')?.parentToolUseId).toBe(null)

    state = reduce(state, {
      kind: 'tool_use',
      toolName: 'Agent',
      toolUseId: 'tu-late',
      input: { prompt: 'orphan-prompt', description: 'late', run_in_background: true },
    }, NOW - 70)

    const sa = state.subAgents.get('sa-orphan')
    expect(sa).toBeDefined()
    expect(sa!.parentToolUseId).toBe('tu-late')
    expect(sa!.runInBackground).toBe(true)
  })

  it('orphan sub_agent_started (no correlation arrives) defaults to runInBackground:false', () => {
    // Defensive: a SubAgentState that never finds a parent must still
    // have a well-defined bg flag (false). Without this default the
    // driver's fleet update would read `undefined === true` ⇒ false,
    // which happens to be safe, but the SubAgentState type contract
    // says the field is required, not optional.
    let state = startedTurn()
    state = reduce(state, {
      kind: 'sub_agent_started',
      agentId: 'sa-lost',
      firstPromptText: 'no-match',
    }, NOW)
    const sa = state.subAgents.get('sa-lost')
    expect(sa).toBeDefined()
    expect(sa!.runInBackground).toBe(false)
  })
})
