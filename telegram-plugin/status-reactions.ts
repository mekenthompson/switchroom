/**
 * Status reaction state machine for Telegram bot messages.
 *
 * Ports the pattern from openclaw's src/channels/status-reactions.ts +
 * extensions/telegram/src/status-reaction-variants.ts. The goal is to give
 * the user a glanceable, non-spammy progress signal on their inbound
 * message: 👀 received → 🤔 thinking → 🔥/👨‍💻/⚡ working → 👍 done → 😱 error.
 *
 * Three load-bearing properties (all from openclaw research):
 *
 *  1. Debounce intermediate transitions by 700ms so a model that flashes
 *     thinking → tool → thinking → tool doesn't burn the rate limit.
 *
 *  2. Terminal states (queued / done / error) bypass the debounce.
 *
 *  3. Serialize all API calls through a single chain promise so two
 *     concurrent transitions never race the Telegram API. Telegram's
 *     setMessageReaction replaces atomically — no removeReaction needed.
 *
 * Stall watchdogs auto-promote to 🥱 / 😨 if no transition arrives within
 * 30s / 90s, so a stuck/dead inference loop is visually distinguishable
 * from a long but healthy one.
 *
 * Emoji choices use Telegram's bot reaction whitelist
 * (https://core.telegram.org/bots/api#reactiontype). The fallback chain
 * tries each variant in order — if a chat restricts available reactions
 * (admin-configured in some groups) the controller silently no-ops the
 * unsupported choice instead of throwing.
 */

/** Telegram allows only this fixed set of emoji as bot reactions. */
export const TELEGRAM_REACTION_WHITELIST = new Set([
  '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱',
  '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡',
  '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡',
  '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈',
  '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨',
  '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿',
  '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾',
  '🤷‍♂', '🤷', '🤷‍♀', '😡',
])

/** Logical reaction states the controller tracks. */
export type ReactionState =
  | 'queued'
  | 'thinking'
  | 'coding'
  | 'web'
  | 'tool'
  | 'compacting'
  | 'done'
  | 'error'
  | 'stallSoft'
  | 'stallHard'

/**
 * Per-state emoji preference, with fallbacks if the first isn't allowed
 * in this particular chat. Modeled on openclaw's
 * TELEGRAM_STATUS_REACTION_VARIANTS.
 */
export const REACTION_VARIANTS: Record<ReactionState, string[]> = {
  queued:    ['👀', '👍', '🔥'],
  thinking:  ['🤔', '🤓', '👀'],
  tool:      ['🔥', '⚡', '👍'],
  coding:    ['👨‍💻', '🔥', '⚡'],
  web:       ['⚡', '🔥', '👍'],
  compacting:['✍', '🤔', '👀'],
  done:      ['👍', '🎉', '💯'],
  error:     ['😱', '😨', '🤯'],
  stallSoft: ['🥱', '😴', '🤔'],
  stallHard: ['😨', '🤯', '😱'],
}

/**
 * Map a tool name string from a CallToolRequest into the appropriate
 * reaction state. Falls back to generic 'tool' for anything we don't
 * have a more specific bucket for.
 */
export function resolveToolReactionState(toolName: string): ReactionState {
  const n = toolName.toLowerCase()
  if (n.includes('bash') || n.includes('exec') || n.includes('shell')) return 'coding'
  if (n.includes('read') || n.includes('write') || n.includes('edit')
    || n.includes('multiedit') || n.includes('notebook') || n.includes('glob')
    || n.includes('grep')) return 'coding'
  if (n.includes('webfetch') || n.includes('websearch') || n.includes('browser')
    || n.includes('fetch') || n.includes('search')) return 'web'
  return 'tool'
}

/** Configuration knobs the controller respects. */
export interface StatusReactionConfig {
  /** Milliseconds to wait before applying a non-immediate transition. Default 700. */
  debounceMs?: number
  /** Milliseconds without progress before promoting to stallSoft. Default 30000. */
  stallSoftMs?: number
  /** Milliseconds without progress before promoting to stallHard. Default 90000. */
  stallHardMs?: number
  /** Optional logger for debugging — receives a single string per event. */
  log?: (msg: string) => void
}

/**
 * Function the controller calls to actually emit a reaction. Receives the
 * resolved emoji (already filtered through the chat's allowed set) and
 * should return a promise that resolves once the API call completes.
 *
 * The function should NOT throw on Telegram errors — silently swallow
 * unsupported-reaction failures so the controller can move on.
 */
export type ReactionEmitter = (emoji: string) => Promise<void>

/**
 * Controller managing the reaction lifecycle for a single inbound message.
 *
 * Lifecycle: construct → setQueued() → arbitrary intermediate transitions
 * → setDone() / setError() to terminate. After termination, all further
 * setX calls are no-ops.
 */
export class StatusReactionController {
  private currentEmoji: string | null = null
  private pendingEmoji: string | null = null
  private chainPromise: Promise<unknown> = Promise.resolve()
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private stallSoftTimer: ReturnType<typeof setTimeout> | null = null
  private stallHardTimer: ReturnType<typeof setTimeout> | null = null
  private finished = false
  private readonly debounceMs: number
  private readonly stallSoftMs: number
  private readonly stallHardMs: number
  private readonly log?: (msg: string) => void

