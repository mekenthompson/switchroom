/**
 * Per-turn signal + outbound tracker for streaming observability.
 *
 * Tracks TWO things, keyed by chatId+threadId:
 *
 *   1. **Signal gap** — longest contiguous interval where no user-visible
 *      signal of ANY kind was sent (progress-card edits, status-reaction
 *      transitions, answer-lane updates, fresh sendMessage calls). The
 *      original use case from #203.
 *
 *   2. **Outbound messages** (added 2026-05 for the conversational-turn-
 *      UX redesign, issue #1122) — strictly user-visible MESSAGES that
 *      the agent sent: `reply`, `stream_reply` first-emits, progress
 *      card flushes that produce a fresh sendMessage. Status reactions
 *      and message edits don't count here — they don't ping the device
 *      and aren't what "outbound silence" means for the KPI.
 *
 * Keyed by chatId+threadId so concurrent turns in different chats don't
 * collide. Fully standalone — no grammy/bot dependency, deterministic
 * time injection via vi.useFakeTimers().
 *
 * Usage:
 *   signalTracker.reset(key, now)                  // at turn start
 *   signalTracker.noteSignal(key, now)             // any signal (legacy)
 *   signalTracker.noteOutbound(key, now)           // outbound message only
 *   signalTracker.getLongestGap(key)               // at turn_end (signal)
 *   signalTracker.getOutboundMetrics(key)          // at turn_end (KPIs)
 *   signalTracker.clear(key)                       // after emitting
 */

export interface TurnSignalState {
  /** The time the turn began. Used to compute TTFO. */
  turnStartedAt: number
  /** Time the current signal gap started (last signal time). */
  lastSignalAt: number
  /** Longest signal-gap (any signal) observed so far (ms). */
  longestGapMs: number
  /** First outbound message timestamp this turn, or null if none yet. */
  firstOutboundAt: number | null
  /** Most recent outbound message timestamp, or null. */
  lastOutboundAt: number | null
  /** Total outbound messages sent this turn. */
  outboundCount: number
  /** Longest gap between consecutive outbound messages (ms). */
  longestOutboundGapMs: number
}

export interface OutboundMetrics {
  /** ms between turn start and first outbound message; null if none sent. */
  ttfoMs: number | null
  /** Total outbound messages this turn. */
  outboundCount: number
  /** Longest gap between outbound messages — i.e. the "silent stretch"
   *  metric for the conversational-pacing KPI. 0 if <2 messages. */
  longestOutboundGapMs: number
}

const state = new Map<string, TurnSignalState>()

/**
 * Begin tracking a new turn. Records `now` as the initial signal time and
 * resets the gap accumulator + outbound state. Call at the start of each
 * fresh turn.
 */
export function reset(key: string, now: number): void {
  state.set(key, {
    turnStartedAt: now,
    lastSignalAt: now,
    longestGapMs: 0,
    firstOutboundAt: null,
    lastOutboundAt: null,
    outboundCount: 0,
    longestOutboundGapMs: 0,
  })
}

/**
 * Record a user-visible signal (any kind: reaction, edit, send). Measures
 * the gap since the last signal and updates `longestGapMs` if larger.
 */
export function noteSignal(key: string, now: number): void {
  const entry = state.get(key)
  if (entry == null) return
  const gap = now - entry.lastSignalAt
  if (gap > entry.longestGapMs) entry.longestGapMs = gap
  entry.lastSignalAt = now
}

/**
 * Record a fresh outbound MESSAGE (reply, stream_reply first-emit, or
 * card flush that produced a new sendMessage). Updates the
 * outbound-specific metrics: TTFO on first call, outbound-gap on
 * subsequent calls.
 *
 * Does not double-update the signal-gap stream — callers that note an
 * outbound message should ALSO call `noteSignal()` to keep the legacy
 * signal-gap accurate.
 */
export function noteOutbound(key: string, now: number): void {
  const entry = state.get(key)
  if (entry == null) return
  if (entry.firstOutboundAt == null) {
    entry.firstOutboundAt = now
  } else if (entry.lastOutboundAt != null) {
    const gap = now - entry.lastOutboundAt
    if (gap > entry.longestOutboundGapMs) entry.longestOutboundGapMs = gap
  }
  entry.lastOutboundAt = now
  entry.outboundCount += 1
}

/**
 * Returns the longest gap observed during the current turn (ms) — legacy
 * "any signal" metric. Returns 0 if no tracking state exists for this key.
 */
export function getLongestGap(key: string): number {
  return state.get(key)?.longestGapMs ?? 0
}

/**
 * Returns the last signal time for this key, or undefined if not tracked.
 * Useful for computing a trailing gap at turn_end before calling clear().
 */
export function getLastSignalAt(key: string): number | undefined {
  return state.get(key)?.lastSignalAt
}

/**
 * Returns the outbound-message KPI bundle for the conversational-pacing
 * redesign. Zeroed-out if no tracking state exists.
 */
export function getOutboundMetrics(key: string): OutboundMetrics {
  const entry = state.get(key)
  if (entry == null) {
    return { ttfoMs: null, outboundCount: 0, longestOutboundGapMs: 0 }
  }
  const ttfoMs = entry.firstOutboundAt != null
    ? entry.firstOutboundAt - entry.turnStartedAt
    : null
  return {
    ttfoMs,
    outboundCount: entry.outboundCount,
    longestOutboundGapMs: entry.longestOutboundGapMs,
  }
}

/** Remove state for this key. Call after emitting the turn-end metrics. */
export function clear(key: string): void {
  state.delete(key)
}

/** Exposed for tests — clears all tracked state. */
export function __resetAllForTests(): void {
  state.clear()
}
