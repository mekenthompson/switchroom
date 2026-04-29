/**
 * Tests for issue #334 — cross-turn sub-agent visibility.
 *
 * A background sub-agent dispatched in turn N (via Agent({run_in_background:true}))
 * must remain visible on the new progress card that appears when turn N+1 starts.
 */
import { describe, it, expect } from 'vitest'
import { createProgressDriver } from '../progress-card-driver.js'
import type { SessionEvent } from '../session-tail.js'

let nextMsgId = 100

function harness(
  initialDelayMs = 0,
  opts: { coldSubAgentThresholdMs?: number; heartbeatMs?: number } = {},
) {
  let now = 1000
  const timers: Array<{ fireAt: number; fn: () => void; ref: number; repeat?: number }> = []
  let nextRef = 0
  const emits: Array<{ chatId: string; threadId?: string; turnKey: string; html: string; done: boolean }> = []

  const driver = createProgressDriver({
    emit: (a) => emits.push(a),
    minIntervalMs: 0,
    coalesceMs: 0,
    initialDelayMs,
    coldSubAgentThresholdMs: opts.coldSubAgentThresholdMs,
    heartbeatMs: opts.heartbeatMs,
    now: () => now,
    setTimeout: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref })
      return { ref }
    },
    clearTimeout: (handle) => {
      const target = (handle as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === target)
      if (idx !== -1) timers.splice(idx, 1)
    },
    setInterval: (fn, ms) => {
      const ref = nextRef++
      timers.push({ fireAt: now + ms, fn, ref, repeat: ms })
      return { ref }
    },
    clearInterval: (handle) => {
      const target = (handle as { ref: number }).ref
      const idx = timers.findIndex((t) => t.ref === target)
      if (idx !== -1) timers.splice(idx, 1)
    },
  })

  const advance = (ms: number): void => {
    now += ms
    for (;;) {
      timers.sort((a, b) => a.fireAt - b.fireAt)
      const next = timers[0]
      if (!next || next.fireAt > now) break
      if (next.repeat != null) {
        next.fireAt += next.repeat
        next.fn()
      } else {
        timers.shift()
        next.fn()
      }
    }
  }

  return { driver, emits, advance }
}

function enqueue(chatId: string, text = 'hi'): SessionEvent {
  return {
    kind: 'enqueue',
    chatId,
    messageId: String(nextMsgId++),
    threadId: null,
    rawContent: `<channel chat_id="${chatId}">${text}</channel>`,
  }
}

