/**
 * Re-entry guard + dedup window for fleet-wide auto-fallback.
 *
 * Lifted out of gateway.ts so the dedup state is constructable per-test
 * (gateway.ts module state was hard to reach from vitest — every test
 * shared the same in-flight Promise + last-fired timestamp).
 *
 * Contract (the "honesty contract" from PR #1317 review):
 *
 *   `wouldFire()` is the SYNCHRONOUS read the model-unavailable card
 *   uses to decide whether to advertise "Auto-failover in progress".
 *   It MUST agree with the dispatcher's actual behavior — otherwise
 *   the card lies (claims a swap is coming when the dispatcher will
 *   dedup-drop or bail).
 *
 *   Three reasons `wouldFire()` returns false:
 *     1. A swap is already in flight (collapse concurrent fires).
 *     2. The post-trigger dedup window is still active (the user
 *        already saw a swap announcement; another one would oscillate).
 *     3. The broker is unreachable — the dispatcher would just bail
 *        with `reason=no-broker-client`, leaving the card to lie.
 *        Optional: only checked when `brokerReachable` is supplied.
 *
 *   `markFired()` is called ONLY on actual swaps (kind: 'switched').
 *   No-ops (no broker, no eligible target, idempotent skip) DO NOT
 *   arm the suppression window — otherwise a transient hiccup blocks
 *   the next 30s of legitimate fires.
 */

export interface FleetFallbackGateOptions {
  /** Suppression window in ms after a successful swap. */
  dedupMs: number;
  /** Time source (overridable in tests). */
  nowFn?: () => number;
  /**
   * Synchronous probe of broker reachability. Optional. Returning false
   * makes `wouldFire()` return false so the card stays honest about a
   * fire that would otherwise bail in the dispatcher.
   *
   * Synchronous on purpose: `wouldFire()` runs on the card-render path
   * and must not block. A connection-cached flag (e.g. a UDS reachability
   * check populated by a background heartbeat) fits this shape.
   */
  brokerReachable?: () => boolean;
}

export interface FleetFallbackGate {
  /** True iff a fresh fire would actually invoke the dispatcher. */
  wouldFire(): boolean;
  /** Run a fire-and-forget action under the gate. Collapses concurrent
   *  callers to the same in-flight Promise. The action's resolved value
   *  controls whether the dedup window arms (true = arm, false = skip).
   *  Caller-thrown errors are swallowed (logged via `onError`). */
  fire(action: () => Promise<boolean>, onError?: (err: unknown) => void): Promise<void>;
  /** Test seam — reset to fresh state. Production code should not call this. */
  reset(): void;
  /** Test/debug — current internal state. */
  inspect(): { inFlight: boolean; lastFiredAtMs: number };
}

export function createFleetFallbackGate(opts: FleetFallbackGateOptions): FleetFallbackGate {
  const nowFn = opts.nowFn ?? (() => Date.now());
  let inFlight: Promise<void> | null = null;
  // -Infinity = never fired. Concrete number = wall-clock ms of the
  // last actual swap. Sentinel matters in tests (fake clocks at t=0
  // would otherwise look like "just fired" and falsely arm dedup).
  let lastFiredAtMs = Number.NEGATIVE_INFINITY;

  function wouldFire(): boolean {
    if (inFlight) return false;
    if (nowFn() - lastFiredAtMs < opts.dedupMs) return false;
    if (opts.brokerReachable && !opts.brokerReachable()) return false;
    return true;
  }

  function fire(action: () => Promise<boolean>, onError?: (err: unknown) => void): Promise<void> {
    if (inFlight) return inFlight;
    if (nowFn() - lastFiredAtMs < opts.dedupMs) return Promise.resolve();
    if (opts.brokerReachable && !opts.brokerReachable()) return Promise.resolve();

    inFlight = (async () => {
      try {
        const didSwap = await action();
        if (didSwap) lastFiredAtMs = nowFn();
      } catch (err) {
        if (onError) onError(err);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    wouldFire,
    fire,
    reset() {
      inFlight = null;
      lastFiredAtMs = Number.NEGATIVE_INFINITY;
    },
    inspect() {
      return { inFlight: inFlight !== null, lastFiredAtMs };
    },
  };
}
