/**
 * Pidfile-based lock for the in-agent scheduler. Belt-and-braces dedup
 * — start.sh's `_switchroom_supervise` wrapper is structurally
 * single-instance (it only respawns AFTER the previous process exits),
 * so the lock is a safety net against an operator launching a second
 * `bun /opt/switchroom/agent-scheduler/index.js` by hand.
 *
 * Why pidfile instead of flock(2):
 *   - Node's stdlib has no portable flock binding. Going through a
 *     native module (or fork-and-flock) for one safety check inflates
 *     blast radius.
 *   - The agent-scheduler always runs in a Linux container with a
 *     local writable /state/agent — pidfile-with-liveness-check
 *     covers every realistic failure mode (stale lock from a previous
 *     hard kill, double-supervisor accident).
 *
 * The acquire flow uses O_CREAT|O_EXCL to make the create atomic. On
 * EEXIST we read the holder PID and probe with `kill(pid, 0)`:
 *   - process is alive → exit; the supervised parent will not respawn
 *     a second instance because we exit non-zero with a stable code.
 *   - process is dead → stale lock; remove and retry once.
 *
 * Lifecycle: caller invokes `acquire(path)` at startup; on graceful
 * shutdown calls `release(path)`. Hard kill (SIGKILL) leaves the
 * pidfile behind, but the next start's stale-PID detection clears it.
 */

import {
  closeSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
  mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

export interface LockResult {
  /** True when the caller now holds the lock. */
  acquired: boolean;
  /** When `acquired === false`, the live PID currently holding it. */
  holderPid?: number;
}

/**
 * Try to acquire the lockfile. Returns `{acquired: true}` on success.
 * On contention, returns `{acquired: false, holderPid}` — the caller
 * decides whether to exit or wait. The standard switchroom pattern is
 * "exit with EX_TEMPFAIL (75)" so the supervisor's restart-cap kicks
 * in instead of tight-looping.
 *
 * One stale-lock retry is built in: if the existing pidfile points at
 * a process that's no longer alive, the lock is removed and we try
 * once more. After that, we report contention (defensive — should
 * never happen in practice, but the loop is bounded).
 */
export function acquireLock(
  path: string,
  pid: number = process.pid,
): LockResult {
  // mkdir -p the parent so a fresh /state/agent doesn't trip us up.
  try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); } catch {
    // mkdir failures are surfaced by the open() that follows.
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeSync(fd, String(pid));
      } finally {
        closeSync(fd);
      }
      return { acquired: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    // EEXIST — read the holder PID and probe.
    let holderPid: number | undefined;
    try {
      const raw = readFileSync(path, "utf8").trim();
      const parsed = Number.parseInt(raw, 10);
      if (Number.isInteger(parsed) && parsed > 0) holderPid = parsed;
    } catch {
      // Unreadable pidfile is nonsense; remove and retry.
      try { unlinkSync(path); } catch { /* nothing to do */ }
      continue;
    }
    if (holderPid === undefined) {
      try { unlinkSync(path); } catch { /* nothing to do */ }
      continue;
    }
    // signal 0 = liveness probe (no signal sent, only checks
    // existence + permission to send). ESRCH = no such pid.
    try {
      process.kill(holderPid, 0);
      return { acquired: false, holderPid };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") {
        // Stale — remove and try the create one more time.
        try { unlinkSync(path); } catch { /* nothing to do */ }
        continue;
      }
      // EPERM means the PID exists but we can't signal it (different
      // user). Treat as held — refusing is safer than colliding.
      return { acquired: false, holderPid };
    }
  }
  return { acquired: false };
}

/**
 * Best-effort lock release. Idempotent: missing pidfile is fine.
 * The caller is responsible for not removing a pidfile they don't
 * own (we don't double-check the PID inside on release because the
 * only legitimate caller is the same process that acquired it).
 */
export function releaseLock(path: string): void {
  try { unlinkSync(path); } catch { /* nothing to do */ }
}
