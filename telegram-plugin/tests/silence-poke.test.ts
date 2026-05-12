import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  startTurn,
  noteOutbound,
  noteSubagentDispatch,
  noteThinking,
  consumeArmedPoke,
  endTurn,
  silencePokeEnabled,
  __tickForTests,
  __setDepsForTests,
  __getStateForTests,
  __resetAllForTests,
  DEFAULT_THRESHOLDS,
  type SilencePokeMetric,
  type FrameworkFallbackContext,
} from '../silence-poke.js'

const ORIGINAL_KILL_SWITCH = process.env.SWITCHROOM_DISABLE_SILENCE_POKE

interface TestFixtures {
  emitted: SilencePokeMetric[]
  fallbacks: FrameworkFallbackContext[]
}

function setupDeps(opts?: { thresholds?: Partial<typeof DEFAULT_THRESHOLDS> }): TestFixtures {
  const fixtures: TestFixtures = { emitted: [], fallbacks: [] }
  __setDepsForTests({
    emitMetric: (e) => fixtures.emitted.push(e),
    onFrameworkFallback: (ctx) => { fixtures.fallbacks.push(ctx) },
    thresholdsMs: { ...DEFAULT_THRESHOLDS, ...(opts?.thresholds ?? {}) },
  })
  return fixtures
}

beforeEach(() => {
  __resetAllForTests()
  delete process.env.SWITCHROOM_DISABLE_SILENCE_POKE
})

afterEach(() => {
  __resetAllForTests()
  if (ORIGINAL_KILL_SWITCH != null) process.env.SWITCHROOM_DISABLE_SILENCE_POKE = ORIGINAL_KILL_SWITCH
  else delete process.env.SWITCHROOM_DISABLE_SILENCE_POKE
})

describe('silence-poke — kill switch', () => {
  it('startTurn is a no-op when SWITCHROOM_DISABLE_SILENCE_POKE=1', () => {
    process.env.SWITCHROOM_DISABLE_SILENCE_POKE = '1'
    expect(silencePokeEnabled()).toBe(false)
    startTurn('k', 1000)
    expect(__getStateForTests('k')).toBeUndefined()
  })

  it('startTurn is a no-op when SWITCHROOM_DISABLE_SILENCE_POKE=true', () => {
    process.env.SWITCHROOM_DISABLE_SILENCE_POKE = 'true'
    startTurn('k', 1000)
    expect(__getStateForTests('k')).toBeUndefined()
  })

  it('is enabled when kill switch is unset', () => {
    expect(silencePokeEnabled()).toBe(true)
    startTurn('k', 1000)
    expect(__getStateForTests('k')).toBeDefined()
  })
})

describe('silence-poke — escalation ladder', () => {
  it('soft poke fires at 75s', () => {
    const fx = setupDeps()
    startTurn('chat:0', 0)

    __tickForTests(70_000) // before threshold
    expect(consumeArmedPoke()).toBeNull()
    expect(fx.emitted).toHaveLength(0)

    __tickForTests(75_000) // at threshold
    expect(fx.emitted).toEqual([
      expect.objectContaining({ kind: 'silence_poke_fired', level: 'soft', subagent_wait: false }),
    ])
    const text = consumeArmedPoke()
    expect(text).toContain('[silence-poke]')
    expect(text).toContain('75s')
  })

  it('firm poke fires at 180s after soft', () => {
    const fx = setupDeps()
    startTurn('chat:0', 0)
    __tickForTests(75_000)
    consumeArmedPoke() // drain the soft
    __tickForTests(180_000)
    expect(fx.emitted.map((e) => e.kind)).toEqual([
      'silence_poke_fired',
      'silence_poke_fired',
    ])
    expect(fx.emitted[1]).toMatchObject({ level: 'firm' })
    const firm = consumeArmedPoke()
    expect(firm).toContain('3 minutes silent')
  })

  it('framework fallback fires at 300s with kind=working when no thinking signal', () => {
    const fx = setupDeps()
    startTurn('chatX:42', 0)
    __tickForTests(75_000)
    __tickForTests(180_000)
    __tickForTests(300_000)
    expect(fx.fallbacks).toEqual([
      expect.objectContaining({ chatId: 'chatX', threadId: 42, fallbackKind: 'working' }),
    ])
    expect(fx.emitted.at(-1)).toMatchObject({ kind: 'silence_fallback_sent', fallback_kind: 'working' })
  })

  it('framework fallback fires with kind=thinking if a thinking event landed within 30s', () => {
    const fx = setupDeps()
    startTurn('c:0', 0)
    noteThinking('c:0', 280_000)
    __tickForTests(75_000)
    __tickForTests(180_000)
    __tickForTests(300_000)
    expect(fx.fallbacks).toEqual([
      expect.objectContaining({ fallbackKind: 'thinking' }),
    ])
  })

  it('framework fallback fires at most once per turn', () => {
    const fx = setupDeps()
    startTurn('c:0', 0)
    __tickForTests(75_000)
    __tickForTests(180_000)
    __tickForTests(300_000)
    __tickForTests(450_000) // continued silence
    __tickForTests(600_000)
    expect(fx.fallbacks).toHaveLength(1)
  })
})

