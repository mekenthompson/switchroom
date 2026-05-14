/**
 * Reconciler driver loop — RFC E §4.4 follow-up.
 *
 * Walks granted Drive scopes for an agent (or the whole fleet), calls
 * Drive's `files.get` for each, reconciles the response against the
 * grant's last-seen snapshot, and fires the three recovery side-effects
 * (audit row + staleness-digest line + chat nudge) when a grant flips
 * from missing back to present.
 *
 * Composed of pure logic + four injected sink/source functions. The
 * tick host (auth-broker singleton, agent container, or wherever the
 * follow-up wiring lands) wires concrete implementations. This keeps
 * the loop kernel-agnostic and unit-testable without docker / Google
 * / SQLite in the loop.
 *
 *   listDriveGrants → enumerate the (agent, scope, action, last_verdict)
 *                     tuples the tick should consider.
 *   fetchDriveMeta → call Drive `files.get` for a scope; return null on
 *                    404 / trashed (the reconciler treats both as missing).
 *   saveVerdict   → persist the freshly-computed verdict so the next
 *                   tick has a `last_verdict` to diff against.
 *   writeAuditRow → append the `recover` row to approval_audit via the
 *                   kernel's existing audit-write path.
 *   postChatNudge → post the "↻ '<title>' is back" nudge into the
 *                   agent's Telegram topic via the gateway.
 *
 * Failure model: each grant is reconciled independently; one failure
 * doesn't poison the rest of the tick. The result-summary returned
 * to the caller tracks per-category counts for the operator log.
 */

import {
  parseDriveScope,
} from "./deep-links.js";
import { buildRecoveryArtifacts } from "./recovery.js";
import {
  detectRecovery,
  reconcile,
  type DriveFileMetadata,
  type LastSeenSnapshot,
  type ReconcilerVerdict,
} from "./reconciler.js";
import type { RecoveryAuditRow } from "./recovery.js";

// ────────────────────────────────────────────────────────────────────────
// Injected interfaces
// ────────────────────────────────────────────────────────────────────────

/**
 * One grant the tick should reconcile. The tick host queries the
 * kernel's approval_decisions table for `doc:gdrive:` scopes and
 * yields one of these per row. `last_verdict` may be null on the
 * first-ever reconciliation for the grant.
 */
export interface DriveGrant {
  agent_unit: string;
  /** Kernel scope string, e.g. `doc:gdrive:D1` or `doc:gdrive:folder/F1/**`. */
  scope: string;
  /** action_grammar — "read" / "suggest" / "write". */
  action: string;
  /** Verdict from the prior tick. Null = first reconciliation. */
  last_verdict: ReconcilerVerdict | null;
  /**
   * Drive-side last-seen snapshot — what the kernel stored after the
   * last successful access. Fed into the reconciler so a content-hash
   * or modifiedTime divergence shows up as a conflict.
   */
  last_seen: LastSeenSnapshot | null;
}

export interface ReconcilerDriverDeps {
  /**
   * Yields every Drive grant the tick should reconcile this pass.
   * Implementations typically read approval_decisions + filter to
   * Drive scope shapes. May yield grants for many agents — the
   * driver doesn't restrict by agent (callers that want a single
   * agent's tick filter at this seam).
   */
  listDriveGrants: () => AsyncIterable<DriveGrant> | Iterable<DriveGrant>;

  /**
   * Call Drive `files.get` for `grant.scope`. Returns null when
   * Drive responds 404 OR `trashed=true`. The reconciler treats
   * both as `state: missing`. Throws on auth failure (caller
   * surfaces the disconnect via the existing invalid_grant flow).
   *
   * For folder scopes (`doc:gdrive:folder/<id>/**`), `files.get`
   * targets the folder id itself — recovery semantics are "is the
   * folder still there", not "do all its descendants exist".
   */
  fetchDriveMeta: (
    grant: DriveGrant,
  ) => Promise<DriveFileMetadata | null>;

