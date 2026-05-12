import { describe, it, expect } from 'vitest'
import {
  parseJsonl,
  computeReport,
  parseDuration,
  renderMarkdown,
  type RawEvent,
} from './report.js'

const T0 = 1_700_000_000_000 // arbitrary fixed timestamp
const HOUR = 3_600_000
const DAY = 86_400_000

function ev(extra: Record<string, unknown>): RawEvent {
  return { ts: T0, kind: 'inbound_status_query', ...extra }
}

describe('parseJsonl', () => {
  it('parses well-formed lines into events', () => {
    const content =
      `${JSON.stringify({ ts: 1, kind: 'turn_started' })}\n`
      + `${JSON.stringify({ ts: 2, kind: 'turn_ended', duration_ms: 1000 })}\n`
    const { events, errors } = parseJsonl(content)
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ ts: 1, kind: 'turn_started' })
    expect(errors).toHaveLength(0)
  })

  it('tolerates blank lines and trailing newline', () => {
    const content =
      `\n${JSON.stringify({ ts: 1, kind: 'turn_started' })}\n\n`
    const { events, errors } = parseJsonl(content)
    expect(events).toHaveLength(1)
    expect(errors).toHaveLength(0)
  })

  it('collects malformed lines as errors instead of throwing', () => {
    const content =
      `not-json\n${JSON.stringify({ ts: 1, kind: 'turn_started' })}\n{"missing-ts":true}\n`
    const { events, errors } = parseJsonl(content)
    expect(events).toHaveLength(1)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({ line: 1 })
    expect(errors[1]).toMatchObject({ line: 3, reason: 'missing ts/kind' })
  })
})

describe('computeReport — headline counters', () => {
  it('counts inbound_status_query and turn_ended within the window', () => {
    const events: RawEvent[] = [
      { ts: T0, kind: 'turn_started', chat_id: 'c1' },
      { ts: T0 + 1000, kind: 'inbound_status_query', chat_id: 'c1', text_length: 7, prior_turn_in_flight: true, seconds_since_turn_start: 90 },
      { ts: T0 + 2000, kind: 'turn_ended', chat_id: 'c1', duration_ms: 5000, ttfo_ms: 1000, outbound_count: 1, longest_silent_gap_ms: 2000, ended_via: 'reply' },
    ]
    const r = computeReport({ events, window: { startMs: T0 - 1, endMs: T0 + 10_000 } })
    expect(r.inboundStatusQueryCount).toBe(1)
    expect(r.turnEndedCount).toBe(1)
    expect(r.ratePer1000Turns).toBe(1000)
  })

  it('returns null rate when no turns ended in the window', () => {
    const events: RawEvent[] = [
      { ts: T0, kind: 'inbound_status_query', chat_id: 'c1', text_length: 7, prior_turn_in_flight: false, seconds_since_turn_start: null },
    ]
    const r = computeReport({ events, window: { startMs: T0 - 1, endMs: T0 + 10_000 } })
    expect(r.ratePer1000Turns).toBe(null)
  })

  it('excludes events outside the window', () => {
    const events: RawEvent[] = [
      { ts: T0 - DAY, kind: 'inbound_status_query', chat_id: 'c1' }, // before window
      { ts: T0, kind: 'inbound_status_query', chat_id: 'c1' }, // in window
      { ts: T0 + DAY, kind: 'inbound_status_query', chat_id: 'c1' }, // after window (endMs is exclusive)
    ]
    const r = computeReport({ events, window: { startMs: T0 - 1, endMs: T0 + 100 } })
    expect(r.inboundStatusQueryCount).toBe(1)
  })
})