describe('silence-poke — outbound resets clock + success measurement', () => {
  it('noteOutbound resets the silence clock', () => {
    setupDeps()
    startTurn('k', 0)
    noteOutbound('k', 50_000)
    __tickForTests(120_000) // 70s after outbound — under 75s soft threshold
    expect(consumeArmedPoke()).toBeNull()
  })

  it('emits silence_poke_succeeded when outbound lands within success window after a poke', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000) // soft poke armed
    noteOutbound('k', 80_000) // 5s later — within 15s success window
    expect(fx.emitted.map((e) => e.kind)).toContain('silence_poke_succeeded')
    const success = fx.emitted.find((e) => e.kind === 'silence_poke_succeeded')!
    expect(success).toMatchObject({ level: 'soft', latency_ms: 5_000 })
  })

  it('does NOT emit silence_poke_succeeded if outbound is later than the success window', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000)
    noteOutbound('k', 95_000) // 20s later — outside 15s window
    expect(fx.emitted.filter((e) => e.kind === 'silence_poke_succeeded')).toHaveLength(0)
  })

  it('outbound resets pokesFired so the next 75s silence can re-arm', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000) // soft fires
    noteOutbound('k', 100_000) // reset
    __tickForTests(180_000) // 80s since outbound — under threshold
    __tickForTests(180_000 + 50_000) // would be 130s if not reset; still no fire because clock zero = 100_000, so silence = 130s
    // Actually 230 - 100 = 130s past outbound, > 75s soft threshold:
    expect(fx.emitted.filter((e) => e.kind === 'silence_poke_fired')).toHaveLength(2)
    expect(fx.emitted.filter((e) => e.kind === 'silence_poke_fired').at(-1)).toMatchObject({ level: 'soft' })
  })
})

describe('silence-poke — subagent dispatch extension', () => {
  it('extends soft threshold to 300s when noteSubagentDispatch was called', () => {
    const fx = setupDeps()
    startTurn('k', 0)
    noteSubagentDispatch('k')
    __tickForTests(120_000) // past 75s but under 300s subagent threshold
    expect(fx.emitted).toHaveLength(0)
    __tickForTests(300_000)
    expect(fx.emitted).toHaveLength(1)
    expect(fx.emitted[0]).toMatchObject({ level: 'soft', subagent_wait: true })
  })

  it('subagent flag PERSISTS through narrating outbound (PR4 fix)', () => {
    // Reviewer note from PR2 #1125 — the parent's "spinning up @reviewer"
    // narration is the outbound that opens the wait. Clearing the
    // subagent flag at that moment would defeat the extended-threshold
    // guarantee for the wait that follows. The flag must persist until
    // endTurn().
    const fx = setupDeps()
    startTurn('k', 0)
    noteSubagentDispatch('k')
    noteOutbound('k', 60_000) // parent narrates "spinning up @reviewer"
    // Subagent wait continues. With the flag persistent, soft threshold
    // is still 300s, so a 90s gap should NOT fire.
    __tickForTests(60_000 + 90_000)
    expect(fx.emitted.filter((e) => e.kind === 'silence_poke_fired')).toHaveLength(0)
    // At 300s past the outbound, the soft poke fires (subagent wait
    // is genuinely long).
    __tickForTests(60_000 + 300_000)
    expect(fx.emitted.filter((e) => e.kind === 'silence_poke_fired')).toHaveLength(1)
    expect(fx.emitted[0]).toMatchObject({ level: 'soft', subagent_wait: true })
  })

  it('subagent flag clears on endTurn', () => {
    setupDeps()
    startTurn('k', 0)
    noteSubagentDispatch('k')
    // Take snapshot
    const before = __getStateForTests('k')
    expect(before?.subagentDispatchActive).toBe(true)
    endTurn('k')
    expect(__getStateForTests('k')).toBeUndefined()
  })
})

