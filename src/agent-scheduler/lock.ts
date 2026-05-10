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
 *
 * Known limitation — PID reuse across container restarts. The lockfile
 * lives on the bind-mounted /state/agent path so it survives a hard
 * container kill. Inside an agent container PID density is low (tini=1,
 * supervised siblings in single digits), so after SIGKILL leaves a
 * pidfile pointing at, say, PID 23, the new container generation may
 * have a sibling at PID 23 — `kill(23, 0)` succeeds, the new
 * agent-scheduler exits with EX_TEMPFAIL, and the supervisor restarts
 * it until something inside the container churns enough to free that
 * PID. Bounded by the supervisor's restart-cap (10 in 60s), after
 * which the supervisor gives up — and because the singleton has been
 * filtered to skip this agent (mutual exclusion), cron tasks for it
 * stop firing from EITHER path until the operator intervenes (e.g.
 * `switchroom agent restart <name>` once, which clears the in-memory
 * supervisor state).
 *
 * Boot-time freshness defence (#895): on EEXIST we ALSO compare the
 * lockfile's mtime against this container's PID-1 start time (read
 * from /proc/1/stat field 22 + /proc/stat btime). A pidfile whose
 * mtime predates this container generation is stale regardless of
 * what `kill(pid, 0)` says — the live PID is a coincident reuse, not
 * the original holder. Without this check a SIGKILL'd lock can wedge
 * the supervisor through 10 restart cycles before it gives up, and
 * since Phase 4 (#893) deleted the singleton scheduler that path is
 * the only delivery channel for cron.
 */

import {
  closeSync,
  openSync,
  readFileSync,
  statSync,
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

export interface AcquireLockOptions {
  /**
   * Container PID-1 start time in ms-since-epoch. When set, a
   * lockfile whose mtime predates this is treated as stale (defends
   * against PID reuse across container restarts — see #895). Defaults
   * to `readContainerBootTimeMs()`. Pass `null` to disable the check
   * (e.g. tests outside a container, or non-Linux deployments).
   */
  containerBootTimeMs?: number | null;
}

/**
 * Compute when this container's PID 1 started (ms since epoch). Reads
 * `/proc/1/stat` field 22 (starttime in clock ticks since system boot)
 * + `/proc/stat` btime (system boot in seconds since epoch). Returns
 * null when /proc is unavailable or fields don't parse — caller skips
 * the freshness check rather than fail open.
 */
export function readContainerBootTimeMs(): number | null {
  try {
    // /proc/1/stat layout: pid (comm) state ppid ... where (comm) can
    // contain spaces and parens. Split AFTER the last ')' so the comm
    // doesn't poison field indexes.
    const stat1 = readFileSync("/proc/1/stat", "utf8");
    const lastParen = stat1.lastIndexOf(")");
    if (lastParen < 0) return null;
    const after = stat1.slice(lastParen + 1).trim().split(/\s+/);
    // Field 22 = starttime (clock ticks since system boot). State is
    // field 3 (index 0 of the post-comm split), so field 22 maps to
    // index 19.
    const starttimeTicks = Number(after[19]);
    if (!Number.isFinite(starttimeTicks)) return null;

    const procStat = readFileSync("/proc/stat", "utf8");
    const btimeLine = procStat.split("\n").find((l) => l.startsWith("btime "));
    if (!btimeLine) return null;
    const btimeSec = Number(btimeLine.split(/\s+/)[1]);
    if (!Number.isFinite(btimeSec)) return null;

    // /proc/[pid]/stat's starttime is in units of sysconf(_SC_CLK_TCK)
    // = USER_HZ, which the kernel ABI hardcodes to 100 on every arch
    // switchroom plausibly ships to (x86/x86_64/arm/arm64/mips — see
    // include/uapi/asm-generic/param.h; only Alpha differs). nsec_to_
    // clock_t() converts to USER_HZ before exposing starttime, so this
    // is independent of CONFIG_HZ (which DOES vary — 250 on Debian
    // server, 1000 on Ubuntu desktop). Hardcoding 100 is correct, not
    // a heuristic; the 2s safety margin in acquireLock covers
    // mtime-vs-/proc clock skew, NOT a wrong CLK_TCK.
    const CLK_TCK = 100;
    return (btimeSec + starttimeTicks / CLK_TCK) * 1000;
  } catch {
    return null;
  }
}

/**
 * Conservative margin for CLK_TCK uncertainty + clock skew between
 * /proc and the lockfile's filesystem mtime. A lock written within
 * ~2s of boot is treated as fresh either way.
 */
const FRESHNESS_MARGIN_MS = 2000;

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
  options: AcquireLockOptions = {},
): LockResult {
  const bootTimeMs = "containerBootTimeMs" in options
    ? options.containerBootTimeMs
    : readContainerBootTimeMs();

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
    // EEXIST — first check freshness vs container boot time (#895),
    // THEN probe PID liveness. Boot-time precedes liveness because
    // PID reuse across container generations can make a stale lock
    // look live (low PID density inside a container — tini=1, single-
    // digit siblings).
    if (bootTimeMs != null) {
      try {
        const lockMtime = statSync(path).mtimeMs;
        if (lockMtime < bootTimeMs - FRESHNESS_MARGIN_MS) {
          try { unlinkSync(path); } catch { /* nothing to do */ }
          continue;
        }
      } catch {
        // statSync race (file disappeared between EEXIST and stat) —
        // fall through; the next openSync will recover.
      }
    }
    // Read the holder PID and probe with kill(pid, 0).
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
