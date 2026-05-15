/**
 * Adapt the RFC H broker `auth show --json` / `auth list --json` payload
 * (a `ListStateData`) into the per-agent `AuthSummary` shape the
 * /status panel renders via `formatAuthLine`.
 *
 * Pre-RFC-H, gateway shelled out to `switchroom auth status --json`
 * which already returned per-agent records in `AuthSummary` shape.
 * That verb was retired; this adapter does the per-agent projection
 * over the new fleet-broker payload.
 *
 * Pure & dependency-free so it can be unit-tested without a grammy
 * Context or live broker.
 */
import type { AuthSummary } from '../welcome-text.js'

/** Mirrors `ListStateData` in src/auth/broker/client.ts — duplicated as
 *  a structural type so this adapter stays in the telegram-plugin
 *  workspace without importing across the src/ boundary. */
export interface BrokerStateView {
  active: string
  fallback_order: string[]
  accounts: Array<{
    label: string
    expiresAt?: number
    exhausted: boolean
  }>
  agents: Array<{
    name: string
    account: string
    override: string | null
  }>
}

/** Subset of `.claude.json` we need for billingType — duplicated for
 *  the same reason as BrokerStateView. */
export interface ClaudeJsonView {
  oauthAccount?: {
    billingType?: string
  }
}

export function formatExpiresInRelative(expiresAt: number | undefined, now: number = Date.now()): string | null {
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null
  const delta = expiresAt - now
  if (delta <= 0) return 'expired'
  const days = Math.floor(delta / 86_400_000)
  if (days >= 1) return `in ${days} day${days === 1 ? '' : 's'}`
  const hours = Math.floor(delta / 3_600_000)
  if (hours >= 1) return `in ${hours} hour${hours === 1 ? '' : 's'}`
  const minutes = Math.max(1, Math.floor(delta / 60_000))
  return `in ${minutes} minute${minutes === 1 ? '' : 's'}`
}

function mapBillingTypeToPlan(billingType: string | undefined): string | null {
  if (!billingType) return null
  const t = billingType.toLowerCase()
  if (t.includes('max')) return 'Max'
  if (t.includes('pro')) return 'Pro'
  return billingType
}

/**
 * Build the per-agent AuthSummary from broker state.
 *
 * - `authenticated` = the agent is bound to an account that the broker
 *   knows about. Quota exhaustion is NOT counted as unauthenticated —
 *   the agent still has valid credentials, it just can't make calls
 *   until the broker rotates (which is a separate signal).
 * - `auth_source` surfaces the bound account label (e.g. the email).
 *   Under RFC H all auth flows through the broker, so the source is
 *   "which account is currently mirrored to this agent", not the
 *   transport.
 * - `subscription_type` is read from the agent's `.claude.json`
 *   because the broker doesn't track plan tier.
 * - `expires_in` is computed from the bound account's `expiresAt`.
 */
export function buildAuthSummaryFromBroker(
  state: BrokerStateView | null | undefined,
  agentName: string,
  claudeJson: ClaudeJsonView | null | undefined,
  now: number = Date.now(),
): AuthSummary | null {
  if (!state) return null
  const binding = state.agents.find((a) => a.name === agentName)
  if (!binding) {
    return {
      authenticated: false,
      subscription_type: mapBillingTypeToPlan(claudeJson?.oauthAccount?.billingType),
      expires_in: null,
      auth_source: null,
    }
  }
  const account = state.accounts.find((a) => a.label === binding.account)
  const authenticated = account !== undefined
  return {
    authenticated,
    subscription_type: mapBillingTypeToPlan(claudeJson?.oauthAccount?.billingType),
    expires_in: account ? formatExpiresInRelative(account.expiresAt, now) : null,
    auth_source: binding.account,
  }
}
