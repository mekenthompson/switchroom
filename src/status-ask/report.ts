/**
 * status-ask/report.ts — pure aggregation library for the
 * `switchroom status-ask report` CLI verb.
 *
 * Reads the `runtime-metrics.jsonl` stream emitted by
 * `telegram-plugin/runtime-metrics.ts` (one event per line:
 * `{ ts, kind, ...fields }`) and computes the digest the operator
 * needs to track the **status-ask rate → zero** Goal from
 * `docs/status-ask-cause-classes.md`:
 *
 *   - Total `inbound_status_query` fires in the window (primary
 *     lagging KPI).
 *   - Rate vs total turns (failures per 1000 turns).
 *   - Per-day timeline + per-agent breakdown.
 *   - Per-fire silence trail — the events preceding each fire so
 *     the operator can RCA without round-tripping to PostHog.
 *   - Adjacent KPIs that move the rate: `outbound_silence_p95`,
 *     `silence_poke_succeeded / silence_poke_fired`,
 *     `silence_fallback_sent / turn_ended`.
 *
 * Pure: takes events in, returns the digest out. The CLI layer
 * handles file reading, agent enumeration, and markdown rendering.
 */

export interface RawEvent {
  ts: number
  kind: string
  /** Any additional event-specific fields. */
  [key: string]: unknown
}

export interface ParseResult {
  events: RawEvent[]
  /** Lines that failed to parse — line number (1-indexed) + reason. */
  errors: { line: number; reason: string }[]
}

/**
 * Parse a JSONL string into events. Tolerant — bad lines are
 * collected into `errors` rather than throwing, so a single
 * malformed line doesn't lose the rest of the file.
 */