  constructor(
    private readonly emit: ReactionEmitter,
    /** Chat reactions allowed in this specific chat (null = all whitelisted). */
    private readonly allowedReactions: Set<string> | null = null,
    config: StatusReactionConfig = {},
  ) {
    this.debounceMs = config.debounceMs ?? 700
    this.stallSoftMs = config.stallSoftMs ?? 30000
    this.stallHardMs = config.stallHardMs ?? 90000
    this.log = config.log
  }

  /** 👀 — message received and queued for processing. Bypasses debounce. */
  setQueued(): void {
    this.scheduleState('queued', { immediate: true })
  }

  /** 🤔 — model is generating. Debounced. */
  setThinking(): void {
    this.scheduleState('thinking')
  }

  /** Tool-specific reaction. Debounced. */
  setTool(toolName?: string): void {
    const state = toolName ? resolveToolReactionState(toolName) : 'tool'
    this.scheduleState(state)
  }

  /** ✍ — context compaction in progress. */
  setCompacting(): void {
    this.scheduleState('compacting')
  }

  /** 👍 — final reply delivered. Terminal, bypasses debounce. */
  setDone(): void {
    this.finishWithState('done')
  }

  /** 😱 — generation failed. Terminal, bypasses debounce. */
  setError(): void {
    this.finishWithState('error')
  }

  /** Stop the controller without applying any new reaction. Terminal. */
  cancel(): void {
    if (this.finished) return
    this.finished = true
    this.clearDebounceTimer()
    this.clearStallTimers()
  }

  // ──────────────────────────────────────────────────────────────────────

  private scheduleState(
    state: ReactionState,
    opts: { immediate?: boolean; skipStallReset?: boolean } = {},
  ): void {
    if (this.finished) return
    const emoji = this.resolveEmoji(state)
    if (emoji == null) {
      // No allowed variant for this chat — silently skip rather than fall
      // through to the chain. We still reset stall timers so that progress
      // signals continue to keep the watchdogs at bay.
      if (!opts.skipStallReset) this.resetStallTimers()
      return
    }
    if (emoji === this.currentEmoji || emoji === this.pendingEmoji) {
      if (!opts.skipStallReset) this.resetStallTimers()
      return
    }
    this.pendingEmoji = emoji
    this.clearDebounceTimer()
    if (opts.immediate) {
      this.enqueue(emoji)
    } else {
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null
        this.enqueue(emoji)
      }, this.debounceMs)
    }
    if (!opts.skipStallReset) this.resetStallTimers()
  }

  private finishWithState(state: ReactionState): void {
    if (this.finished) return
    this.finished = true
    this.clearDebounceTimer()
    this.clearStallTimers()
    const emoji = this.resolveEmoji(state)
    if (emoji != null && emoji !== this.currentEmoji) {
      this.enqueue(emoji)
    }
  }

  private enqueue(emoji: string): void {
    this.chainPromise = this.chainPromise.then(async () => {
      try {
        await this.emit(emoji)
        this.currentEmoji = emoji
        if (this.pendingEmoji === emoji) this.pendingEmoji = null
        this.log?.(`reaction → ${emoji}`)
      } catch (err) {
        this.log?.(`reaction emit failed (${emoji}): ${(err as Error).message}`)
      }
    })
  }

  private resolveEmoji(state: ReactionState): string | null {
    const variants = REACTION_VARIANTS[state]
    for (const v of variants) {
      if (!TELEGRAM_REACTION_WHITELIST.has(v)) continue
      if (this.allowedReactions == null || this.allowedReactions.has(v)) {
        return v
      }
    }
    // Last resort: any whitelisted-and-allowed emoji from the broad fallback set
    for (const v of ['👍', '👀', '🔥']) {
      if (this.allowedReactions == null || this.allowedReactions.has(v)) {
        return v
      }
    }
    return null
  }

  private resetStallTimers(): void {
    this.clearStallTimers()
    if (this.finished) return
    this.stallSoftTimer = setTimeout(() => {
      this.stallSoftTimer = null
      // Don't reset the stall timers when the stall transition itself fires —
      // otherwise stallHard would never get a chance to run after stallSoft.
      this.scheduleState('stallSoft', { immediate: true, skipStallReset: true })
    }, this.stallSoftMs)
    this.stallHardTimer = setTimeout(() => {
      this.stallHardTimer = null
      this.scheduleState('stallHard', { immediate: true, skipStallReset: true })
    }, this.stallHardMs)
  }

  private clearStallTimers(): void {
    if (this.stallSoftTimer) {
      clearTimeout(this.stallSoftTimer)
      this.stallSoftTimer = null
    }
    if (this.stallHardTimer) {
      clearTimeout(this.stallHardTimer)
      this.stallHardTimer = null
    }
  }

  private clearDebounceTimer(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }
}
