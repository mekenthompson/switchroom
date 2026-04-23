/**
 * Startup mutex for the telegram gateway — atomic single-writer guarantee
 * on the per-agent PID file.
 *
 * Why this exists (2026-04-23 incident):
 * --------------------------------------
 * Two pollers can race on Telegram's getUpdates long-poll. When the OLD
 * gateway hasn't fully released its long-poll TCP connection before the
 * NEW gateway boots, the new one gets `409: Conflict: terminated by other
 * getUpdates request`. The gateway then enters an exponential-backoff
 * retry loop. Earlier today we saw the OLD clerk-gateway looping on retry
 * attempt 13 with 10–12s backoffs — i.e. two gateway processes alive at
 * the same time, both polling.
 *
 * The PRs #45–#50 stack added a PID-file probe and a SIGTERM marker but
 * did NOT add a real startup mutex. This module closes that gap.
 *
 * Algorithm (POSIX-portable, no fcntl):
 *   1. Write our record to a uniquely-named tmp file (pid + nanoseconds).
 *   2. fs.link(tmp, canonical) — atomic on every POSIX filesystem.
 *      - If link succeeds: we hold the lock. Unlink the tmp.
 *      - If link fails with EEXIST: another holder. Read the existing
 *        file, check whether the recorded PID is still alive
 *        (process.kill(pid, 0)). If alive → blocked. If dead → unlink
 *        the stale canonical and retry the link once.
 *
 * Releases happen on shutdown (SIGTERM/SIGINT/uncaught error) by
 * unlinking the canonical path. We log every state transition; do NOT
 * silently swallow filesystem errors.
 */
import {
  link as linkAsync,
  unlink as unlinkAsync,
  writeFile as writeFileAsync,
  readFile as readFileAsync,
} from "node:fs/promises";

export interface MutexRecord {
  pid: number;
  startedAtMs: number;
}

export type AcquireOutcome =
  | {
      status: "acquired";
      record: MutexRecord;
      /** True if a stale prior record was cleaned up before acquiring. */
      recoveredFrom?: MutexRecord;
    }
  | {
      status: "blocked";
      holder: MutexRecord;
      holderAgeSec: number;
    };

export interface AcquireOptions {
  /** Canonical path of the lock file (e.g. .../telegram/gateway.pid.json). */
  path: string;
  /** Record we'll try to write. */
  record: MutexRecord;
  /**
   * PID liveness probe. Defaults to process.kill(pid, 0) semantics.
   * Injectable so tests can simulate dead/alive PIDs without forking.
   */
  isPidAlive?: (pid: number) => boolean;
  /**
   * Logger. Defaults to process.stderr.write. Lines are pre-formatted
   * with the `telegram gateway:` prefix to match journalctl style.
   */
  log?: (line: string) => void;
  /**
   * Agent name to include in log lines for journalctl filtering.
   */
  agentName?: string;
}

const DEFAULT_LOG = (line: string): void => {
  process.stderr.write(line.endsWith("\n") ? line : line + "\n");
};

const DEFAULT_IS_ALIVE = (pid: number): boolean => {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means the process exists but we can't signal it (different
    // user). Treat as alive — we'd rather block than collide with an
    // unkillable holder.
    if (code === "EPERM") return true;
    return false;
  }
};

function fmtAgent(agentName: string | undefined): string {
  return agentName ? ` agent=${agentName}` : "";
}

function tmpPath(canonical: string, pid: number): string {
  // hrtime.bigint() guarantees uniqueness even under same-millisecond
  // double-boot races (which is exactly what we're defending against).
  return `${canonical}.tmp-${pid}-${process.hrtime.bigint().toString(36)}`;
}

