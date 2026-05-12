/**
 * Tests for the gateway startup network-retry helper.
 *
 * Regression guard for the 2026-04-29 incident where all five switchroom
 * gateways silently failed at boot because `api.telegram.org` was unreachable
 * for ~27 minutes. The process logged an error and returned (stayed alive,
 * didn't poll) rather than exiting, so systemd's `Restart=always` never fired.
 *
 * These tests pin:
 *   - `isBootNetworkError` correctly classifies grammy HttpErrors and raw errors
 *   - `gatewayStartupRetry` retries on network errors with backoff
 *   - When retries are exhausted, `onExhausted` is called (simulating exit)
 *   - Non-network errors are NOT retried (rethrown immediately)
 *   - Success on a later attempt resolves the returned promise
 */

import { describe, it, expect, vi } from 'vitest'
import {
  isBootNetworkError,
  gatewayStartupRetry,
  classifyStartupError,
  STARTUP_RETRY_DELAYS_MS,
} from '../gateway/startup-network-retry'

// ── isBootNetworkError ────────────────────────────────────────────────────────

describe('isBootNetworkError', () => {
  it('returns true for an error with name HttpError (grammy wrapper)', () => {
    const err = Object.assign(new Error('Network request for getMe failed!'), {
      name: 'HttpError',
    })
    expect(isBootNetworkError(err)).toBe(true)
  })

  it('returns true for ECONNRESET', () => {
    expect(isBootNetworkError(new Error('ECONNRESET'))).toBe(true)
  })

  it('returns true for ETIMEDOUT', () => {
    expect(isBootNetworkError(new Error('connect ETIMEDOUT 149.154.167.220:443'))).toBe(true)
  })

  it('returns true for ENOTFOUND', () => {
    expect(isBootNetworkError(new Error('getaddrinfo ENOTFOUND api.telegram.org'))).toBe(true)
  })

  it('returns true for ECONNREFUSED', () => {
    expect(isBootNetworkError(new Error('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true)
  })

  it('returns true for "fetch failed"', () => {
    expect(isBootNetworkError(new Error('fetch failed'))).toBe(true)
  })

  it('returns true for "Network request" messages', () => {
    expect(
      isBootNetworkError(new Error("Network request for 'deleteWebhook' failed!")),
    ).toBe(true)
  })

  it('returns false for a GrammyError 403 (not a network error)', () => {
    const err = Object.assign(new Error('Forbidden: bot was kicked'), {
      name: 'GrammyError',
      error_code: 403,
    })
    expect(isBootNetworkError(err)).toBe(false)
  })

  it('returns false for a generic application error', () => {
    expect(isBootNetworkError(new Error('some unrelated error'))).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isBootNetworkError('string error')).toBe(false)
    expect(isBootNetworkError(null)).toBe(false)
    expect(isBootNetworkError(42)).toBe(false)
  })
})

// ── classifyStartupError ──────────────────────────────────────────────────────

describe('classifyStartupError', () => {
  it('classifies grammy 401 (GrammyError, error_code=401) as unauthorized', () => {
    const err = Object.assign(new Error('Unauthorized'), {
      name: 'GrammyError',
      error_code: 401,
    })
    expect(classifyStartupError(err)).toBe('unauthorized')
  })

  it('classifies an Unauthorized-message error as unauthorized — defence in depth', () => {
    expect(classifyStartupError(new Error('Unauthorized'))).toBe('unauthorized')
  })

  it('does NOT mis-classify a network error mentioning "401" port as unauthorized', () => {
    // Hypothetical message that happens to contain "401" but isn't a
    // 401 status. classifyStartupError matches on the literal token
    // "Unauthorized" rather than the substring "401" to avoid this.
    expect(classifyStartupError(new Error('connect ECONNREFUSED 10.0.0.1:401'))).toBe('network')
  })

  it('classifies HttpError as network', () => {
    const err = Object.assign(new Error('Network request failed'), {
      name: 'HttpError',
    })
    expect(classifyStartupError(err)).toBe('network')
  })

  it('classifies ETIMEDOUT as network', () => {
    expect(classifyStartupError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe('network')
  })

  it('classifies a bare app error as other', () => {
    expect(classifyStartupError(new Error('something else'))).toBe('other')
  })

  it('classifies non-Error values as other', () => {
    expect(classifyStartupError('string')).toBe('other')
    expect(classifyStartupError(null)).toBe('other')
  })

  it('classifies a GrammyError 403 (kicked) as other — surfaces as a fatal rethrow', () => {
    const err = Object.assign(new Error('Forbidden: bot was kicked'), {
      name: 'GrammyError',
      error_code: 403,
    })
    expect(classifyStartupError(err)).toBe('other')
  })
})

// ── gatewayStartupRetry ───────────────────────────────────────────────────────

describe('gatewayStartupRetry', () => {
  const noopLog = () => {}

  it('resolves immediately when fn() succeeds on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await gatewayStartupRetry(fn, { log: noopLog })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on network error and resolves when fn eventually succeeds', async () => {
    const networkErr = Object.assign(new Error('Network request failed'), {
      name: 'HttpError',
    })
    const fn = vi
      .fn()
      .mockRejectedValueOnce(networkErr)
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValue('recovered')

    const sleep = vi.fn().mockResolvedValue(undefined)
    const result = await gatewayStartupRetry(fn, {
      delaysMs: [100, 200, 400],
      sleep,
      log: noopLog,
    })

    expect(result).toBe('recovered')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenNthCalledWith(1, 100)
    expect(sleep).toHaveBeenNthCalledWith(2, 200)
  })

  it('calls onExhausted (not returns) when all retries are exhausted', async () => {
    const networkErr = Object.assign(new Error('Network request failed'), {
      name: 'HttpError',
    })
    const fn = vi.fn().mockRejectedValue(networkErr)
    const onExhausted = vi.fn(() => { throw new Error('__exited__') }) as unknown as (err: unknown) => never

    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(
      gatewayStartupRetry(fn, {
        delaysMs: [1, 2],  // 3 total attempts (delays.length + 1)
        sleep,
        onExhausted,
        log: noopLog,
      }),
    ).rejects.toThrow('__exited__')

    expect(fn).toHaveBeenCalledTimes(3)
    expect(onExhausted).toHaveBeenCalledTimes(1)
    expect(onExhausted).toHaveBeenCalledWith(networkErr)
  })

  it('does NOT retry non-network errors — rethrows immediately', async () => {
    const appErr = new Error('bad token')
    const fn = vi.fn().mockRejectedValue(appErr)
    const sleep = vi.fn()
    const onExhausted = vi.fn()

    await expect(
      gatewayStartupRetry(fn, {
        delaysMs: [100, 200],
        sleep,
        onExhausted: onExhausted as unknown as (err: unknown) => never,
        log: noopLog,
      }),
    ).rejects.toThrow('bad token')

    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(onExhausted).not.toHaveBeenCalled()
  })

  it('uses STARTUP_RETRY_DELAYS_MS by default (7 delays → 8 total attempts)', () => {
    expect(STARTUP_RETRY_DELAYS_MS).toHaveLength(7)
    // Verify the schedule is monotonically increasing and ends at 64 s
    expect(STARTUP_RETRY_DELAYS_MS[0]).toBe(1_000)
    expect(STARTUP_RETRY_DELAYS_MS[STARTUP_RETRY_DELAYS_MS.length - 1]).toBe(64_000)
  })

  it('calls onUnauthorized (not onExhausted, not rethrow) on a 401 — #1076', async () => {
    // Grammy surfaces 401 via GrammyError with error_code=401.
    const authErr = Object.assign(new Error('Unauthorized'), {
      name: 'GrammyError',
      error_code: 401,
    })
    const fn = vi.fn().mockRejectedValue(authErr)
    const onUnauthorized = vi.fn(() => {
      throw new Error('__quarantined__')
    }) as unknown as (err: unknown) => never
    const onExhausted = vi.fn(() => {
      throw new Error('__exhausted__')
    }) as unknown as (err: unknown) => never
    const sleep = vi.fn().mockResolvedValue(undefined)

    await expect(
      gatewayStartupRetry(fn, {
        delaysMs: [100, 200, 400],
        sleep,
        onUnauthorized,
        onExhausted,
        log: noopLog,
      }),
    ).rejects.toThrow('__quarantined__')

    // 401 short-circuits — only one fn() call, no retries, no exhaustion path.
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(onExhausted).not.toHaveBeenCalled()
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
    expect(onUnauthorized).toHaveBeenCalledWith(authErr)
  })

  it('classifies a 401-message-only error (no error_code) as unauthorized — defence in depth', async () => {
    // Some fetch wrappers / test fixtures surface 401 only in the message.
    const authErr = new Error('Unauthorized')
    const fn = vi.fn().mockRejectedValue(authErr)
    const onUnauthorized = vi.fn(() => {
      throw new Error('__quarantined__')
    }) as unknown as (err: unknown) => never

    await expect(
      gatewayStartupRetry(fn, {
        delaysMs: [1, 2],
        sleep: vi.fn(),
        onUnauthorized,
        log: noopLog,
      }),
    ).rejects.toThrow('__quarantined__')
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('logs retry progress before each sleep', async () => {
    const networkErr = Object.assign(new Error('Network request failed'), {
      name: 'HttpError',
    })
    const fn = vi
      .fn()
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValue('ok')

    const sleep = vi.fn().mockResolvedValue(undefined)
    const log = vi.fn()

    await gatewayStartupRetry(fn, { delaysMs: [50], sleep, log })

    expect(log).toHaveBeenCalledTimes(1)
    const logMsg: string = log.mock.calls[0][0]
    expect(logMsg).toMatch(/startup network error/)
    expect(logMsg).toMatch(/attempt 1\/2/)
    expect(logMsg).toMatch(/retrying in 0.05s/)
  })
})
