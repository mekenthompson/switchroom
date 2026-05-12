/**
 * Bounded exponential-backoff retry for gateway startup network errors,
 * with classification of the failure mode so the caller can act.
 *
 * On 2026-04-29 all five switchroom gateways silently broke at boot because
 * `api.telegram.org` was unreachable for ~27 minutes after system boot (the
 * network stack wasn't fully usable when `network-online.target` fired).
 * Grammy threw `HttpError: Network request for 'deleteWebhook'/'getMe' failed!`
 * and the gateway's catch block logged the error and **returned** — leaving the
 * process alive but not polling. No crash, so systemd's `Restart=always` never
 * fired. Telegram → agent delivery was dead until manual restarts.
 *
 * Then issue #1076: a *revoked or wrong-typed* bot token returns Telegram API
 * 401 `Unauthorized`. Pre-fix `gatewayStartupRetry` rethrew non-network errors
 * immediately, the surrounding gateway catch block exited 1, the in-container
 * `_switchroom_supervise` respawned, the new gateway re-hit 401, repeat. Ten
 * restarts in <60 s tripped the supervisor cap and the gateway went silently
 * dead with no operator-visible signal. This module now distinguishes 401 as
 * a permanent config error, which the gateway handles by writing an issue +
 * quarantine marker + exit-78 (the supervisor's "config error, don't
 * restart" sentinel — see profiles/_base/start.sh.hbs).
 *
 * This module provides:
 *
 *   `classifyStartupError(err)` — returns `'network' | 'unauthorized' | 'other'`.
 *   `isBootNetworkError(err)` — back-compat alias for the network arm.
 *   `STARTUP_RETRY_DELAYS_MS` — the chosen backoff schedule.
 *   `gatewayStartupRetry(fn, opts)` — drives the retry loop.
 *
 * The function is extracted from `gateway.ts`'s top-level IIFE so it can be
 * unit-tested without spinning up the full bot runtime.
 */

export type StartupErrorKind = 'network' | 'unauthorized' | 'other'

export interface StartupRetryOpts {
  /**
   * Delay schedule in milliseconds. Each attempt waits the corresponding
   * element before the NEXT attempt. Length determines max extra attempts
   * (total = delays.length + 1 initial attempt).
   *
   * Defaults to `STARTUP_RETRY_DELAYS_MS` (~2 min budget).
   */
  delaysMs?: number[]

  /** Inject a sleep helper so tests can use fake timers. */
  sleep?: (ms: number) => Promise<void>

  /**
   * Called when all NETWORK retries are exhausted. Should NOT return
   * (exit/throw). Defaults to `process.exit(1)` so systemd /
   * `_switchroom_supervise` restart-on-failure can recycle the unit.
   */
  onExhausted?: (lastError: unknown) => never

  /**
   * Called when a startup API call returns 401 Unauthorized. The bot token
   * is permanently wrong (revoked, wrong type, typo) — retrying just burns
   * the supervisor restart budget. Caller should write an issue + quarantine
   * marker and `process.exit(78)` (EX_CONFIG). Should NOT return.
   *
   * Default: same exit-1 path as `onExhausted` so callers that haven't been
   * updated keep the pre-fix behaviour (rather than silently swallowing 401).
   */
  onUnauthorized?: (err: unknown) => never

  /** Log sink for retry progress messages. Defaults to process.stderr.write. */
  log?: (line: string) => void
}

/**
 * Default backoff schedule: 1 s, 2 s, 4 s, 8 s, 16 s, 32 s, 64 s.
 * Total budget including 8 attempts: ~2 min 7 s. Chosen so a typical
 * post-boot network settle (empirically <90 s) is covered with headroom.
 */
export const STARTUP_RETRY_DELAYS_MS: number[] = [
  1_000,
  2_000,
  4_000,
  8_000,
  16_000,
  32_000,
  64_000,
]

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Classify a startup-time error into one of:
 *
 *   - `network`: transient connectivity / DNS / TCP / fetch failure — the
 *     retry loop should absorb these with backoff.
 *   - `unauthorized`: Telegram API 401 (revoked or wrong-typed bot token).
 *     Permanent until the operator rotates the token. Retrying compounds
 *     the supervisor restart budget for no gain — see #1076.
 *   - `other`: everything else (bad request shape, 5xx, server bug, etc.).
 *     Rethrown to the surrounding gateway catch block, which exits non-zero
 *     so the supervisor can recycle.
 *
 * Grammy surfaces 401 via `GrammyError` (name === 'GrammyError') with
 * `error_code === 401`. Some test fixtures and node-fetch wrappers surface
 * 401 only in the message string, so we fall through to a substring match
 * for `Unauthorized` as defence in depth.
 */
