/**
 * silence-poke.ts — framework safety net for "model is silent to the user."
 *
 * Background (issue #1122): we're moving away from a pinned progress card
 * to a conversational shape where the chat itself is the artifact. The
 * progress card was implicitly doing one useful job — covering for a
 * model that doesn't know how to say "still working." This module is the
 * explicit replacement: when the model has been silent past a threshold,
 * we nudge it (or, as a last resort, send a framework message ourselves).
 *
 * Two clocks (this module owns ONE of them; the other is the legacy
 * idle stall in status-reactions.ts and is unrelated):
 *
 *   silence clock = now - lastOutboundAt   (or turnStartedAt if no outbound yet)
 *
 * Outbound = a fresh `reply` or `stream_reply` first-emit. Reactions,
 * edits, and tool churn DO NOT reset the silence clock — that's the
 * whole point. The model could be ripping through 20 tool calls and
 * still be "silent" to the user.
 *
 * Escalation ladder per turn:
 *
 *   t=0       startTurn() — silence clock starts at turnStartedAt
 *   t=75s     soft poke armed — appended to next tool result as a
 *             <system-reminder> nudging the model to send an update
 *   t=180s    firm poke armed (stronger wording) if no outbound landed
 *   t=300s    framework fallback: gateway itself sends a user-visible
 *             "still working… / still thinking…" message. Fires at most
 *             once per turn. Pings the device (user needs to know).
 *
 * Subagent-dispatch override: when the model dispatches a sub-agent
 * (`Task(...)`, `@worker` etc), the soft threshold extends to 300s for
 * that turn — the model is legitimately waiting on a child, no point
 * poking it to narrate the wait. Firm/fallback thresholds unchanged.
 *
 * Wired into the gateway at the central tool-result chokepoint
 * (`gateway.ts:onToolCall`) so the poke text piggybacks the next tool
 * result back to claude. MCP doesn't allow mid-generation injection;
 * tool results are the only synchronous moment we own the wire.
 *
 * Kill switch: SWITCHROOM_DISABLE_SILENCE_POKE=1 disables the whole
 * subsystem (no timers, no injection, no fallback). The conversational
 * pacing prompt still applies; only the framework safety net is off.
 */

export type PokeLevel = 'soft' | 'firm'

export interface SilencePokeState {
  /** Wall-clock ms of turn start. Silence clock zero-point when no outbound yet. */
  turnStartedAt: number
  /** Wall-clock ms of last outbound message, or null. */
  lastOutboundAt: number | null
  /** 0 = none, 1 = soft fired, 2 = firm fired, 3 = fallback fired. */
  pokesFired: 0 | 1 | 2 | 3
  /** Armed pending drain on the next tool result, or null. */
  pokeArmed: { level: PokeLevel } | null
  /** When true, soft threshold extends to subagentSoft (default 300s). */
  subagentDispatchActive: boolean
  /** Wall-clock ms of last `thinking` session event, or null. */
  lastThinkingAt: number | null
  /** True once the 300s framework fallback has fired this turn. */
  fallbackFired: boolean
  /** Wall-clock ms of last poke fire — used for poke-success latency. */
  lastPokeFiredAt: number | null
}

export interface ThresholdsMs {
  soft: number
  firm: number
  fallback: number
  /** Soft threshold when subagentDispatchActive=true. */
  subagentSoft: number
  /** How long after a poke we still count an outbound as a "success." */
  pokeSuccessWindowMs: number
}

export const DEFAULT_THRESHOLDS: ThresholdsMs = {
  soft: 75_000,
  firm: 180_000,
  fallback: 300_000,
  subagentSoft: 300_000,
  pokeSuccessWindowMs: 15_000,
}

export const DEFAULT_POLL_INTERVAL_MS = 5_000

export interface FrameworkFallbackContext {
  key: string
  chatId: string
  threadId: number | null
  /** Picked from lastThinkingAt: 'thinking' if a thinking event landed in
   *  the last 30s of silence, else 'working'. */
  fallbackKind: 'working' | 'thinking'
  silenceMs: number
}

export type SilencePokeMetric =
  | { kind: 'silence_poke_fired'; key: string; level: PokeLevel; silence_ms: number; subagent_wait: boolean }
  | { kind: 'silence_poke_succeeded'; key: string; level: PokeLevel; latency_ms: number }
  | { kind: 'silence_fallback_sent'; key: string; fallback_kind: 'working' | 'thinking'; silence_ms: number }

export interface SilencePokeDeps {
  /** Called when the 300s fallback fires. Caller sends the user-visible
   *  message + ensures it pings the device. Caller must NOT call back
   *  into noteOutbound for this — it's a framework-sourced message,
   *  not a model-sourced one, and we want pokes to continue (well, no,
   *  fallbackFired ensures only one per turn anyway). */
  onFrameworkFallback: (ctx: FrameworkFallbackContext) => Promise<void> | void
  /** Telemetry sink for poke events. */
  emitMetric: (event: SilencePokeMetric) => void
  /** Threshold overrides (tests). */
  thresholdsMs?: ThresholdsMs
  /** Poll interval (tests). */
  pollIntervalMs?: number
}