  /**
   * Persist the freshly-computed verdict + the metadata snapshot
   * the next tick should diff against. Implementations write to
   * the kernel's approval_decisions metadata column (or a sidecar
   * table; the schema is the host's decision).
   */
  saveVerdict: (args: {
    grant: DriveGrant;
    verdict: ReconcilerVerdict;
    snapshot: LastSeenSnapshot;
  }) => Promise<void>;

  /**
   * Append a `recover` row to approval_audit. Implementations call
   * into the kernel's audit-write path.
   */
  writeAuditRow: (row: RecoveryAuditRow) => Promise<void>;

  /**
   * Post the chat nudge in the agent's Telegram topic. Failure
   * here is logged but not fatal — the audit row is the
   * source-of-truth, the nudge is best-effort UX.
   */
  postChatNudge: (args: { agent_unit: string; text: string }) => Promise<void>;

  /**
   * Operator log sink. Called once per scanned grant with the
   * outcome — feeds the standard broker log.
   */
  log?: (msg: string) => void;
}

// ────────────────────────────────────────────────────────────────────────
// Result summary
// ────────────────────────────────────────────────────────────────────────

export interface ReconcilerTickResult {
  /** Total grants the iterator yielded. */
  scanned: number;
  /** Grants the driver skipped because the scope didn't parse as Drive. */
  skipped: number;
  /** Recovery events fired (audit row written + nudge attempted). */
  recoveries: number;
  /** Per-grant failures (fetch + reconcile + save) — none fatal. */
  errors: number;
}

// ────────────────────────────────────────────────────────────────────────
// Driver
// ────────────────────────────────────────────────────────────────────────

/**
 * Run one reconciler tick across every Drive grant `deps.listDriveGrants`
 * yields. Side-effects:
 *
 *   - Always: persist the fresh verdict via `saveVerdict` so the next
 *     tick has a `last_verdict` baseline.
 *   - On missing→present (or missing→conflict) transitions: build the
 *     three recovery artifacts via `buildRecoveryArtifacts` (C1) and
 *     fan them through `writeAuditRow` + `postChatNudge`.
 *
 * Returns a summary suitable for the operator log.
 *
 * Failure isolation: each grant is wrapped in its own try/catch. A
 * fetchDriveMeta throw on grant N doesn't prevent grants N+1..M from
 * reconciling. saveVerdict failures are logged but don't block the
 * audit/nudge for an in-flight recovery — better to surface the
 * recovery to the user (audit + nudge) and let the next tick re-save
 * than to silently swallow it.
 */