describe('computeReport — breakdowns', () => {
  it('groups by ISO date', () => {
    const day1 = T0 // 2023-11-14
    const day2 = T0 + DAY
    const events: RawEvent[] = [
      { ts: day1, kind: 'inbound_status_query', chat_id: 'c1' },
      { ts: day1 + HOUR, kind: 'inbound_status_query', chat_id: 'c1' },
      { ts: day2, kind: 'inbound_status_query', chat_id: 'c1' },
    ]
    const r = computeReport({ events, window: { startMs: day1 - 1, endMs: day2 + HOUR } })
    expect(r.byDay).toHaveLength(2)
    expect(r.byDay[0].count).toBe(2)
    expect(r.byDay[1].count).toBe(1)
  })

  it('groups by agent and sorts descending', () => {
    const events: RawEvent[] = [
      { ts: T0, kind: 'inbound_status_query', chat_id: 'c1', agent: 'alice' },
      { ts: T0 + 1, kind: 'inbound_status_query', chat_id: 'c1', agent: 'bob' },
      { ts: T0 + 2, kind: 'inbound_status_query', chat_id: 'c1', agent: 'bob' },
      { ts: T0 + 3, kind: 'inbound_status_query', chat_id: 'c1', agent: 'bob' },
      { ts: T0 + 4, kind: 'inbound_status_query', chat_id: 'c1' }, // no agent → null bucket
    ]
    const r = computeReport({ events, window: { startMs: T0 - 1, endMs: T0 + 100 } })
    expect(r.byAgent).toEqual([
      { agent: 'bob', count: 3 },
      { agent: 'alice', count: 1 },
      { agent: null, count: 1 },
    ])
  })

  it('filters to one agent when opts.agent is set', () => {
    const events: RawEvent[] = [
      { ts: T0, kind: 'inbound_status_query', chat_id: 'c1', agent: 'alice' },
      { ts: T0 + 1, kind: 'inbound_status_query', chat_id: 'c1', agent: 'bob' },
    ]
    const r = computeReport({
      events,
      window: { startMs: T0 - 1, endMs: T0 + 100 },
      agent: 'alice',
    })
    expect(r.inboundStatusQueryCount).toBe(1)
    expect(r.byAgent).toEqual([{ agent: 'alice', count: 1 }])
  })
})

describe('computeReport — poke aggregates', () => {
  it('computes success rate', () => {
    const events: RawEvent[] = [
      { ts: T0, kind: 'silence_poke_fired', level: 'soft', silence_ms: 75_000 },
      { ts: T0 + 5000, kind: 'silence_poke_succeeded', level: 'soft', latency_ms: 5000 },
      { ts: T0 + 100_000, kind: 'silence_poke_fired', level: 'firm', silence_ms: 180_000 },
      { ts: T0 + 200_000, kind: 'silence_poke_fired', level: 'soft', silence_ms: 80_000 },
    ]
    const r = computeReport({ events, window: { startMs: T0 - 1, endMs: T0 + DAY } })
    expect(r.pokes.fired).toBe(3)
    expect(r.pokes.succeeded).toBe(1)
    expect(r.pokes.successRate).toBeCloseTo(1 / 3)
  })

  it('computes fallback rate per 1000 turns', () => {
    const events: RawEvent[] = [
      { ts: T0, kind: 'turn_ended', duration_ms: 60_000, longest_silent_gap_ms: 5000, outbound_count: 1, ttfo_ms: 1000, ended_via: 'reply' },
      { ts: T0 + 1, kind: 'turn_ended', duration_ms: 60_000, longest_silent_gap_ms: 5000, outbound_count: 1, ttfo_ms: 1000, ended_via: 'reply' },
      { ts: T0 + 2, kind: 'silence_fallback_sent', fallback_kind: 'working', silence_ms: 300_000 },
    ]
    const r = computeReport({ events, window: { startMs: T0 - 1, endMs: T0 + DAY } })
    expect(r.pokes.fallbacks).toBe(1)
    expect(r.pokes.fallbackPer1000Turns).toBe(500)
  })
})

describe('computeReport — outbound silence p95', () => {
  it('p95 ignores fast turns (<30s)', () => {
    const events: RawEvent[] = [
      // 5 fast turns with low gaps — should be ignored
      ...Array.from({ length: 5 }).map((_, i) => ({
        ts: T0 + i,
        kind: 'turn_ended',
        duration_ms: 5_000,
        longest_silent_gap_ms: 1_000,
        outbound_count: 1,
        ttfo_ms: 500,
        ended_via: 'reply',
      })),
      // 20 slow turns with gaps from 10s to 200s — p95 ≈ 180_000
      ...Array.from({ length: 20 }).map((_, i) => ({
        ts: T0 + 100 + i,
        kind: 'turn_ended',
        duration_ms: 60_000,
        longest_silent_gap_ms: (i + 1) * 10_000,
        outbound_count: 1,
        ttfo_ms: 500,
        ended_via: 'reply',
      })),
    ]
    const r = computeReport({ events, window: { startMs: T0 - 1, endMs: T0 + DAY } })
    // p95 of [10_000, 20_000, ..., 200_000] (20 values) — nearest-rank
    // p95 → ceil(0.95 * 20) - 1 = 18 → 190_000
    expect(r.outboundSilenceP95Ms).toBe(190_000)
  })

  it('null p95 when no qualifying turns', () => {
    const events: RawEvent[] = []
    const r = computeReport({ events, window: { startMs: T0 - 1, endMs: T0 + DAY } })
    expect(r.outboundSilenceP95Ms).toBe(null)
  })
})

