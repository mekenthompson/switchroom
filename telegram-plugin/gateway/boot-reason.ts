/**
 * Pure helpers for determining boot reason and resolving the target chat
 * on every gateway start.
 *
 * Kept in a separate module so unit tests can import them without pulling
 * in the full gateway.ts side-effect tree (bot setup, DB init, etc.).
 */

import type { RestartReason } from './boot-card.js'
import type { CleanShutdownMarker } from './clean-shutdown-marker.js'
import { DEFAULT_MAX_AGE_MS as CLEAN_SHUTDOWN_MAX_AGE_MS } from './clean-shutdown-marker.js'
import type { SessionMarker } from './session-marker.js'

// Re-export so tests can import from a single path
export type { RestartReason }

/**
 * Operator-initiated restart-marker freshness window. Longer than the
 * default `clean-shutdown.json` window (60s) because operator-driven
 * flows — specifically `switchroom update` from the host CLI — stamp
 * the marker BEFORE `docker compose up -d --remove-orphans` runs, and
 * the recreate for a multi-agent fleet can comfortably take longer
 * than 60s to bring every container's gateway back up (9 agents ×
 * docker network/volume setup + gateway boot probes). Without this
 * extended window, my "operator: switchroom update" marker reads
 * stale by the time the late-bootstrapping agent's gateway reads it
 * — `determineRestartReason` falls through to `'crash'` and the
 * boot card renders the planned redeploy as a crash with a noisy
 * `agent-crashed` operator-events broadcast (the very pattern
 * PR #1139 set out to suppress).
 *
 * Five minutes is generous: a 50-agent fleet recreate would still
 * finish well inside it, and we still treat a 5-min-old marker as a
 * crash if the gateway eventually does come up so the longer window
 * isn't a "silent forever" mode. Verified end-to-end against a 9-agent
 * fleet on 2026-05-13: latest-recreated agent's marker age was 97s.
 *
 * Keyed on the reason-text prefix (`operator:`) so user/cli/in-gateway
 * restart paths keep their 60s tight window — those produce a much
 * shorter shutdown-to-boot delta and a 5-min window there would mask
 * a real crash during/after a `/restart`.
 */
const OPERATOR_MARKER_MAX_AGE_MS = 5 * 60_000

/**
 * Determine why this gateway is starting up.
 *
 * Priority order:
 *   1. restart-pending.json present + fresh (<5 min) → 'planned'
 *   2. clean-shutdown.json present + fresh:
 *        - default <60s → 'graceful'
 *        - reason starts with `operator:` → <5min → 'graceful' (#1141
 *          follow-up: fleet recreate can exceed 60s and still be a
 *          planned operator update)
 *   3. gateway-session.json present (prior process existed) → 'crash'
 *   4. Otherwise → 'fresh'
 */
export function determineRestartReason(opts: {
  marker: { ts: number } | null
  cleanMarker: CleanShutdownMarker | null
  sessionMarker: SessionMarker | null
  now: number
  cleanMaxAgeMs?: number
  markerMaxAgeMs?: number
  operatorMaxAgeMs?: number
}): RestartReason {
  const {
    marker,
    cleanMarker,
    sessionMarker,
    now,
    cleanMaxAgeMs = CLEAN_SHUTDOWN_MAX_AGE_MS,
    markerMaxAgeMs = 5 * 60_000,
    operatorMaxAgeMs = OPERATOR_MARKER_MAX_AGE_MS,
  } = opts
  if (marker != null && now - marker.ts < markerMaxAgeMs) return 'planned'
  if (cleanMarker != null && now - cleanMarker.ts >= 0) {
    const isOperator = typeof cleanMarker.reason === 'string'
      && cleanMarker.reason.startsWith('operator:')
    const window = isOperator ? operatorMaxAgeMs : cleanMaxAgeMs
    if (now - cleanMarker.ts < window) return 'graceful'
  }
  if (sessionMarker != null) return 'crash'
  return 'fresh'
}