export function parseJsonl(content: string): ParseResult {
  const events: RawEvent[] = []
  const errors: ParseResult['errors'] = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim()
    if (raw === '') continue
    try {
      const obj = JSON.parse(raw) as unknown
      if (
        typeof obj !== 'object' || obj == null
        || typeof (obj as RawEvent).ts !== 'number'
        || typeof (obj as RawEvent).kind !== 'string'
      ) {
        errors.push({ line: i + 1, reason: 'missing ts/kind' })
        continue
      }
      events.push(obj as RawEvent)
    } catch (err) {
      errors.push({
        line: i + 1,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { events, errors }
}

export interface ReportWindow {
  startMs: number
  endMs: number
}

export interface StatusAskFire {
  ts: number
  chatId: string
  agent: string | null
  textLength: number
  priorTurnInFlight: boolean
  secondsSinceTurnStart: number | null
  /**
   * Silence trail — events in the SAME chat within the
   * `trailLookbackMs` window preceding the fire. Most recent first.
   * Each line is a single human-readable summary, suitable for a
   * markdown bullet.
   */
  trail: TrailEntry[]
}

export interface TrailEntry {
  ts: number
  kind: string
  summary: string
}

export interface StatusAskReport {
  window: ReportWindow
  inboundStatusQueryCount: number
  turnEndedCount: number
  /** Status-asks per 1000 turns (rounded to 1 decimal). null if no turns. */
  ratePer1000Turns: number | null
  /** Per-day count, sorted by date ascending. */
  byDay: { date: string; count: number }[]
  /** Per-agent count, sorted descending. `null` agent = events that didn't carry an `agent` property. */
  byAgent: { agent: string | null; count: number }[]
  pokes: {
    fired: number
    succeeded: number
    /** Success rate, null if no fires. */
    successRate: number | null
    fallbacks: number
    /** Fallbacks per 1000 turns, null if no turns. */
    fallbackPer1000Turns: number | null
  }
  /** Longest silent gap, p95 (ms). Computed from turn_ended events whose duration_ms>30s. Null if no qualifying turns. */
  outboundSilenceP95Ms: number | null
  /** Most recent N fires with their silence trails. N controlled by the caller. */
  fires: StatusAskFire[]
}

export interface ComputeReportOpts {
  events: RawEvent[]
  window: ReportWindow
  /** Filter to a specific agent. Match against the event's `agent` property. */
  agent?: string | null
  /** Look-back window for the silence trail attached to each fire. Default 10 min. */
  trailLookbackMs?: number
  /** Max number of recent fires to attach trails to. Default 10. Set to 0 to skip. */
  firesLimit?: number
}

const DEFAULT_TRAIL_LOOKBACK_MS = 10 * 60_000
const DEFAULT_FIRES_LIMIT = 10
const MIN_TURN_DURATION_FOR_P95_MS = 30_000

/**
 * Compute the digest from a stream of events. Pure — no I/O.
 *
 * Order independence: events are NOT assumed pre-sorted by ts. The
 * function sorts internally so that an unmerged stream of multiple
 * per-agent JSONL files still produces a coherent timeline.
 */
export function computeReport(opts: ComputeReportOpts): StatusAskReport {
  const trailLookbackMs = opts.trailLookbackMs ?? DEFAULT_TRAIL_LOOKBACK_MS
  const firesLimit = opts.firesLimit ?? DEFAULT_FIRES_LIMIT

  const events = opts.events
    .filter((e) => e.ts >= opts.window.startMs && e.ts < opts.window.endMs)
    .filter((e) =>
      opts.agent === undefined
        ? true
        : (e.agent as string | undefined) === opts.agent
        || (opts.agent === null && e.agent == null),
    )
    .slice()
    .sort((a, b) => a.ts - b.ts)

  let inboundStatusQueryCount = 0
  let turnEndedCount = 0
  const byDay = new Map<string, number>()
  const byAgent = new Map<string | null, number>()
  let pokeFired = 0
  let pokeSucceeded = 0
  let pokeFallback = 0
  const silentGaps: number[] = []
  const allFires: RawEvent[] = []

  for (const e of events) {

    if (e.kind === 'inbound_status_query') {
      inboundStatusQueryCount++
      allFires.push(e)
      const dateKey = isoDate(e.ts)
      byDay.set(dateKey, (byDay.get(dateKey) ?? 0) + 1)
      const agent = (e.agent as string | undefined) ?? null
      byAgent.set(agent, (byAgent.get(agent) ?? 0) + 1)
    } else if (e.kind === 'turn_ended') {
      turnEndedCount++
      const gap = e.longest_silent_gap_ms
      const dur = e.duration_ms
      if (
        typeof gap === 'number'
        && typeof dur === 'number'
        && dur >= MIN_TURN_DURATION_FOR_P95_MS
      ) {
        silentGaps.push(gap)
      }
    } else if (e.kind === 'silence_poke_fired') {
      pokeFired++
    } else if (e.kind === 'silence_poke_succeeded') {
      pokeSucceeded++
    } else if (e.kind === 'silence_fallback_sent') {
      pokeFallback++
    }
  }

  // Build trails for the most recent N fires.
  const firesSortedDesc = allFires.slice().sort((a, b) => b.ts - a.ts)
  const firesWithTrails: StatusAskFire[] = firesSortedDesc
    .slice(0, firesLimit)
    .map((e) => {
      const chatId = (e.chat_id as string | undefined) ?? '?'
      const trail = buildTrail(events, chatId, e.ts, trailLookbackMs)
      return {
        ts: e.ts,
        chatId,
        agent: (e.agent as string | undefined) ?? null,
        textLength: (e.text_length as number | undefined) ?? 0,
        priorTurnInFlight: (e.prior_turn_in_flight as boolean | undefined) ?? false,
        secondsSinceTurnStart:
          (e.seconds_since_turn_start as number | null | undefined) ?? null,
        trail,
      }
    })

  return {
    window: opts.window,
    inboundStatusQueryCount,
    turnEndedCount,
    ratePer1000Turns:
      turnEndedCount > 0
        ? Math.round((inboundStatusQueryCount / turnEndedCount) * 10_000) / 10
        : null,
    byDay: [...byDay.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    byAgent: [...byAgent.entries()]
      .map(([agent, count]) => ({ agent, count }))
      .sort((a, b) => b.count - a.count),
    pokes: {
      fired: pokeFired,
      succeeded: pokeSucceeded,
      successRate: pokeFired > 0 ? pokeSucceeded / pokeFired : null,
      fallbacks: pokeFallback,
      fallbackPer1000Turns:
        turnEndedCount > 0
          ? Math.round((pokeFallback / turnEndedCount) * 10_000) / 10
          : null,
    },
    outboundSilenceP95Ms: percentile(silentGaps, 0.95),
    fires: firesWithTrails,
  }
}

function buildTrail(
  events: RawEvent[],
  chatId: string,
  fireTs: number,
  lookbackMs: number,
): TrailEntry[] {
  const cutoff = fireTs - lookbackMs
  const out: TrailEntry[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.ts >= fireTs) continue
    if (e.ts < cutoff) break
    if (eventChatId(e) !== chatId) continue
    out.push({
      ts: e.ts,
      kind: e.kind,
      summary: summarizeEvent(e),
    })
  }
  return out
}

/**
 * Extract the chat id from an event. Two shapes coexist in the
 * runtime-metrics JSONL (per `telegram-plugin/runtime-metrics.ts`):
 *
 *   - `inbound_status_query`, `turn_started`, `turn_ended` carry a
 *     top-level `chat_id` string.
 *   - `silence_poke_fired`, `silence_poke_succeeded`,
 *     `silence_fallback_sent` carry a `key` of shape
 *     `<chatId>:<threadIdOrEmpty>` (see `silence-poke.ts:parseKey`
 *     and `gateway.ts:statusKey`). No top-level `chat_id`.
 *
 * Without this normalisation the silence-poke events would silently
 * drop out of every fire's trail — exactly the trail entries an
 * operator most wants for RCA ("did pokes fire? did they succeed?
 * before the user typed status?"). PR1159 reviewer caught this.
 */
function eventChatId(e: RawEvent): string | null {
  const direct = e.chat_id
  if (typeof direct === 'string' && direct !== '') return direct
  const key = e.key
  if (typeof key === 'string' && key !== '') {
    const idx = key.indexOf(':')
    return idx >= 0 ? key.slice(0, idx) : key
  }
  return null
}

function summarizeEvent(e: RawEvent): string {
  switch (e.kind) {
    case 'inbound_status_query':
      return `inbound_status_query (text_length=${e.text_length}, prior_turn_in_flight=${e.prior_turn_in_flight})`
    case 'turn_started':
      return `turn_started${e.inbound_classified_as_status_query ? ' (classified as status-query)' : ''}`
    case 'turn_ended':
      return (
        `turn_ended (duration=${e.duration_ms}ms, ttfo=${e.ttfo_ms}ms, `
        + `outbound_count=${e.outbound_count}, longest_silent_gap=${e.longest_silent_gap_ms}ms, `
        + `ended_via=${e.ended_via})`
      )
    case 'silence_poke_fired':
      return `silence_poke_fired (level=${e.level}, silence_ms=${e.silence_ms}, subagent_wait=${e.subagent_wait})`
    case 'silence_poke_succeeded':
      return `silence_poke_succeeded (level=${e.level}, latency_ms=${e.latency_ms})`
    case 'silence_fallback_sent':
      return `silence_fallback_sent (fallback_kind=${e.fallback_kind}, silence_ms=${e.silence_ms})`
    default:
      return e.kind
  }
}

function isoDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10)
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = values.slice().sort((a, b) => a - b)
  // Nearest-rank — matches what most ops dashboards do for "p95".
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

/**
 * Parse a duration string like "24h", "7d", "30m", "all" into ms.
 * Returns `null` for "all" (caller treats null as "use the Unix
 * epoch as the window start" — `Date.toISOString()` blows up on
 * `Number.MIN_SAFE_INTEGER`, so `0` is the practical floor).
 * Throws on malformed input.
 */
export function parseDuration(input: string): number | null {
  const trimmed = input.trim().toLowerCase()
  if (trimmed === 'all') return null
  const m = /^(\d+)\s*(s|m|h|d|w)$/.exec(trimmed)
  if (!m) {
    throw new Error(
      `parseDuration: cannot parse ${JSON.stringify(input)} — expected forms like "24h", "7d", "30m", or "all"`,
    )
  }
  const n = Number.parseInt(m[1]!, 10)
  const unit = m[2]!
  const factor: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  }
  return n * factor[unit]!
}

/** Render the report as Markdown for `--format markdown` (the default). */
export function renderMarkdown(report: StatusAskReport): string {
  const lines: string[] = []
  const fmtTs = (ts: number) => new Date(ts).toISOString().replace('.000Z', 'Z')
  const ws = fmtTs(report.window.startMs)
  const we = fmtTs(report.window.endMs)

  lines.push(`# Status-ask report`)
  lines.push('')
  lines.push(`**Window:** ${ws} → ${we}`)
  lines.push('')

  lines.push(`## Headline`)
  lines.push('')
  lines.push(`- **${report.inboundStatusQueryCount}** \`inbound_status_query\` fires`)
  lines.push(`- **${report.turnEndedCount}** turns ended`)
  lines.push(
    `- **${
      report.ratePer1000Turns == null ? 'n/a' : `${report.ratePer1000Turns}`
    }** per 1000 turns (target: < 5)`,
  )
  lines.push(
    `- Outbound-silence p95 (turns > 30s): **${
      report.outboundSilenceP95Ms == null
        ? 'n/a'
        : `${report.outboundSilenceP95Ms}ms`
    }** (target: < 120000)`,
  )
  lines.push(
    `- Silence-poke success rate: **${
      report.pokes.successRate == null
        ? 'n/a'
        : `${Math.round(report.pokes.successRate * 1000) / 10}%`
    }** (${report.pokes.succeeded}/${report.pokes.fired}, target: > 80%)`,
  )
  lines.push(
    `- Framework fallbacks: **${report.pokes.fallbacks}**${
      report.pokes.fallbackPer1000Turns != null
        ? ` (${report.pokes.fallbackPer1000Turns} per 1000 turns, target: < 5)`
        : ''
    }`,
  )
  lines.push('')

  if (report.byDay.length > 0) {
    lines.push(`## Fires by day`)
    lines.push('')
    for (const d of report.byDay) {
      lines.push(`- ${d.date}: ${d.count}`)
    }
    lines.push('')
  }

  if (report.byAgent.length > 0) {
    lines.push(`## Fires by agent`)
    lines.push('')
    for (const a of report.byAgent) {
      lines.push(`- ${a.agent ?? '(unknown)'}: ${a.count}`)
    }
    lines.push('')
  }

  if (report.fires.length > 0) {
    lines.push(`## Recent fires (most recent first)`)
    lines.push('')
    for (const f of report.fires) {
      const sinceTurn =
        f.secondsSinceTurnStart != null
          ? `${f.secondsSinceTurnStart}s into the in-flight turn`
          : 'no prior in-flight turn'
      lines.push(
        `### ${fmtTs(f.ts)} — agent=${f.agent ?? '(unknown)'}, chat=${f.chatId}`,
      )
      lines.push('')
      lines.push(
        `- text_length=${f.textLength}, prior_turn_in_flight=${f.priorTurnInFlight}, ${sinceTurn}`,
      )
      if (f.trail.length > 0) {
        lines.push(`- **Trail (last ${f.trail.length} events in this chat):**`)
        for (const t of f.trail) {
          lines.push(
            `  - ${fmtTs(t.ts)} \`${t.kind}\` — ${t.summary}`,
          )
        }
      } else {
        lines.push(`- **Trail:** _(no preceding events in lookback window)_`)
      }
      lines.push('')
    }
  }

  return lines.join('\n')
}