describe('computeReport — fire trails', () => {
  it('attaches preceding events in the same chat as the trail', () => {
    const events: RawEvent[] = [
      { ts: T0, kind: 'turn_started', chat_id: 'c1', agent: 'a' },
      // silence-poke events emit `key` (shape `<chatId>:<threadIdOrEmpty>`),
      // NOT `chat_id` — matches the real schema in `runtime-metrics.ts`
      // and what the gateway writes via `statusKey()`. The trail builder
      // must extract chat_id from `key` for these events to reach the
      // RCA trail. PR1159 reviewer caught the prior fixture that papered
      // over this by stamping `chat_id` directly.
      { ts: T0 + 75_000, kind: 'silence_poke_fired', key: 'c1:_', agent: 'a', level: 'soft', silence_ms: 75_000 },
      { ts: T0 + 180_000, kind: 'silence_poke_fired', key: 'c1:_', agent: 'a', level: 'firm', silence_ms: 180_000 },
      // Status-ask fires at t=200s:
      { ts: T0 + 200_000, kind: 'inbound_status_query', chat_id: 'c1', agent: 'a', text_length: 7, prior_turn_in_flight: true, seconds_since_turn_start: 200 },
      // Noise in a different chat — must NOT appear in the trail:
      { ts: T0 + 150_000, kind: 'silence_poke_fired', key: 'OTHER:_', agent: 'a', level: 'soft', silence_ms: 75_000 },
    ]
    const r = computeReport({ events, window: { startMs: T0 - 1, endMs: T0 + DAY } })
    expect(r.fires).toHaveLength(1)
    const fire = r.fires[0]
    expect(fire.chatId).toBe('c1')
    expect(fire.agent).toBe('a')
    expect(fire.priorTurnInFlight).toBe(true)
    expect(fire.secondsSinceTurnStart).toBe(200)
    // Trail has the three preceding c1 events, most-recent-first:
    expect(fire.trail.map((t) => t.kind)).toEqual([
      'silence_poke_fired',
      'silence_poke_fired',
      'turn_started',
    ])
    // Different-chat event is NOT in the trail:
    expect(fire.trail.find((t) => t.summary.includes('OTHER'))).toBeUndefined()
  })

  it('respects firesLimit', () => {
    const events: RawEvent[] = Array.from({ length: 25 }).map((_, i) => ({
      ts: T0 + i * 1000,
      kind: 'inbound_status_query',
      chat_id: `c${i}`,
      agent: 'a',
      text_length: 7,
      prior_turn_in_flight: false,
      seconds_since_turn_start: null,
    }))
    const r = computeReport({
      events,
      window: { startMs: T0 - 1, endMs: T0 + DAY },
      firesLimit: 5,
    })
    expect(r.fires).toHaveLength(5)
    // Most recent first
    expect(r.fires[0].chatId).toBe('c24')
    expect(r.fires[4].chatId).toBe('c20')
  })

  // PR1159 reviewer regression: the previous trail builder filtered on
  // `chat_id` only, and silence-poke events carry `key` (shape
  // `<chatId>:<threadId>`) NOT `chat_id`. So poke events silently
  // dropped out of every fire's trail — exactly the events the
  // operator needs for RCA. This test exercises the `key` path
  // with no `chat_id` fallback present.
  it('extracts chat_id from `key` for silence-poke events that lack chat_id (PR1159)', () => {
    const events: RawEvent[] = [
      { ts: T0 + 75_000, kind: 'silence_poke_fired', key: 'c1:_', level: 'soft', silence_ms: 75_000 },
      { ts: T0 + 100_000, kind: 'silence_poke_succeeded', key: 'c1:_', level: 'soft', latency_ms: 25_000 },
      { ts: T0 + 200_000, kind: 'inbound_status_query', chat_id: 'c1', agent: 'a', text_length: 7, prior_turn_in_flight: true, seconds_since_turn_start: 200 },
      // Same wire-format poke for a different chat — must NOT leak into c1's trail.
      { ts: T0 + 90_000, kind: 'silence_poke_fired', key: 'OTHER:_', level: 'soft', silence_ms: 75_000 },
    ]
    const r = computeReport({ events, window: { startMs: T0 - 1, endMs: T0 + DAY } })
    expect(r.fires).toHaveLength(1)
    expect(r.fires[0].trail.map((t) => t.kind)).toEqual([
      'silence_poke_succeeded',
      'silence_poke_fired',
    ])
  })

  it('extracts chat_id from `key` with a numeric threadId suffix', () => {
    // statusKey format is `<chatId>:<threadIdOrEmpty>`; we only need
    // the chatId half. Make sure a non-`_` threadId doesn't bleed
    // into the chatId extraction.
    const events: RawEvent[] = [
      { ts: T0 + 75_000, kind: 'silence_poke_fired', key: 'c1:12345', level: 'soft', silence_ms: 75_000 },
      { ts: T0 + 200_000, kind: 'inbound_status_query', chat_id: 'c1', agent: 'a', text_length: 7, prior_turn_in_flight: false, seconds_since_turn_start: null },
    ]
    const r = computeReport({ events, window: { startMs: T0 - 1, endMs: T0 + DAY } })
    expect(r.fires[0].trail).toHaveLength(1)
    expect(r.fires[0].trail[0].kind).toBe('silence_poke_fired')
  })

  it('honors trailLookbackMs', () => {
    const events: RawEvent[] = [
      // Old event 30 min ago — outside the default 10min lookback
      { ts: T0, kind: 'turn_started', chat_id: 'c1' },
      // Recent event 2 min ago — inside lookback
      { ts: T0 + 28 * 60_000, kind: 'silence_poke_fired', key: 'c1:_', level: 'soft', silence_ms: 75_000 },
      // Fire at 30 min
      { ts: T0 + 30 * 60_000, kind: 'inbound_status_query', chat_id: 'c1', text_length: 7, prior_turn_in_flight: false, seconds_since_turn_start: null },
    ]
    const r = computeReport({
      events,
      window: { startMs: T0 - 1, endMs: T0 + DAY },
      trailLookbackMs: 10 * 60_000,
    })
    expect(r.fires[0].trail.map((t) => t.kind)).toEqual(['silence_poke_fired'])
  })
})

