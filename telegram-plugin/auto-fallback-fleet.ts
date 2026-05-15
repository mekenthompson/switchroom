/**
 * Fleet-wide auto-fallback (RFC H — successor to the per-agent
 * `performAutoFallback` in `auto-fallback.ts`).
 *
 * Why this exists alongside the legacy per-agent path:
 *
 *   The pre-#XYZ auto-fallback called `fallbackToNextSlot(agentDir)`,
 *   which writes the new active slot to ONE agent's local
 *   `.claude/credentials.json`. That left the rest of the fleet still
 *   pointing at the just-exhausted account — which would then hit the
 *   wall on its own next call, surfacing N separate "Model unavailable"
 *   cards for the same root cause.
 *
 *   Manual `/auth use <label>` already takes the fleet-wide path
 *   (broker.setActive → fan-out to all per-agent credential mirrors).
 *   Auto-fallback now uses the same path so scope is consistent and
 *   one quota event resolves the whole fleet in one swap.
 *
 * What this module does:
 *
 *   1. Probe live quota for every account in parallel
 *      (`fetchAccountQuota({force: true})`) so we pick the best
 *      target with current data, not stale broker disk-cache.
 *   2. Skip blocked accounts entirely; pick the lowest-utilization
 *      healthy candidate (or, if none, the lowest throttling one).
 *   3. Call `client.setActive(target)` — same broker verb /auth use
 *      uses. Broker re-mirrors creds to all agents.
 *   4. Render the causal-shape announcement
 *      (`renderFallbackAnnouncement`) with the OLD account's binding
 *      window in the headline (5-hour vs 7-day) and the new
 *      account's headroom in the body.
 *
 * Pure-data return shape — caller does the actual Telegram send +
 * lockout-record bookkeeping, mirroring the legacy module's contract.
 */

import type { QuotaResult, QuotaUtilization } from './quota-check.js';
import type { ListStateData } from '../src/auth/broker/client.js';
import {
  renderFallbackAnnouncement,
  classifyHealth,
  buildSnapshotsFromState,
  type AccountSnapshot,
} from './auth-snapshot-format.js';

export type FleetFallbackOutcome =
  | {
      kind: 'switched';
      oldLabel: string;
      newLabel: string;
      announcement: string;
      /** Quota for the OLD account at the moment of failure — caller
       *  may persist this as the broker's `quota.json` so the next
       *  /auth render reflects the freshly-known exhaustion without
       *  another probe. */
      oldQuota: QuotaUtilization;
      /** Quota for the new active account, useful for caller logging. */
      newQuota: QuotaUtilization;
    }
  | {
      kind: 'all-blocked';
      oldLabel: string;
      announcement: string;
      oldQuota: QuotaUtilization | null;
    }
  | {
      kind: 'no-old-active';
      announcement: string;
    }
  | {
      kind: 'no-eligible-target';
      oldLabel: string;
      announcement: string;
      oldQuota: QuotaUtilization | null;
    };

export interface FleetFallbackDeps {
  /** Live broker state. Caller passes pre-fetched data so this module
   *  is testable without spinning up a UDS. */
  state: ListStateData;
  /** Parallel array of live quota probes, same order as `state.accounts`.
   *  Use `Promise.all(state.accounts.map(a =>
   *  fetchAccountQuota(a.label, {force: true})))`. */
  quotas: QuotaResult[];
  /** Broker `setActive` invoker. Returns the result for logging. */
  setActive: (label: string) => Promise<{ active: string; fanned: string[] }>;
  /** Agent that triggered this fallback (for the announcement byline). */
  triggerAgent: string;
  /** Operator timezone for absolute reset times in the announcement. */
  tz?: string;
  now?: Date;
}

/**
 * Plan + execute the fleet-wide swap. Returns a structured outcome the
 * caller can both log and notify on.
 *
 * Idempotency: when the active account is already healthy (a stale
 * model-unavailable event arrives after the quota window already
 * rolled over, for example), we DO NOT swap. Returns
 * `'no-eligible-target'` so the caller silently no-ops the
 * announcement.
 */
