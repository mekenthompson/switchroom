/**
 * Read-only persistence for the legacy per-agent auto-fallback lockout
 * file. The lockout writer + decision logic + plan executor were retired
 * in PR #1329 (fleet-wide auto-fallback path supersedes the per-agent
 * one); this module's only remaining job is to support
 * `isAutoFallbackCooldownActive` in gateway.ts, which reads the existing
 * on-disk lockout to defer pending-restart drains while a recent
 * rotation is still settling.
 *
 * Existing on-disk lockouts (written by pre-#1329 gateways) age out via
 * `DEFAULT_FALLBACK_COOLDOWN_MS`; new lockouts are never written. Once
 * every operator has run `switchroom update` post-#1329, the file goes
 * cold and `isAutoFallbackCooldownActive` always returns false. This
 * module + the drain-cap consumer can then be retired together in a
 * follow-up.
 */

/** Minimum time between two consecutive fallback attempts for the same
 *  slot — guard against poll-storm fallback loops. Read-only since
 *  PR #1329; only consumed by `isAutoFallbackCooldownActive` to bound
 *  the drain-cap defer. */
export const DEFAULT_FALLBACK_COOLDOWN_MS = 2 * 60_000;

export type LockoutRecord = {
  /** Slot name most recently marked exhausted by the legacy writer. */
  lastTransitionedFrom: string | null;
  /** Wall-clock ms timestamp of that transition. */
  lastTransitionAt: number;
};

export interface LockoutPersistOps {
  readFileSync: (path: string, encoding: BufferEncoding) => string;
  // writeFileSync + mkdirSync stay in the interface so the gateway's
  // existing lockoutOps bundle still type-checks. They're never called
  // by this module any more (the writer was retired).
  writeFileSync: (path: string, data: string, opts: { mode?: number }) => void;
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, opts: { recursive: true }) => void;
  joinPath: (...parts: string[]) => string;
}

const LOCKOUT_FILE = "auto-fallback-lockout.json";

function emptyLockout(): LockoutRecord {
  return { lastTransitionedFrom: null, lastTransitionAt: 0 };
}

function lockoutPath(agentDir: string, joinPath: LockoutPersistOps['joinPath']): string {
  return joinPath(agentDir, '.claude', LOCKOUT_FILE);
}

export function loadLockout(agentDir: string, ops: LockoutPersistOps): LockoutRecord {
  const path = lockoutPath(agentDir, ops.joinPath);
  if (!ops.existsSync(path)) return emptyLockout();
  try {
    const raw = ops.readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      (typeof parsed.lastTransitionedFrom === 'string' ||
        parsed.lastTransitionedFrom === null) &&
      typeof parsed.lastTransitionAt === 'number' &&
      Number.isFinite(parsed.lastTransitionAt)
    ) {
      return {
        lastTransitionedFrom: parsed.lastTransitionedFrom,
        lastTransitionAt: parsed.lastTransitionAt,
      };
    }
  } catch {
    /* fall through to empty */
  }
  return emptyLockout();
}
