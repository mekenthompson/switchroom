/**
 * Structured logger for the pinned progress-card lifecycle.
 *
 * Mirrors `pin-event-log.ts` in shape: an append-only JSON-line writer with
 * a stable schema. Every meaningful card-driver state transition emits one
 * line so operators can grep / replay days-old sessions and answer "did the
 * card render? when did it finalize? was a sub-agent row ever attached?"
 * without parsing free-form `progress-card:` traces.
 *
 * Output target:
 *   - If `$STATE_DIR` is set, `<STATE_DIR>/card-events.jsonl` (append-only).
 *   - Otherwise the line is forwarded to stderr (which the plugin-logger
 *     captures into `~/.switchroom/logs/telegram-plugin.log`).
 *
 * No rotation in this PR — the file is the durable audit trail and a
 * follow-up can add retention once the size envelope is understood.
 *
 * Pure helper. No globals. The write target is injectable for tests.
 */

import { appendFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'

export type CardEventName =
  | 'rendered'
  | 'edited'
  | 'finalized'
  | 'suppressed'
  | 'deferred'
  | 'force-completed'
  | 'deleted'

export interface CardEvent {
  /** Unix-ms wall clock. */
  ts: number
  /** Agent slug (e.g. SWITCHROOM_AGENT_NAME). Empty string if unknown. */
  agent: string
  /** Telegram chat id as string (matches the rest of the plugin). */
  chatId: string
  /** Driver-assigned per-turn key (chatId:threadId:seq). */
  turnKey: string
  /** The pinned card message_id once known. Optional pre-render. */
  cardMessageId?: number
  event: CardEventName
  /**
   * Free-text qualifier — e.g. the reason a turn was deferred
   * ("in-flight-sub-agents"), the API class for a 4xx abandon, the
   * synthetic kind for a force-complete. Single-line, ≤200 chars.
   */
  reason?: string
  /** sha1-12 of the rendered HTML, when relevant. Lets us spot edit storms. */
  htmlHash?: string
  /** Sub-agent ids attached to the card at the time of the event. */
  subagents?: string[]
  /** Elapsed ms since turn start, when the call site has it cheaply. */
  durationMs?: number
}

export type CardEventWriter = (line: string) => void

let resolvedPath: string | null | undefined

/**
 * Compute the target path once and memoize. `$STATE_DIR` set → write to
 * `<STATE_DIR>/card-events.jsonl`; otherwise return null (the default
 * writer falls back to stderr in that case).
 *
 * Exposed so tests can assert resolution without actually writing.
 */
export function resolveCardEventPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env.STATE_DIR
  if (!dir || dir.length === 0) return null
  return join(dir, 'card-events.jsonl')
}

/**
 * Reset the memoized path. Tests only.
 */
export function _resetForTests(): void {
  resolvedPath = undefined
}

const defaultWriter: CardEventWriter = (line) => {
  if (resolvedPath === undefined) {
    resolvedPath = resolveCardEventPath()
  }
  const target = resolvedPath
  if (target == null) {
    // Fall back to stderr (the plugin-logger captures stderr into the
    // freeform log). Prefix lets operators grep just like pin-event:.
    try {
      process.stderr.write(`card-event: ${line}`)
    } catch {
      // Never throw from a logger.
    }
    return
  }
  try {
    mkdirSync(dirname(target), { recursive: true })
    appendFileSync(target, line)
  } catch {
    // Best-effort: if the structured sink fails, surface to stderr so the
    // event is at least in the freeform log.
    try {
      process.stderr.write(`card-event: ${line}`)
    } catch {
      // ignore
    }
  }
}

export function logCardEvent(event: CardEvent, write: CardEventWriter = defaultWriter): void {
  // Drop undefined fields so the JSON output stays compact and grep-friendly.
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(event)) {
    if (v !== undefined) cleaned[k] = v
  }
  const payload = JSON.stringify(cleaned)
  write(`${payload}\n`)
}

/**
 * Convenience constructor — fills `ts` automatically. Most call sites only
 * have agent / chatId / turnKey / event / a few qualifiers; this keeps the
 * boilerplate low.
 */
export function emitCardEvent(
  partial: Omit<CardEvent, 'ts'> & { ts?: number },
  write: CardEventWriter = defaultWriter,
): void {
  logCardEvent(
    {
      ts: partial.ts ?? Date.now(),
      ...partial,
    } as CardEvent,
    write,
  )
}