const state = new Map<string, SilencePokeState>()
let timer: ReturnType<typeof setInterval> | null = null
let activeDeps: SilencePokeDeps | null = null

/**
 * True iff the kill switch is OFF. Re-read every call so tests can
 * toggle process.env without reloading the module.
 */
export function silencePokeEnabled(): boolean {
  const v = process.env.SWITCHROOM_DISABLE_SILENCE_POKE
  return !(v === '1' || v === 'true')
}

/**
 * Initialise a fresh turn's silence state. No-op when kill switch is on.
 */
export function startTurn(key: string, now: number): void {
  if (!silencePokeEnabled()) return
  state.set(key, {
    turnStartedAt: now,
    lastOutboundAt: null,
    pokesFired: 0,
    pokeArmed: null,
    subagentDispatchActive: false,
    lastThinkingAt: null,
    fallbackFired: false,
    lastPokeFiredAt: null,
  })
}

/**
 * Record a fresh user-visible outbound message (reply or stream_reply
 * first-emit). Resets the silence clock + the escalation counter. If a
 * poke fired recently, emit a `silence_poke_succeeded` metric.
 */
export function noteOutbound(key: string, now: number): void {
  const s = state.get(key)
  if (s == null) return
  // Success measurement: if a poke fired within the success window and
  // an outbound just landed, count it as a successful poke.
  const thresholds = activeDeps?.thresholdsMs ?? DEFAULT_THRESHOLDS
  if (
    s.lastPokeFiredAt != null
    && (now - s.lastPokeFiredAt) <= thresholds.pokeSuccessWindowMs
    && activeDeps != null
    && s.pokesFired >= 1
    && s.pokesFired <= 2
  ) {
    activeDeps.emitMetric({
      kind: 'silence_poke_succeeded',
      key,
      level: s.pokesFired === 1 ? 'soft' : 'firm',
      latency_ms: now - s.lastPokeFiredAt,
    })
  }
  s.lastOutboundAt = now
  s.pokesFired = 0
  s.pokeArmed = null
  // Intentionally DO NOT clear `subagentDispatchActive` here. The
  // model's `reply` narrating the dispatch ("spinning up @reviewer")
  // is itself the outbound that resets the silence clock — clearing
  // the flag would defeat the extended-threshold guarantee for the
  // wait that follows. The flag persists until endTurn(). Fixes the
  // non-blocking note from PR2 review (#1125).
  s.lastPokeFiredAt = null
  s.fallbackFired = false
}

/**
 * Note that the model dispatched a sub-agent (Task tool, @worker, etc).
 * Extends the soft threshold for THIS turn. The flag persists until
 * endTurn() — subsequent outbound messages within the turn keep the
 * extended threshold, which is the correct shape for the dispatch
 * narrate → wait → child-result → summarise sequence.
 */
export function noteSubagentDispatch(key: string): void {
  const s = state.get(key)
  if (s == null) return
  s.subagentDispatchActive = true
}

/**
 * Record a `thinking` session event. Used to pick "still thinking…" vs
 * "still working…" wording for the 300s framework fallback.
 */
export function noteThinking(key: string, now: number): void {
  const s = state.get(key)
  if (s == null) return
  s.lastThinkingAt = now
}

/**
 * Drain any armed poke for ANY active turn and return the system-reminder
 * text to append. Returns null if nothing is armed.
 *
 * Called at the gateway's tool-result chokepoint; the appended reminder
 * piggybacks the result back to claude. Drains the flag immediately so
 * the next tool result doesn't double-inject.
 *
 * Iterates all keys because the tool result doesn't carry which turn it
 * belongs to. In practice the gateway has ≤1 active turn at a time, but
 * the code handles multi-turn correctly: each turn's poke text is
 * appended once (and never appears in another turn's tool result, since
 * we drain by mutating the matched state).
 */
export function consumeArmedPoke(): string | null {
  for (const s of state.values()) {
    if (s.pokeArmed != null) {
      const level = s.pokeArmed.level
      s.pokeArmed = null
      return formatPokeText(level)
    }
  }
  return null
}

/** End a turn — drop state. Idempotent. */
export function endTurn(key: string): void {
  state.delete(key)
}