export function classifyStartupError(err: unknown): StartupErrorKind {
  if (!(err instanceof Error)) return 'other'

  // Unauthorized (#1076). Check BEFORE the network arm so a Grammy-wrapped
  // 401 doesn't accidentally match the "Network request" substring branch
  // through some future change to grammy's error stringification.
  const errAny = err as Error & {
    error_code?: number
    name?: string
  }
  if (
    errAny.name === 'GrammyError' &&
    errAny.error_code === 401
  ) {
    return 'unauthorized'
  }
  // Fall-back string match. Telegram's API returns the literal token
  // 'Unauthorized' for 401 in the description field. We avoid a substring
  // of just '401' here because that can match unrelated error codes /
  // ports / numeric content.
  if (err.message.includes('Unauthorized')) return 'unauthorized'

  // Network arm — grammy wraps fetch/ECONN errors in HttpError.
  if (err.name === 'HttpError') return 'network'
  const msg = err.message
  if (
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('fetch failed') ||
    msg.includes('Network request')
  ) {
    return 'network'
  }

  return 'other'
}

/**
 * Returns true if `err` is a transient network-level failure that the startup
 * retry loop should absorb. Retained as a named export for the existing
 * regression tests and downstream callers that only care about the network
 * arm. Prefer `classifyStartupError` for new code.
 */
export function isBootNetworkError(err: unknown): boolean {
  return classifyStartupError(err) === 'network'
}

/**
 * Attempt `fn()` and retry on network failures using the provided delay
 * schedule.
 *
 * - On success: returns whatever `fn()` resolved to.
 * - On unauthorized (401): calls `opts.onUnauthorized(err)` which must not
 *   return. The gateway uses this to write an issue + quarantine marker
 *   + `process.exit(78)`. Default is `process.exit(1)` for back-compat.
 * - On other non-network error: re-throws immediately (not a transient
 *   boot issue, not a known config error).
 * - On exhausted network retries: calls `opts.onExhausted(lastError)` which
 *   must not return. Default is `process.exit(1)`.
 */
export async function gatewayStartupRetry<T>(
  fn: () => Promise<T>,
  opts: StartupRetryOpts = {},
): Promise<T> {
  const delays = opts.delaysMs ?? STARTUP_RETRY_DELAYS_MS
  const sleep = opts.sleep ?? DEFAULT_SLEEP
  const onExhausted: (err: unknown) => never =
    opts.onExhausted ??
    ((err: unknown) => {
      process.stderr.write(
        `telegram gateway: startup failed after ${delays.length + 1} attempts — exiting so systemd can restart: ${err}\n`,
      )
      process.exit(1)
    })
  const onUnauthorized: (err: unknown) => never =
    opts.onUnauthorized ??
    ((err: unknown) => {
      // Back-compat default. Real callers (gateway.ts) override this with
      // an issue-sink writer + quarantine-marker writer + exit-78.
      process.stderr.write(
        `telegram gateway: startup unauthorized (bot token rejected) — exiting: ${(err as Error).message}\n`,
      )
      process.exit(1)
    })
  const log =
    opts.log ??
    ((line: string) => {
      process.stderr.write(line.endsWith('\n') ? line : line + '\n')
    })

  const maxAttempts = delays.length + 1
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const kind = classifyStartupError(err)
      if (kind === 'unauthorized') return onUnauthorized(err)
      if (kind === 'other') throw err
      // network
      lastError = err
      if (attempt >= maxAttempts) break
      const delayMs = delays[attempt - 1]
      log(
        `telegram gateway: startup network error (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs / 1000}s: ${err}`,
      )
      await sleep(delayMs)
    }
  }

  return onExhausted(lastError)
}
