/**
 * Pure retry loop for grammY's runner (or any "run→task()→stop()" handle).
 *
 * Extracted from gateway.ts / server.ts so we can unit-test the "drain the
 * old handle before retrying" contract without spinning up grammy.
 *
 * The 2026-04-22 bug: the inline retry loop in both files overwrote
 * `runnerHandle = run(bot)` on a 409 retry WITHOUT ever calling `.stop()`
 * on the previous handle. @grammyjs/runner's `stop()` triggers an
 * AbortController that closes the underlying TCP fetch to Telegram. Without
 * it, stale pollers accumulated within a single gateway process — each
 * holding an ESTABLISHED socket to api.telegram.org, each 409'd by
 * Telegram, each triggering another retry. Positive-feedback storm.
 *
 * This helper guarantees exactly one live handle at a time: the previous
 * handle is stopped (best-effort with a timeout, so a stuck stop() does
 * NOT hang retries) before the next `run()` is called, and on any exit
 * (graceful or fatal) any lingering handle is stopped.
 */

export interface RetryableHandle {
  task(): Promise<void>
  stop(): Promise<void>
}

export interface RunWithRetryOpts<H extends RetryableHandle> {
  /** Create a new handle. Called once per attempt. */
  run: () => H
  /** Return true iff this error should trigger another attempt. */
  shouldRetry: (err: unknown, attempt: number) => boolean
  /** Sleep between attempts (ms). Defaults to min(1000*attempt, 15000). */
  sleep?: (attempt: number) => Promise<void>
  /** Max attempts. Defaults to Infinity. */
  maxAttempts?: number
  /** How long to wait for .stop() before giving up (ms). Default 3000. */
  stopTimeoutMs?: number
  /**
   * Async hook fired before each `run()` call. Production uses this for the
   * one-time setup block (clearStaleTelegramPollingState, getMe, banner post,
   * bot-command registration) — self-gated by a `didOneTimeSetup` flag so the
   * heavy work runs on attempt 1 only, while retry attempts are "stop old →
   * run new" with no additional API calls. Any error thrown here is treated
   * exactly like a run()/task() error: drain handle, check shouldRetry, loop.
   */
  beforeRun?: (attempt: number) => Promise<void>
  /** Hook fired before each run() call — used by the gateway for logging. */
  onAttempt?: (attempt: number) => void
  /** Hook fired when a retry is about to happen (after drain, before sleep). */
  onRetry?: (err: unknown, attempt: number) => void
  /** Hook fired when the loop exits with an unretryable error. */
  onFatal?: (err: unknown) => void
  /** Hook fired when .stop() throws or times out. Best-effort; never rethrows. */
  onStopFailure?: (err: unknown) => void
}

/**
 * Best-effort timeout wrapper. Resolves with the promise's value on success,
 * rejects with a timeout error on timeout. Does NOT cancel the underlying
 * promise — we just stop waiting for it.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)
      }),
    ])
  } finally {
    if (timer != null) clearTimeout(timer)
  }
}

/**
 * Run a handle, awaiting its `.task()`. On retryable failure, stop the
 * previous handle before the next attempt. On fatal failure or graceful
 * resolution, stop any outstanding handle.
 *
 * The "drain before retry" contract is the load-bearing invariant here:
 *   - runCount - stopCount <= 1 at all times (at most one live handle)
 *   - stop() is called on EVERY handle that was ever created by run()
 */
export async function runWithRetry<H extends RetryableHandle>(
  opts: RunWithRetryOpts<H>,
): Promise<void> {
  const {
    run,
    shouldRetry,
    sleep = (attempt) =>
      new Promise((r) => setTimeout(r, Math.min(1000 * attempt, 15000))),
    maxAttempts = Number.POSITIVE_INFINITY,
    stopTimeoutMs = 3000,
    beforeRun,
    onAttempt,
    onRetry,
    onFatal,
    onStopFailure,
  } = opts

  let handle: H | null = null

  const drain = async () => {
    if (handle == null) return
    const h = handle
    handle = null
    try {
      await withTimeout(h.stop(), stopTimeoutMs)
    } catch (err) {
      onStopFailure?.(err)
    }
  }

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (beforeRun != null) await beforeRun(attempt)
      } catch (err) {
        // beforeRun failure is treated exactly like a run/task failure:
        // drain (no handle to drain yet, but keep symmetry), then decide
        // retry or fatal.
        await drain()
        if (shouldRetry(err, attempt)) {
          onRetry?.(err, attempt)
          if (attempt < maxAttempts) {
            await sleep(attempt)
            continue
          }
        }
        onFatal?.(err)
        return
      }
      onAttempt?.(attempt)
      handle = run()
      try {
        await handle.task()
        // Graceful resolution: handle is done on its own. Still drain to
        // null the local reference and (if the runner exposed a stop) keep
        // the contract that every handle gets stopped exactly once.
        await drain()
        return
      } catch (err) {
        // Drain the dying handle BEFORE the next attempt. This is the
        // fix: without this, a 409 retry would stack a second concurrent
        // poller on top of the one that just failed, each holding an
        // ESTABLISHED TCP connection to api.telegram.org.
        await drain()
        if (shouldRetry(err, attempt)) {
          onRetry?.(err, attempt)
          if (attempt < maxAttempts) {
            await sleep(attempt)
            continue
          }
        }
        onFatal?.(err)
        return
      }
    }
  } finally {
    // Defensive: if we exited the loop via maxAttempts or an unexpected
    // path, never leak a live handle.
    await drain()
  }
}
