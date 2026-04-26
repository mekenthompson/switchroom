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
 * Determine why this gateway is starting up.
 *
 * Priority order:
 *   1. restart-pending.json present + fresh (<5 min) → 'planned'
 *   2. clean-shutdown.json present + fresh (<60s default) → 'graceful'
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
}): RestartReason {
  const {
    marker,
    cleanMarker,
    sessionMarker,
    now,
    cleanMaxAgeMs = CLEAN_SHUTDOWN_MAX_AGE_MS,
    markerMaxAgeMs = 5 * 60_000,
  } = opts
  if (marker != null && now - marker.ts < markerMaxAgeMs) return 'planned'
  if (
    cleanMarker != null &&
    now - cleanMarker.ts >= 0 &&
    now - cleanMarker.ts < cleanMaxAgeMs
  )
    return 'graceful'
  if (sessionMarker != null) return 'crash'
  return 'fresh'
}