async function tryReadRecord(path: string): Promise<MutexRecord | null> {
  try {
    const raw = await readFileAsync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<MutexRecord>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.startedAtMs === "number" &&
      Number.isFinite(parsed.pid) &&
      Number.isFinite(parsed.startedAtMs)
    ) {
      return { pid: parsed.pid, startedAtMs: parsed.startedAtMs };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomically attempt to acquire the lock. Resolves with either
 * `acquired` (we own the file now) or `blocked` (a live holder exists).
 *
 * Throws only on unrecoverable filesystem errors (ENOSPC, EROFS, EACCES
 * on a directory that should be writable). The caller MUST treat thrown
 * errors as fatal — the gateway should exit non-zero so systemd can
 * apply its restart-burst backoff.
 */
export async function acquireStartupLock(
  opts: AcquireOptions,
): Promise<AcquireOutcome> {
  const log = opts.log ?? DEFAULT_LOG;
  const isAlive = opts.isPidAlive ?? DEFAULT_IS_ALIVE;
  const { path, record, agentName } = opts;
  const agentTag = fmtAgent(agentName);

  const tmp = tmpPath(path, record.pid);
  const payload = JSON.stringify(record);

  // Write the tmp file first. If this throws, the canonical isn't
  // touched — caller can retry on a fresh boot.
  await writeFileAsync(tmp, payload, { encoding: "utf-8", mode: 0o600 });

  let recoveredFrom: MutexRecord | undefined;

  // Try the atomic link. ONE retry after stale-recovery; we don't loop
  // forever — if the second link also fails EEXIST we treat as blocked
  // (something else won the race in the gap, and that something else is
  // now the legitimate holder).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await linkAsync(tmp, path);
      // Won the race. Drop the tmp; canonical is the live lock now.
      await unlinkAsync(tmp).catch(() => {
        /* tmp cleanup is best-effort */
      });
      log(
        `telegram gateway: boot.lock_acquired pid=${record.pid} started_at=${new Date(
          record.startedAtMs,
        ).toISOString()}${agentTag}`,
      );
      return recoveredFrom
        ? { status: "acquired", record, recoveredFrom }
        : { status: "acquired", record };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // Unrecoverable. Clean up tmp before propagating.
        await unlinkAsync(tmp).catch(() => {});
        throw err;
      }

      // EEXIST → inspect holder.
      const holder = await tryReadRecord(path);
      if (holder == null) {
        // File exists but unreadable / corrupt. Treat as stale and
        // unlink it. (Better than blocking forever on a garbage file.)
        log(
          `telegram gateway: boot.lock_corrupt_recovered path=${path}${agentTag}`,
        );
        await unlinkAsync(path).catch(() => {});
        continue;
      }

      if (isAlive(holder.pid)) {
        // Live holder. Drop tmp and report blocked.
        await unlinkAsync(tmp).catch(() => {});
        const ageSec = Math.max(
          0,
          Math.round((Date.now() - holder.startedAtMs) / 1000),
        );
        log(
          `telegram gateway: boot.lock_blocked holder_pid=${holder.pid} holder_started_at=${new Date(
            holder.startedAtMs,
          ).toISOString()} holder_age_sec=${ageSec}${agentTag}`,
        );
        return { status: "blocked", holder, holderAgeSec: ageSec };
      }

      // Stale holder (PID dead). Unlink and loop once to retry the
      // link. Log before unlink so the recovery is auditable.
      log(
        `telegram gateway: boot.lock_stale_recovered prior_pid=${holder.pid} prior_started_at=${new Date(
          holder.startedAtMs,
        ).toISOString()}${agentTag}`,
      );
      try {
        await unlinkAsync(path);
      } catch (unlinkErr) {
        const unlinkCode = (unlinkErr as NodeJS.ErrnoException).code;
        if (unlinkCode !== "ENOENT") {
          // Couldn't clean up — propagate. Tmp gets cleaned by finalizer.
          await unlinkAsync(tmp).catch(() => {});
          throw unlinkErr;
        }
        // ENOENT means someone else cleaned it; that's fine, retry link.
      }

      recoveredFrom = holder;
    }
  }

  // Reached only if both link attempts failed EEXIST. The second EEXIST
  // implies a live process won the race after we cleared the stale
  // file. Re-read and report as blocked.
  await unlinkAsync(tmp).catch(() => {});
  const finalHolder = await tryReadRecord(path);
  if (finalHolder != null && isAlive(finalHolder.pid)) {
    const ageSec = Math.max(
      0,
      Math.round((Date.now() - finalHolder.startedAtMs) / 1000),
    );
    log(
      `telegram gateway: boot.lock_blocked holder_pid=${finalHolder.pid} holder_started_at=${new Date(
        finalHolder.startedAtMs,
      ).toISOString()} holder_age_sec=${ageSec}${agentTag}`,
    );
    return { status: "blocked", holder: finalHolder, holderAgeSec: ageSec };
  }
  // Edge: file vanished between attempts. Treat as blocked-with-unknown
  // rather than spinning further; systemd backoff is the right answer.
  const fallback: MutexRecord = finalHolder ?? { pid: 0, startedAtMs: 0 };
  log(
    `telegram gateway: boot.lock_blocked_unknown_holder${agentTag}`,
  );
  return { status: "blocked", holder: fallback, holderAgeSec: 0 };
}

/**
 * Release the lock by unlinking the canonical file. Logs and swallows
 * ENOENT (already gone — fine). Other errors are logged but NOT thrown:
 * shutdown paths run in finally blocks where throwing would skip
 * subsequent cleanup steps.
 */
export async function releaseStartupLock(opts: {
  path: string;
  pid: number;
  log?: (line: string) => void;
  agentName?: string;
}): Promise<void> {
  const log = opts.log ?? DEFAULT_LOG;
  const agentTag = fmtAgent(opts.agentName);
  try {
    await unlinkAsync(opts.path);
    log(`telegram gateway: shutdown.lock_released pid=${opts.pid}${agentTag}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      // Already gone — log at info, not error. Common after a crash
      // where someone else cleaned up.
      log(
        `telegram gateway: shutdown.lock_release_noop pid=${opts.pid}${agentTag}`,
      );
      return;
    }
    log(
      `telegram gateway: shutdown.lock_release_failed pid=${opts.pid} code=${code ?? "unknown"} err=${(err as Error).message}${agentTag}`,
    );
  }
}
