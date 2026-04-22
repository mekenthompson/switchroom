/**
 * Unit tests for the progress-card pin watchdog.
 *
 * The watchdog is called from the gateway on every progress-card
 * heartbeat emit. It verifies Telegram's pinned-message id matches
 * what we think is pinned; if not, it re-pins. This suite exercises
 * the rate-limiter, re-pin path, and error isolation.
 */

import { describe, it, expect, vi } from 'vitest'
import { createPinWatchdog, type PinWatchdogDeps } from '../progress-card-pin-watchdog.js'

interface Harness {
  wd: ReturnType<typeof createPinWatchdog>
  deps: {
    getCurrentPinned: ReturnType<typeof vi.fn>
    pin: ReturnType<typeof vi.fn>
    log: ReturnType<typeof vi.fn>
  }
  /** Mutable clock. Tests advance this to exercise the rate-limiter. */
  clock: { t: number }
}

function mkHarness(overrides: Partial<PinWatchdogDeps> = {}): Harness {
  const clock = { t: 1_000_000 }
  const deps = {
    getCurrentPinned: vi.fn(async () => 42),
    pin: vi.fn(async () => true),
    log: vi.fn(),
  }
  const wd = createPinWatchdog({
    getCurrentPinned: deps.getCurrentPinned,
    pin: deps.pin,
    log: deps.log,
    now: () => clock.t,
    intervalMs: 30_000,
    ...overrides,
  })
  return { wd, deps, clock }
}

describe('progress-card pin watchdog', () => {
  it('is a no-op when Telegram already shows the expected pin', async () => {
    const h = mkHarness()
    h.deps.getCurrentPinned.mockResolvedValueOnce(42)

    await h.wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 })

    expect(h.deps.getCurrentPinned).toHaveBeenCalledTimes(1)
    expect(h.deps.pin).not.toHaveBeenCalled()
    expect(h.deps.log).not.toHaveBeenCalled()
  })

  it('re-pins when Telegram shows a different message pinned', async () => {
    const h = mkHarness()
    h.deps.getCurrentPinned.mockResolvedValueOnce(999) // some other pin

    await h.wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 })

    expect(h.deps.getCurrentPinned).toHaveBeenCalledWith('100')
    expect(h.deps.pin).toHaveBeenCalledWith('100', 42, { disable_notification: true })
  })

  it('re-pins when Telegram reports nothing pinned', async () => {
    const h = mkHarness()
    h.deps.getCurrentPinned.mockResolvedValueOnce(undefined)

    await h.wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 })

    expect(h.deps.pin).toHaveBeenCalledWith('100', 42, { disable_notification: true })
  })

  it('rate-limits probes per turnKey within intervalMs', async () => {
    const h = mkHarness()
    h.deps.getCurrentPinned.mockResolvedValue(42)

    // Burst of 5 verify calls within 1s of each other.
    for (let i = 0; i < 5; i++) {
      await h.wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 })
      h.clock.t += 1_000
    }

    expect(h.deps.getCurrentPinned).toHaveBeenCalledTimes(1)
  })

  it('probes again after the rate-limit window elapses', async () => {
    const h = mkHarness()
    h.deps.getCurrentPinned.mockResolvedValue(42)

    await h.wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 })
    h.clock.t += 31_000 // past 30s interval
    await h.wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 })

    expect(h.deps.getCurrentPinned).toHaveBeenCalledTimes(2)
  })

  it('rate-limiter is keyed by turnKey — different keys don\'t share budget', async () => {
    const h = mkHarness()
    h.deps.getCurrentPinned.mockResolvedValue(42)

    await h.wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 })
    await h.wd.verify({ chatId: '100', turnKey: '100:2', expectedMessageId: 43 })
    await h.wd.verify({ chatId: '100', turnKey: '100:3', expectedMessageId: 44 })

    expect(h.deps.getCurrentPinned).toHaveBeenCalledTimes(3)
  })

  it('swallows and logs getChat errors without throwing', async () => {
    const h = mkHarness()
    h.deps.getCurrentPinned.mockRejectedValueOnce(new Error('Bad Request: chat not found'))

    await expect(
      h.wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 }),
    ).resolves.toBeUndefined()

    expect(h.deps.pin).not.toHaveBeenCalled()
    expect(h.deps.log).toHaveBeenCalledOnce()
    expect(h.deps.log.mock.calls[0]![0]).toMatch(/watchdog failed.*chat not found/)
  })

  it('swallows and logs pin errors without throwing', async () => {
    const h = mkHarness()
    h.deps.getCurrentPinned.mockResolvedValueOnce(999) // mismatch → try to re-pin
    h.deps.pin.mockRejectedValueOnce(new Error('Forbidden: not enough rights'))

    await expect(
      h.wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 }),
    ).resolves.toBeUndefined()

    expect(h.deps.log).toHaveBeenCalledOnce()
    expect(h.deps.log.mock.calls[0]![0]).toMatch(/watchdog failed.*not enough rights/)
  })

  it('clear() resets the rate-limit so a subsequent verify probes immediately', async () => {
    const h = mkHarness()
    h.deps.getCurrentPinned.mockResolvedValue(42)

    await h.wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 })
    expect(h.deps.getCurrentPinned).toHaveBeenCalledTimes(1)

    h.wd.clear('100:1')
    // No time advance — only the clear should unlock the next probe.
    await h.wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 })

    expect(h.deps.getCurrentPinned).toHaveBeenCalledTimes(2)
  })

  it('clear() on an unknown turnKey is a safe no-op', () => {
    const h = mkHarness()
    expect(() => h.wd.clear('never-seen')).not.toThrow()
  })

  it('defaults intervalMs to 30_000 when not provided', async () => {
    // Construct without an explicit intervalMs override.
    const clock = { t: 0 }
    const getCurrentPinned = vi.fn(async () => 42)
    const pin = vi.fn(async () => true)
    const wd = createPinWatchdog({
      getCurrentPinned,
      pin,
      now: () => clock.t,
    })

    await wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 })
    // Just under 30s — should still be gated.
    clock.t = 29_999
    await wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 })
    expect(getCurrentPinned).toHaveBeenCalledTimes(1)
    // Past 30s — should probe again.
    clock.t = 30_001
    await wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 })
    expect(getCurrentPinned).toHaveBeenCalledTimes(2)
  })

  it('first verify for a turnKey always probes, even at t=0', async () => {
    const clock = { t: 0 }
    const deps = {
      getCurrentPinned: vi.fn(async () => 42),
      pin: vi.fn(async () => true),
    }
    const wd = createPinWatchdog({
      getCurrentPinned: deps.getCurrentPinned,
      pin: deps.pin,
      now: () => clock.t,
    })

    await wd.verify({ chatId: '100', turnKey: '100:1', expectedMessageId: 42 })
    expect(deps.getCurrentPinned).toHaveBeenCalledTimes(1)
  })
})