export async function runFleetAutoFallback(
  deps: FleetFallbackDeps,
): Promise<FleetFallbackOutcome> {
  const now = deps.now ?? new Date();
  const tz = deps.tz ?? 'UTC';
  const snapshots = buildSnapshotsFromState(deps.state, deps.quotas);

  const oldSnap = snapshots.find((s) => s.isActive);
  if (!oldSnap) {
    return {
      kind: 'no-old-active',
      announcement: '<i>Auto-fallback skipped: no active account in broker state.</i>',
    };
  }

  // Idempotency guard: don't swap a healthy active account, even if
  // the trigger event said quota_exhausted. The event may be stale
  // (event posted, window rolled over, gateway picked it up late).
  const oldHealth = classifyHealth(oldSnap);
  if (oldHealth === 'healthy') {
    return {
      kind: 'no-eligible-target',
      oldLabel: oldSnap.label,
      oldQuota: oldSnap.quota,
      announcement:
        `<i>Auto-fallback skipped: ${oldSnap.label} probed healthy ` +
        `(${pctSummary(oldSnap.quota)}). Stale event?</i>`,
    };
  }

  const target = pickFallbackTarget(snapshots);
  if (!target) {
    // All-blocked path: no eligible target. Still notify the user with
    // earliest-reset info via the announcement formatter.
    return {
      kind: 'all-blocked',
      oldLabel: oldSnap.label,
      oldQuota: oldSnap.quota,
      announcement: renderFallbackAnnouncement({
        oldLabel: oldSnap.label,
        oldQuota: oldSnap.quota,
        newLabel: null,
        newQuota: null,
        triggerAgent: deps.triggerAgent,
        tz,
        now,
      }),
    };
  }

  // Execute the broker swap. Caller catches and surfaces the failure
  // — we don't double-wrap.
  await deps.setActive(target.label);

  return {
    kind: 'switched',
    oldLabel: oldSnap.label,
    newLabel: target.label,
    oldQuota: oldSnap.quota!, // non-null: only `unknown` health gets here through
    // the no-target branch, never the switched one
    newQuota: target.quota!,
    announcement: renderFallbackAnnouncement({
      oldLabel: oldSnap.label,
      oldQuota: oldSnap.quota,
      newLabel: target.label,
      newQuota: target.quota,
      triggerAgent: deps.triggerAgent,
      tz,
      now,
    }),
  };
}

/**
 * Pick the best non-active fallback target. Selection order:
 *   1. Healthy accounts, sorted by lowest 5h utilization (most
 *      runway).
 *   2. If no healthy alternative, throttling accounts sorted by
 *      lowest binding-window utilization (least worst).
 *   3. Skip blocked + unknown entirely — never recommend a switch
 *      into a wall, never bet on creds we couldn't probe.
 *
 * Returns null when no eligible target exists.
 */
export function pickFallbackTarget(
  snapshots: AccountSnapshot[],
): AccountSnapshot | null {
  const candidates = snapshots
    .filter((s) => !s.isActive && s.quota != null)
    .map((s) => ({ snap: s, health: classifyHealth(s) }));

  const healthy = candidates
    .filter((c) => c.health === 'healthy')
    .sort((a, b) => a.snap.quota!.fiveHourUtilizationPct - b.snap.quota!.fiveHourUtilizationPct);
  if (healthy.length > 0) return healthy[0]!.snap;

  const throttling = candidates
    .filter((c) => c.health === 'throttling')
    .sort((a, b) => maxWindow(a.snap.quota!) - maxWindow(b.snap.quota!));
  if (throttling.length > 0) return throttling[0]!.snap;

  return null;
}

function maxWindow(q: QuotaUtilization): number {
  return Math.max(q.fiveHourUtilizationPct, q.sevenDayUtilizationPct);
}

function pctSummary(q: QuotaUtilization | null): string {
  if (!q) return 'no probe';
  return `${Math.round(q.fiveHourUtilizationPct)}% / ${Math.round(q.sevenDayUtilizationPct)}%`;
}