/** Verbatim poke text. Wording is load-bearing — see issue #1122 design. */
function formatPokeText(level: PokeLevel): string {
  if (level === 'soft') {
    return (
      "[silence-poke] You've been silent to the user for 75s. If you're "
      + "still working on this, send one short conversational reply — e.g. "
      + "\"still going, working through X\" — so they know you're alive. "
      + "Keep it brief; don't restate the task. If you're about to finish "
      + 'within the next few seconds, skip the update.'
    )
  }
  return (
    "[silence-poke] 3 minutes silent. Please send an update now — what "
    + "you're working on, or whether you're stuck. If something is taking "
    + 'unusually long (slow tool, network, waiting on a sub-agent), say so '
    + 'explicitly.'
  )
}

/**
 * Internal tick — iterates active states, arms pokes or fires fallback.
 * Exported as __tickForTests so suite can step the clock deterministically.
 */
function tick(now: number): void {
  if (activeDeps == null) return
  const thresholds = activeDeps.thresholdsMs ?? DEFAULT_THRESHOLDS
  for (const [key, s] of state.entries()) {
    const zeroAt = s.lastOutboundAt ?? s.turnStartedAt
    const silence = now - zeroAt
    if (silence < 0) continue
    const softThreshold = s.subagentDispatchActive
      ? thresholds.subagentSoft
      : thresholds.soft

    if (s.pokesFired === 0 && silence >= softThreshold) {
      s.pokeArmed = { level: 'soft' }
      s.pokesFired = 1
      s.lastPokeFiredAt = now
      activeDeps.emitMetric({
        kind: 'silence_poke_fired',
        key,
        level: 'soft',
        silence_ms: silence,
        subagent_wait: s.subagentDispatchActive,
      })
      continue
    }

    if (s.pokesFired === 1 && silence >= thresholds.firm) {
      s.pokeArmed = { level: 'firm' }
      s.pokesFired = 2
      s.lastPokeFiredAt = now
      activeDeps.emitMetric({
        kind: 'silence_poke_fired',
        key,
        level: 'firm',
        silence_ms: silence,
        subagent_wait: s.subagentDispatchActive,
      })
      continue
    }

    if (s.pokesFired === 2 && !s.fallbackFired && silence >= thresholds.fallback) {
      s.fallbackFired = true
      s.pokesFired = 3
      const { chatId, threadId } = parseKey(key)
      const recentThinking = s.lastThinkingAt != null
        && (now - s.lastThinkingAt) < 30_000
      const fallbackKind: 'working' | 'thinking' = recentThinking ? 'thinking' : 'working'
      activeDeps.emitMetric({
        kind: 'silence_fallback_sent',
        key,
        fallback_kind: fallbackKind,
        silence_ms: silence,
      })
      // Caller may throw or fail — guard so a busted fallback doesn't kill the timer.
      try {
        const r = activeDeps.onFrameworkFallback({
          key,
          chatId,
          threadId,
          fallbackKind,
          silenceMs: silence,
        })
        if (r != null && typeof (r as Promise<void>).catch === 'function') {
          ;(r as Promise<void>).catch((err) => {
            process.stderr.write(
              `silence-poke: framework fallback handler rejected: ${err}\n`,
            )
          })
        }
      } catch (err) {
        process.stderr.write(
          `silence-poke: framework fallback handler threw: ${err}\n`,
        )
      }
    }
  }
}

/**
 * Parse `<chatId>:<threadIdOrEmpty>` back into structured fields. Matches
 * the `statusKey` shape used throughout the gateway.
 */
function parseKey(key: string): { chatId: string; threadId: number | null } {
  const idx = key.indexOf(':')
  if (idx < 0) return { chatId: key, threadId: null }
  const chatId = key.slice(0, idx)
  const tail = key.slice(idx + 1)
  if (tail === '' || tail === 'undefined') return { chatId, threadId: null }
  const n = Number(tail)
  return { chatId, threadId: Number.isFinite(n) ? n : null }
}

/**
 * Start the timer. Idempotent — second call is a no-op. Stash deps so
 * tick() can find them. Honours the kill switch.
 */
export function startTimer(deps: SilencePokeDeps): void {
  if (!silencePokeEnabled()) return
  if (timer != null) return
  activeDeps = deps
  const poll = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  timer = setInterval(() => tick(Date.now()), poll)
  if (typeof timer.unref === 'function') timer.unref()
}

/** Stop the timer. Idempotent. */
export function stopTimer(): void {
  if (timer != null) {
    clearInterval(timer)
    timer = null
  }
  activeDeps = null
}

/** Test-only: drive a single tick at a deterministic clock value. */
export function __tickForTests(now: number): void {
  tick(now)
}

/** Test-only: install deps without starting the real timer. */
export function __setDepsForTests(deps: SilencePokeDeps | null): void {
  activeDeps = deps
}

/** Test-only: peek at state. */
export function __getStateForTests(key: string): SilencePokeState | undefined {
  return state.get(key)
}

/** Test-only: full reset. */
export function __resetAllForTests(): void {
  state.clear()
  stopTimer()
}
