/**
 * Unit tests for syncChatRunningSubagents (issue #399).
 *
 * Tests the helper directly with synthetic ProgressCardState objects so the
 * registry-update logic can be verified in isolation from the driver.
 */
import { describe, it, expect } from 'vitest'
import { syncChatRunningSubagents } from '../progress-card-driver.js'
import { initialState } from '../progress-card.js'
import type { SubAgentState } from '../progress-card.js'

function makeState(agents: Record<string, 'running' | 'done' | 'failed'> = {}) {
  const state = initialState()
  const subAgents = new Map<string, SubAgentState>()
  for (const [id, agentState] of Object.entries(agents)) {
    subAgents.set(id, {
      agentId: id,
      state: agentState,
      startedAt: 1000,
      finishedAt: agentState !== 'running' ? 2000 : undefined,
      firstPromptText: 'test',
      pendingPreamble: null,
      spawnedByToolUseId: undefined,
      orphan: false,
    } as SubAgentState)
  }
  return { ...state, subAgents }
}

describe('syncChatRunningSubagents (unit)', () => {
  it('removes agents that transition running -> done', () => {
    const prev = makeState({ agent1: 'running' })
    const next = makeState({ agent1: 'done' })
    const registry = new Map<string, Map<string, SubAgentState>>()
    registry.set('chat1', new Map([['agent1', prev.subAgents.get('agent1')!]]))

    syncChatRunningSubagents(prev, next, 'chat1', registry)

    expect(registry.get('chat1')?.has('agent1')).toBe(false)
  })

  it('removes agents that transition running -> failed', () => {
    const prev = makeState({ agent1: 'running' })
    const next = makeState({ agent1: 'failed' })
    const registry = new Map<string, Map<string, SubAgentState>>()
    registry.set('chat1', new Map([['agent1', prev.subAgents.get('agent1')!]]))

    syncChatRunningSubagents(prev, next, 'chat1', registry)

    expect(registry.get('chat1')?.has('agent1')).toBe(false)
  })

  it('does NOT remove agents still running', () => {
    const prev = makeState({ agent1: 'running' })
    // next also has agent1 still running (state didn't change)
    const next = { ...prev, subAgents: new Map(prev.subAgents) }
    const registry = new Map<string, Map<string, SubAgentState>>()
    registry.set('chat1', new Map([['agent1', prev.subAgents.get('agent1')!]]))

    syncChatRunningSubagents(prev, next, 'chat1', registry)

    expect(registry.get('chat1')?.has('agent1')).toBe(true)
  })

  it('is a no-op when prev.subAgents and next.subAgents are the same object', () => {
    const prev = makeState({ agent1: 'running' })
    // Same object reference — no change happened.
    const next = prev
    const registry = new Map<string, Map<string, SubAgentState>>()
    registry.set('chat1', new Map([['agent1', prev.subAgents.get('agent1')!]]))

    syncChatRunningSubagents(prev, next, 'chat1', registry)

    // Nothing should change since subAgents is the same reference.
    expect(registry.get('chat1')?.has('agent1')).toBe(true)
  })

  it('is a no-op when chatRunningSubagents has no entry for the cBaseKey', () => {
    const prev = makeState({ agent1: 'running' })
    const next = makeState({ agent1: 'done' })
    // Registry has an entry for 'other-chat', not 'chat1'.
    const registry = new Map<string, Map<string, SubAgentState>>()
    registry.set('other-chat', new Map([['agent1', prev.subAgents.get('agent1')!]]))

    // Should not throw and should not touch other-chat.
    syncChatRunningSubagents(prev, next, 'chat1', registry)

    // other-chat entry must be untouched.
    expect(registry.get('other-chat')?.has('agent1')).toBe(true)
    // chat1 was never in registry — still absent.
    expect(registry.has('chat1')).toBe(false)
  })

  it('adds newly-running agents to the registry', () => {
    const prev = makeState({})
    const next = makeState({ agent1: 'running' })
    const registry = new Map<string, Map<string, SubAgentState>>()

    syncChatRunningSubagents(prev, next, 'chat1', registry)

    expect(registry.get('chat1')?.has('agent1')).toBe(true)
    expect(registry.get('chat1')?.get('agent1')?.state).toBe('running')
  })

  it('removes agents deleted from subAgents entirely', () => {
    const prev = makeState({ agent1: 'running' })
    // next has an empty subAgents map (agent removed).
    const next = makeState({})
    const registry = new Map<string, Map<string, SubAgentState>>()
    registry.set('chat1', new Map([['agent1', prev.subAgents.get('agent1')!]]))

    syncChatRunningSubagents(prev, next, 'chat1', registry)

    expect(registry.get('chat1')?.has('agent1')).toBe(false)
  })
})
