/**
 * Progress-card pin watchdog.
 *
 * The pin manager (progress-card-pin-manager.ts) owns the pin/unpin
 * sequence at turn boundaries. Between those boundaries, nothing in
 * our code path re-checks whether the pin Telegram actually shows the
 * user still matches the one we pinned — but in practice it can
 * drift:
 *
 *   - Another user (or the bot itself via a different surface) pins
 *     a message, displacing ours. Telegram keeps ours in history but
 *     the chat header now points elsewhere.
 *   - A stale early-unpin fires on a pending turn (the bug this
 *     watchdog backstops) — we've removed the known code paths but
 *     want defense in depth.
 *   - The user manually unpins mid-turn.
 *
 * The watchdog runs on every progress-card heartbeat emit. It is
 * rate-limited per turnKey (default 30s) so we don't hammer
 * getChat. When it sees a mismatch, it re-pins the card so the user
 * keeps seeing "work in progress" at the top of the chat until the
 * turn actually completes.
 *
 * Contract (covered by progress-card-pin-watchdog.test.ts):
 *
 *   verify({ chatId, turnKey, expectedMessageId })
 *     - First call for a turnKey always probes.
 *     - Subsequent calls within `intervalMs` are silent no-ops.
 *     - On probe: if getCurrentPinned returns the expected id, no
 *       action. Otherwise re-pin. Errors from either API call are
 *       caught and logged — never thrown.
 *
 *   clear(turnKey)
 *     - Drops the rate-limit timestamp so a future turn reusing the
 *       key starts fresh. Called from onTurnComplete.
 */

export interface PinWatchdogDeps {
  /**
   * Read the id of whatever Telegram currently shows pinned at the
   * top of `chatId`. Implementations typically call
   * `bot.api.getChat(chatId).pinned_message?.message_id`. Return
   * undefined when nothing is pinned.
   */
  getCurrentPinned: (chatId: string) => Promise<number | undefined>
  /** Re-pin if we detect a mismatch. Mirrors `pinChatMessage`. */
  pin: (
    chatId: string,
    messageId: number,
    opts?: { disable_notification?: boolean },
  ) => Promise<unknown>
  /** Minimum interval between getChat probes per turnKey. Default 30s. */
  intervalMs?: number
  /** Clock injection for test determinism. Defaults to `Date.now`. */
  now?: () => number
  /** Receives log lines with trailing newline. */
  log?: (line: string) => void
}

export interface PinWatchdog {
  verify(args: {
    chatId: string
    turnKey: string
    expectedMessageId: number
  }): Promise<void>
  /** Clear state for a turnKey (call on turn completion). */
  clear(turnKey: string): void
}

export function createPinWatchdog(deps: PinWatchdogDeps): PinWatchdog {
  const interval = deps.intervalMs ?? 30_000
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  // turnKey -> last probe timestamp. Cleared on turn completion.
  const lastProbedAt = new Map<string, number>()

  return {
    async verify({ chatId, turnKey, expectedMessageId }) {
      const last = lastProbedAt.get(turnKey)
      const t = now()
      // First call always probes. Subsequent calls wait for the
      // interval so a chatty turn doesn't saturate getChat.
      if (last != null && t - last < interval) return
      lastProbedAt.set(turnKey, t)
      try {
        const currentPinned = await deps.getCurrentPinned(chatId)
        if (currentPinned === expectedMessageId) return
        await deps.pin(chatId, expectedMessageId, { disable_notification: true })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(`telegram gateway: progress-card watchdog failed: ${msg}\n`)
      }
    },
    clear(turnKey) {
      lastProbedAt.delete(turnKey)
    },
  }
}