export async function runReconcilerTick(
  deps: ReconcilerDriverDeps,
): Promise<ReconcilerTickResult> {
  const result: ReconcilerTickResult = {
    scanned: 0,
    skipped: 0,
    recoveries: 0,
    errors: 0,
  };

  try {
   for await (const grant of normaliseIterable(deps.listDriveGrants())) {
    result.scanned += 1;
    try {
      // Defense in depth — only act on scopes we can parse. A
      // non-Drive scope row leaking into the listDriveGrants
      // implementation gets skipped harmlessly.
      if (parseDriveScope(grant.scope) === null) {
        result.skipped += 1;
        continue;
      }

      let remoteMeta: DriveFileMetadata | null;
      try {
        remoteMeta = await deps.fetchDriveMeta(grant);
      } catch (err) {
        result.errors += 1;
        deps.log?.(
          `reconciler-tick ${grant.agent_unit} ${grant.scope}: fetch failed — ${describe(err)}`,
        );
        continue;
      }

      const verdict = reconcile(remoteMeta, grant.last_seen);

      // Snapshot is what the NEXT tick will diff against. For
      // present/conflict we capture the freshly-fetched fields;
      // for missing we keep the prior snapshot so a transient
      // 404 doesn't reset the comparison baseline on next recovery.
      //
      // First-ever observation of a missing scope falls through to
      // `{}` (empty snapshot) rather than `null` — the next
      // recovery's `reconcile()` treats `{}` as "all fields
      // undefined → no conflict reasons", which produces a clean
      // present-state recovery once Drive returns the file. `null`
      // would short-circuit reconcile() to present early, but the
      // {} path is more honest about "we've never seen real
      // metadata for this scope" and arrives at the same final
      // state.
      const snapshot: LastSeenSnapshot =
        remoteMeta !== null
          ? {
              modifiedTime: remoteMeta.modifiedTime,
              contentHash: remoteMeta.contentHash,
              mimeType: remoteMeta.mimeType,
            }
          : grant.last_seen ?? {};

      // Detect recovery BEFORE saving — `last_verdict` reflects the
      // prior tick's state.
      const recovery = detectRecovery(grant.last_verdict, verdict);

      if (recovery.recovered) {
        const artifacts = buildRecoveryArtifacts({
          event: recovery,
          agent_unit: grant.agent_unit,
          scope: grant.scope,
          action: grant.action,
        });
        try {
          await deps.writeAuditRow(artifacts.auditRow);
        } catch (err) {
          result.errors += 1;
          deps.log?.(
            `reconciler-tick ${grant.agent_unit} ${grant.scope}: audit-write failed — ${describe(err)}`,
          );
          // Continue — the nudge is still valuable even without
          // audit. RFC §4.4 frames the audit as the source-of-truth
          // for post-hoc review; here we trade that strictness for
          // user-visible recovery. The next tick will re-fire the
          // recovery (since last_verdict stays at "missing" if the
          // save below also fails) and Drive's revision history is
          // the operator's external escape hatch if the audit row
          // never lands.
        }
        try {
          await deps.postChatNudge({
            agent_unit: grant.agent_unit,
            text: artifacts.nudge,
          });
        } catch (err) {
          // Best-effort by design — audit row is the source of truth.
          deps.log?.(
            `reconciler-tick ${grant.agent_unit} ${grant.scope}: nudge failed (audit row stands) — ${describe(err)}`,
          );
        }
        result.recoveries += 1;
        deps.log?.(
          `reconciler-tick ${grant.agent_unit} ${grant.scope}: recovered (${recovery.fromReason} → ${recovery.toState})`,
        );
      }

      try {
        await deps.saveVerdict({ grant, verdict, snapshot });
      } catch (err) {
        // Save failure on a recovered grant is the worst case — the
        // next tick will re-fire the recovery. Better than silent
        // swallow; the operator log makes it visible.
        result.errors += 1;
        deps.log?.(
          `reconciler-tick ${grant.agent_unit} ${grant.scope}: save-verdict failed — ${describe(err)}`,
        );
      }
    } catch (err) {
      // Last-resort catch — keeps the tick going.
      result.errors += 1;
      deps.log?.(
        `reconciler-tick ${grant.agent_unit} ${grant.scope}: unexpected error — ${describe(err)}`,
      );
    }
   }
  } catch (err) {
    // The grant iterator itself threw (SQLite blip mid-streaming,
    // a generator throwing, etc). Failure isolation is per-grant
    // by design, but a source-level failure shouldn't leave the
    // tick silently dead from the operator's view — count it and
    // surface in the summary log.
    result.errors += 1;
    deps.log?.(
      `reconciler-tick iterator-source threw — ${describe(err)} (partial result: scanned=${result.scanned} recoveries=${result.recoveries})`,
    );
  }

  deps.log?.(
    `reconciler-tick done — scanned=${result.scanned} skipped=${result.skipped} recoveries=${result.recoveries} errors=${result.errors}`,
  );
  return result;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

async function* normaliseIterable<T>(
  src: AsyncIterable<T> | Iterable<T>,
): AsyncIterable<T> {
  if (isAsyncIterable(src)) {
    for await (const x of src) yield x;
    return;
  }
  for (const x of src) yield x;
}

function isAsyncIterable<T>(x: unknown): x is AsyncIterable<T> {
  return (
    x !== null &&
    typeof x === "object" &&
    typeof (x as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
  );
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
