/**
 * analytics-posthog.ts — gateway-side PostHog client.
 *
 * Mirrors `src/analytics/posthog.ts` (the CLI's client) but sized for a
 * long-lived gateway process: default batching instead of immediate-flush.
 * Honours the same env vars (SWITCHROOM_POSTHOG_KEY, SWITCHROOM_POSTHOG_HOST,
 * SWITCHROOM_TELEMETRY_DISABLED) so an operator opt-out applies fleet-wide.
 *
 * Distinct ID lineage:
 *   1. SWITCHROOM_ANALYTICS_ID env var — set by compose.ts from the host's
 *      ~/.switchroom/analytics-id so per-agent runtime events merge with
 *      the same user's CLI events in PostHog.
 *   2. Per-agent fallback UUID at /state/agent/analytics-id when the env
 *      var is missing (e.g. legacy compose). Persists across restarts.
 *
 * Every event auto-stamps `agent` and `switchroom_version` so dashboards
 * can slice by agent without each call-site repeating the property.
 */

import { PostHog } from 'posthog-node'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const DEFAULT_KEY = 'phc_qKY87cKWZm6ZyCtk7LcRd2cU8Sg42u7Ywhui5stYCegd'
const DEFAULT_HOST = 'https://us.i.posthog.com'

let client: PostHog | null = null
let initialized = false
let cachedDistinctId: string | null = null
let globalHandlersInstalled = false

function telemetryDisabled(): boolean {
  const v = process.env.SWITCHROOM_TELEMETRY_DISABLED
  return v === '1' || v === 'true'
}

function agentName(): string {
  return process.env.SWITCHROOM_AGENT_NAME ?? 'unknown'
}

function switchroomVersion(): string {
  return process.env.SWITCHROOM_VERSION ?? 'unknown'
}

export function getDistinctId(): string {
  if (cachedDistinctId) return cachedDistinctId
  const envId = process.env.SWITCHROOM_ANALYTICS_ID
  if (envId && envId.trim() !== '') {
    cachedDistinctId = envId.trim()
    return cachedDistinctId
  }
  const fallbackPath = join(
    process.env.SWITCHROOM_RUNTIME_STATE_DIR ?? '/state/agent',
    'analytics-id',
  )
  try {
    if (existsSync(fallbackPath)) {
      const existing = readFileSync(fallbackPath, 'utf-8').trim()
      if (existing) {
        cachedDistinctId = existing
        return existing
      }
    }
  } catch {
    // fall through to fresh uuid
  }
  const id = randomUUID()
  cachedDistinctId = id
  try {
    mkdirSync(dirname(fallbackPath), { recursive: true })
    writeFileSync(fallbackPath, id, 'utf-8')
  } catch {
    // non-fatal — fresh uuid next boot is acceptable
  }
  return id
}

export function getPostHog(): PostHog | null {
  if (initialized) return client
  initialized = true
  if (telemetryDisabled()) return null
  const apiKey = process.env.SWITCHROOM_POSTHOG_KEY ?? DEFAULT_KEY
  const host = process.env.SWITCHROOM_POSTHOG_HOST ?? DEFAULT_HOST
  if (!apiKey) return null
  try {
    client = new PostHog(apiKey, {
      host,
      // Long-lived gateway: rely on default batching instead of the
      // immediate-flush the short-lived CLI uses.
      enableExceptionAutocapture: false,
      // IP is considered PII in our telemetry policy (see docs/posthog.md).
      disableGeoip: true,
    })
  } catch {
    client = null
  }
  return client
}

export async function captureEvent(
  event: string,
  properties: Record<string, unknown> = {},
): Promise<void> {
  const ph = getPostHog()
  if (!ph) return
  try {
    ph.capture({
      distinctId: getDistinctId(),
      event,
      properties: {
        agent: agentName(),
        switchroom_version: switchroomVersion(),
        source: 'gateway',
        ...properties,
      },
    })
  } catch {
    // Telemetry must never break the gateway.
  }
}

export async function captureException(
  error: unknown,
  properties: Record<string, unknown> = {},
): Promise<void> {
  const ph = getPostHog()
  if (!ph) return
  try {
    await ph.captureException(error, getDistinctId(), {
      agent: agentName(),
      switchroom_version: switchroomVersion(),
      source: 'gateway',
      ...properties,
    })
  } catch {
    // Telemetry must never break the gateway.
  }
}

export async function shutdownAnalytics(): Promise<void> {
  if (!client) return
  try {
    await client.shutdown(2000)
  } catch {
    // ignore
  }
}

/**
 * Install process-level handlers for uncaught exceptions and unhandled
 * rejections so they're reported to PostHog before the process dies.
 *
 * Mirrors the CLI's `installGlobalErrorHandlers()` so runtime errors land
 * in the same Switchroom Errors dashboard as CLI errors, tagged
 * `source: 'gateway'`.
 *
 * The gateway already exits non-zero on fatal errors (see the polling
 * IIFE at the bottom of gateway.ts). We DO NOT re-exit here for
 * unhandledRejection — Node's default is to keep running and we want
 * the gateway to keep polling. For uncaughtException we DO exit, because
 * Node's default-since-v15 is to exit anyway after listeners return.
 */
export function installGlobalErrorHandlers(): void {
  if (globalHandlersInstalled) return
  globalHandlersInstalled = true

  const FLUSH_TIMEOUT_MS = 2000

  const flushWithTimeout = async (
    error: unknown,
    kind: 'uncaughtException' | 'unhandledRejection',
  ): Promise<void> => {
    await Promise.race([
      captureException(error, { kind }),
      new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS)),
    ])
  }

  process.on('uncaughtException', (err) => {
    process.stderr.write(`telegram gateway: uncaughtException: ${err}\n`)
    void flushWithTimeout(err, 'uncaughtException').finally(() => {
      process.exit(1)
    })
  })

  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`telegram gateway: unhandledRejection: ${reason}\n`)
    void flushWithTimeout(reason, 'unhandledRejection')
  })
}