describe('silence-poke — consumeArmedPoke draining', () => {
  it('drains the armed flag so the next call returns null', () => {
    setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000)
    expect(consumeArmedPoke()).not.toBeNull()
    expect(consumeArmedPoke()).toBeNull()
  })

  it('returns null when nothing is armed', () => {
    setupDeps()
    startTurn('k', 0)
    expect(consumeArmedPoke()).toBeNull()
  })

  it('returns the matching level text', () => {
    setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000)
    expect(consumeArmedPoke()).toContain('75s')
    __tickForTests(180_000)
    expect(consumeArmedPoke()).toContain('3 minutes')
  })
})

describe('silence-poke — endTurn cleanup', () => {
  it('endTurn drops state', () => {
    setupDeps()
    startTurn('k', 0)
    expect(__getStateForTests('k')).toBeDefined()
    endTurn('k')
    expect(__getStateForTests('k')).toBeUndefined()
  })

  it('endTurn on an unknown key is a no-op', () => {
    setupDeps()
    expect(() => endTurn('never-tracked')).not.toThrow()
  })
})

describe('silence-poke — independence across turns', () => {
  it('two turns in different chats fire independently', () => {
    const fx = setupDeps()
    startTurn('a:0', 0)
    startTurn('b:0', 0)
    noteOutbound('a:0', 50_000)
    __tickForTests(75_000)
    // a's clock was reset to 50_000, silence=25s — no fire.
    // b's clock is still at 0, silence=75s — soft fires.
    expect(fx.emitted).toHaveLength(1)
    expect(fx.emitted[0]).toMatchObject({ key: 'b:0', level: 'soft' })
  })
})

describe('silence-poke — fallback handler errors do not break timer', () => {
  it('continues to function if onFrameworkFallback throws', () => {
    const fx: TestFixtures = { emitted: [], fallbacks: [] }
    __setDepsForTests({
      emitMetric: (e) => fx.emitted.push(e),
      onFrameworkFallback: () => { throw new Error('oh no') },
      thresholdsMs: DEFAULT_THRESHOLDS,
    })
    startTurn('k', 0)
    expect(() => {
      __tickForTests(75_000)
      __tickForTests(180_000)
      __tickForTests(300_000)
    }).not.toThrow()
    // Telemetry still emitted
    expect(fx.emitted.some((e) => e.kind === 'silence_fallback_sent')).toBe(true)
  })

  it('continues to function if onFrameworkFallback returns a rejected promise', async () => {
    const fx: TestFixtures = { emitted: [], fallbacks: [] }
    __setDepsForTests({
      emitMetric: (e) => fx.emitted.push(e),
      onFrameworkFallback: () => Promise.reject(new Error('async fail')),
      thresholdsMs: DEFAULT_THRESHOLDS,
    })
    startTurn('k', 0)
    __tickForTests(75_000)
    __tickForTests(180_000)
    __tickForTests(300_000)
    // Allow microtasks for the rejection-catch to fire
    await new Promise((r) => setTimeout(r, 0))
    expect(fx.emitted.some((e) => e.kind === 'silence_fallback_sent')).toBe(true)
  })
})

describe('silence-poke — system reminder text', () => {
  it('soft poke text references the 75s threshold and contains the system-reminder marker', () => {
    setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000)
    const text = consumeArmedPoke()
    expect(text).toContain('[silence-poke]')
    expect(text).toContain('75s')
    expect(text).toContain('about to finish')
  })

  it('firm poke text references the 3-minute threshold', () => {
    setupDeps()
    startTurn('k', 0)
    __tickForTests(75_000)
    consumeArmedPoke()
    __tickForTests(180_000)
    const text = consumeArmedPoke()
    expect(text).toContain('3 minutes')
    expect(text).toContain('stuck')
  })
})

describe('silence-poke — performance', () => {
  it('tick over many active turns stays fast', () => {
    setupDeps()
    for (let i = 0; i < 1000; i++) {
      startTurn(`chat${i}:0`, 0)
    }
    const start = performance.now()
    __tickForTests(75_000)
    const elapsed = performance.now() - start
    // 1000 turns should tick in well under 50ms — guards against an
    // accidentally-quadratic implementation.
    expect(elapsed).toBeLessThan(50)
  })
})