describe('parseDuration', () => {
  it('parses common durations', () => {
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('24h')).toBe(86_400_000)
    expect(parseDuration('7d')).toBe(7 * 86_400_000)
    expect(parseDuration('2w')).toBe(14 * 86_400_000)
  })

  it('returns null for "all"', () => {
    expect(parseDuration('all')).toBe(null)
    expect(parseDuration('ALL')).toBe(null)
  })

  it('throws on garbage', () => {
    expect(() => parseDuration('forever')).toThrow()
    expect(() => parseDuration('5')).toThrow()
    expect(() => parseDuration('5z')).toThrow()
  })

  it('tolerates spacing', () => {
    expect(parseDuration(' 24h ')).toBe(86_400_000)
    expect(parseDuration('24 h')).toBe(86_400_000)
  })
})

describe('renderMarkdown', () => {
  it('renders a non-empty digest for a populated report', () => {
    const events: RawEvent[] = [
      { ts: T0, kind: 'turn_started', chat_id: 'c1', agent: 'alice' },
      { ts: T0 + 75_000, kind: 'silence_poke_fired', key: 'c1:_', agent: 'alice', level: 'soft', silence_ms: 75_000 },
      { ts: T0 + 100_000, kind: 'inbound_status_query', chat_id: 'c1', agent: 'alice', text_length: 7, prior_turn_in_flight: true, seconds_since_turn_start: 100 },
      { ts: T0 + 110_000, kind: 'turn_ended', chat_id: 'c1', agent: 'alice', duration_ms: 110_000, ttfo_ms: 5000, outbound_count: 2, longest_silent_gap_ms: 80_000, ended_via: 'reply' },
    ]
    const r = computeReport({ events, window: { startMs: T0 - 1, endMs: T0 + DAY } })
    const md = renderMarkdown(r)
    expect(md).toContain('# Status-ask report')
    expect(md).toContain('**1** `inbound_status_query` fires')
    expect(md).toContain('Fires by agent')
    expect(md).toContain('alice: 1')
    expect(md).toContain('Recent fires')
    expect(md).toContain('Trail (last')
  })

  it('renders an empty digest gracefully (no fires, no breakdowns)', () => {
    const r = computeReport({
      events: [],
      window: { startMs: T0 - 1, endMs: T0 + DAY },
    })
    const md = renderMarkdown(r)
    expect(md).toContain('**0** `inbound_status_query` fires')
    expect(md).not.toContain('Fires by day')
    expect(md).not.toContain('Recent fires')
  })
})