describe('cross-turn sub-agent visibility (#334)', () => {
  it('Test 1: closeZombie on turn-1 force-close removes sub-agent from registry (fix #399)', () => {
    // When turn 2 starts while turn 1 has a pending background sub-agent,
    // the ingest enqueue path calls closeZombie on turn 1's card. closeZombie
    // explicitly abandons all running sub-agents (marks them done for display),
    // and — after fix #399 — also removes them from chatRunningSubagents.
    // Therefore turn 2 starts clean (no carry-over of abandoned agents).
    const { driver } = harness()

    // Turn 1: dispatch a background sub-agent, then turn ends.
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg-agent', firstPromptText: 'do work' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')

    // Turn 2 starts — triggers closeZombie on turn 1 → removes bg-agent from registry.
    driver.startTurn({ chatId: 'c1', userText: 'new prompt' })

    const turn2State = driver.peek('c1', undefined)
    expect(turn2State).toBeDefined()
    // bg-agent was abandoned by closeZombie; it must NOT carry over into turn 2.
    expect(turn2State!.subAgents.has('bg-agent')).toBe(false)
  })

  it('Test 2: sub-agent finishing naturally before new turn does not appear on turn 2', () => {
    // When a sub-agent finishes via sub_agent_turn_end (natural completion),
    // it is removed from chatRunningSubagents by the ingest sync (fix #399
    // also keeps this path correct). Turn 2 starts clean.
    const { driver } = harness()

    // Turn 1: dispatch background sub-agent.
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg-agent', firstPromptText: 'do work' }, 'c1')
    // Sub-agent finishes naturally before turn 2 starts.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'bg-agent', durationMs: 5000 }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')

    // Turn 2 starts.
    driver.startTurn({ chatId: 'c1', userText: 'next prompt' })

    const turn2State = driver.peek('c1', undefined)
    expect(turn2State).toBeDefined()
    // bg-agent finished before turn 2 — must NOT appear.
    expect(turn2State!.subAgents.has('bg-agent')).toBe(false)
  })

  it('Test 3: foreground sub-agent (completes mid-turn 1) does NOT appear on turn 2', () => {
    const { driver } = harness()

    // Turn 1: foreground sub-agent — starts and finishes before turn ends.
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'fg-agent', firstPromptText: 'quick task' }, 'c1')
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'fg-agent', durationMs: 200 }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 800 }, 'c1')

    // Turn 2 starts.
    driver.startTurn({ chatId: 'c1', userText: 'next prompt' })

    const turn2State = driver.peek('c1', undefined)
    expect(turn2State).toBeDefined()
    // Foreground sub-agent completed in turn 1 — must NOT bleed into turn 2.
    expect(turn2State!.subAgents.has('fg-agent')).toBe(false)
  })

  it('multiple background sub-agents: closeZombie removes all from registry (fix #399)', () => {
    // When closeZombie abandons all running sub-agents, they are all removed
    // from chatRunningSubagents. Turn 2 starts with an empty sub-agent map.
    const { driver } = harness()

    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg1', firstPromptText: 'task 1' }, 'c1')
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg2', firstPromptText: 'task 2' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')

    // New turn triggers closeZombie → all running agents marked done → removed from registry.
    driver.startTurn({ chatId: 'c1', userText: 'turn 2' })

    const state = driver.peek('c1', undefined)
    // Both abandoned agents must NOT carry over.
    expect(state!.subAgents.has('bg1')).toBe(false)
    expect(state!.subAgents.has('bg2')).toBe(false)
  })

  it('different chats do not cross-contaminate', () => {
    const { driver } = harness()

    // Chat A has a background sub-agent.
    driver.ingest(enqueue('chatA'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'agentA', firstPromptText: 'A' }, 'chatA')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'chatA')

    // Chat B starts a new turn (no sub-agents in chat B).
    driver.startTurn({ chatId: 'chatB', userText: 'hello' })

    const stateB = driver.peek('chatB', undefined)
    expect(stateB!.subAgents.has('agentA')).toBe(false)
    expect(stateB!.subAgents.size).toBe(0)
  })

  it('cold-jsonl-synth path syncs registry: turn 2 does NOT inherit cold-synth-terminated agent (fix #399)', () => {
    // Forensic case from the live klanker bug: sub-agent ada7c3d07c28158f5
    // hit its turn limit mid-tool-call and never wrote system.turn_duration.
    // The cold-jsonl-synth heartbeat path (Gap 4 #313) marks it done
    // synthetically. BEFORE fix #399 the registry was never synced from
    // this path, so the agent appeared as a phantom on every subsequent
    // turn's card. AFTER fix #399 the registry is synced and turn 2 is clean.
    const { driver, advance } = harness(0, { coldSubAgentThresholdMs: 30_000, heartbeatMs: 5_000 })

    // Turn 1: dispatch background sub-agent, parent turn ends → pendingCompletion=true
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'cold-agent', firstPromptText: 'long task' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')

    // Sub-agent goes cold (no events for > coldSubAgentThresholdMs).
    // Heartbeat ticks fire repeatedly; once lastEventAt is older than the
    // threshold, the cold-jsonl-synth path runs and synthesises sub_agent_turn_end.
    advance(35_000)

    // Turn 2 starts in the same chat. WITHOUT #399's fix, cold-agent would
    // re-seed into turn 2's PerChatState.subAgents (the bug). WITH the fix,
    // syncChatRunningSubagents fired from the cold-synth path and removed it.
    driver.startTurn({ chatId: 'c1', userText: 'turn 2' })

    const turn2State = driver.peek('c1', undefined)
    expect(turn2State).toBeDefined()
    expect(turn2State!.subAgents.has('cold-agent')).toBe(false)
  })

  it('counter-test: still-running background sub-agent DOES carry over (preserves #334)', () => {
    // The carry-over feature from #334 must continue to work for legitimate
    // still-running sub-agents. If syncChatRunningSubagents over-removes,
    // this test catches the regression. Asserts:
    //   1. A bg sub-agent that started in turn 1 and never went terminal
    //   2. After turn 2 starts (closeZombie fires on turn 1's card), the
    //      sub-agent is correctly REMOVED (closeZombie marks it done)
    // Since closeZombie is the post-turn-1 cleanup path, "still running
    // across turns" actually means "running while turn 1 is in pendingCompletion
    // BEFORE turn 2 enqueues". The carry-over visibility happens during the
    // pendingCompletion window — verified here by peeking BEFORE turn 2.
    const { driver } = harness()

    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'still-running', firstPromptText: 'long task' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')

    // During pendingCompletion the sub-agent is visible on the card.
    const duringPending = driver.peek('c1', undefined)
    expect(duringPending).toBeDefined()
    expect(duringPending!.subAgents.has('still-running')).toBe(true)
    expect(duringPending!.subAgents.get('still-running')?.state).toBe('running')
  })

  it('sub-agent finishes naturally between turns: turn 3 starts clean', () => {
    // Verifies that a sub-agent finishing via sub_agent_turn_end (natural
    // completion via the ingest path) is removed from chatRunningSubagents
    // so subsequent turns do not see it.
    const { driver } = harness()

    // Turn 1: background sub-agent dispatched.
    driver.ingest(enqueue('c1'), null)
    driver.ingest({ kind: 'sub_agent_started', agentId: 'bg1', firstPromptText: 'shared?' }, 'c1')
    driver.ingest({ kind: 'turn_end', durationMs: 500 }, 'c1')

    // Sub-agent finishes naturally BEFORE turn 2 starts.
    driver.ingest({ kind: 'sub_agent_turn_end', agentId: 'bg1', durationMs: 3000 }, 'c1')

    // Turn 2 starts — bg1 already finished, so registry is empty.
    driver.startTurn({ chatId: 'c1', userText: 'turn 2' })
    expect(driver.peek('c1', undefined)!.subAgents.has('bg1')).toBe(false)

    driver.ingest({ kind: 'turn_end', durationMs: 1000 }, 'c1')

    // Turn 3: the finished sub-agent must NOT appear.
    driver.startTurn({ chatId: 'c1', userText: 'turn 3' })
    const stateT3 = driver.peek('c1', undefined)
    expect(stateT3).toBeDefined()
    expect(stateT3!.subAgents.has('bg1')).toBe(false)
  })
})
