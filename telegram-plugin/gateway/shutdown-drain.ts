/**
 * SIGTERM drain coordinator for the telegram gateway.
 *
 * On shutdown we want to give the long-poll a real chance to die before
 * the next gateway process boots and races it on Telegram's getUpdates
 * channel. The 2026-04-23 incident showed that a 3-second hard exit was
 * NOT enough — the kernel hadn't FIN'd the long-poll TCP socket before
 * the new process started, and Telegram returned 409 Conflict to both
 * pollers for 13+ retries (10–12s backoffs each).
 *
 * Budget: ~35 seconds. systemd's TimeoutStopSec defaults to 90s on user
 * units (we now set it explicitly to 45s in generateGatewayUnit), so
 * there's headroom for the drain plus systemd's own grace before SIGKILL.
 *
 * Phases:
 *   1. stop_polling — call the supplied stopPolling() (bot.stop /
 *      runner.stop). This halts new long-polls and lets the in-flight
 *      one return naturally.
 *   2. await in-flight — poll a counter (handlers, IPC calls) until it
 *      reaches 0 or the budget expires.
 *   3. report — single log line with elapsed_ms, in_flight_remaining,
 *      and timed_out boolean.
 *
 * The lock release is the caller's responsibility — typically:
 *
 *   await drainShutdown({ ... })
 *   await releaseStartupLock({ ... })
 *   process.exit(0)
 *
 * keeping this module focused on the drain itself for testability.
 */

export interface DrainOptions {
  /** Why we're shutting down (SIGTERM / SIGINT / etc) — for the log line. */
  signal: string;
  /**
   * Halts the long-poll. Implementations should await until the polling
   * loop has actually returned. Errors are caught and logged — drain
   * continues with the in-flight wait.
   */
  stopPolling: () => Promise<void>;
  /**
   * Returns the current count of in-flight handlers / IPC calls. Drain
   * polls this until it reaches 0 or the budget expires.
   */
  inFlight: () => number;
  /** Total budget in ms. Defaults to 35_000. */
  budgetMs?: number;
  /** Poll interval for the in-flight wait. Defaults to 100ms. */
  pollIntervalMs?: number;
  /** Logger; defaults to process.stderr.write with a trailing newline. */
  log?: (line: string) => void;
  /** Agent name for journalctl-friendly tagging. */
  agentName?: string;
  /**
   * Sleep function — injectable for tests. Defaults to setTimeout-based.
   * Receives the poll interval, not absolute time.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Monotonic clock — injectable for tests. Defaults to performance.now().
   */
  now?: () => number;
}

export interface DrainResult {
  elapsedMs: number;
  inFlightRemaining: number;
  timedOut: boolean;
}

const DEFAULT_LOG = (line: string): void => {
  process.stderr.write(line.endsWith("\n") ? line : line + "\n");
};

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_NOW = (): number =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

function fmtAgent(agentName: string | undefined): string {
  return agentName ? ` agent=${agentName}` : "";
}

/**
 * Run the SIGTERM drain. Always resolves (never throws) — shutdown
 * paths must not throw. Errors from stopPolling are logged and the
 * in-flight wait continues; if the budget elapses we return with
 * `timedOut: true` so the caller can decide whether to force-exit.
 */
export async function drainShutdown(opts: DrainOptions): Promise<DrainResult> {
  const log = opts.log ?? DEFAULT_LOG;
  const sleep = opts.sleep ?? DEFAULT_SLEEP;
  const now = opts.now ?? DEFAULT_NOW;
  const budgetMs = opts.budgetMs ?? 35_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 100;
  const agentTag = fmtAgent(opts.agentName);

  const start = now();
  const startInFlight = safeCount(opts.inFlight);

  log(
    `telegram gateway: shutdown.drain_start signal=${opts.signal} in_flight=${startInFlight}${agentTag}`,
  );

  // Phase 1: halt polling. We await stopPolling() but bound it to the
  // overall budget — if it hangs we still want to drain in-flight and
  // exit. Use Promise.race with a deadline.
  const stopDeadline = budgetMs;
  try {
    await Promise.race([
      opts.stopPolling(),
      sleep(stopDeadline).then(() => {
        // Mark the timeout via a sentinel — we don't throw; we let the
        // in-flight loop observe the elapsed time and report timed_out.
      }),
    ]);
  } catch (err) {
    log(
      `telegram gateway: shutdown.stop_polling_error err=${(err as Error).message}${agentTag}`,
    );
  }

  // Phase 2: poll inFlight() until 0 or budget exhausted.
  while (true) {
    const elapsed = now() - start;
    const remaining = safeCount(opts.inFlight);
    if (remaining <= 0) {
      const finalElapsed = Math.round(now() - start);
      log(
        `telegram gateway: shutdown.drain_complete elapsed_ms=${finalElapsed} in_flight_remaining=0 timed_out=false${agentTag}`,
      );
      return { elapsedMs: finalElapsed, inFlightRemaining: 0, timedOut: false };
    }
    if (elapsed >= budgetMs) {
      const finalElapsed = Math.round(elapsed);
      log(
        `telegram gateway: shutdown.drain_complete elapsed_ms=${finalElapsed} in_flight_remaining=${remaining} timed_out=true${agentTag}`,
      );
      return {
        elapsedMs: finalElapsed,
        inFlightRemaining: remaining,
        timedOut: true,
      };
    }
    // Don't oversleep past the budget.
    const wait = Math.min(pollIntervalMs, Math.max(1, budgetMs - elapsed));
    await sleep(wait);
  }
}

function safeCount(fn: () => number): number {
  try {
    const n = fn();
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}
