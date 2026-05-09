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
 *
 * Container/PID-namespace correctness (#884):
 * -------------------------------------------
 * Under v0.7 docker each agent runs in its own PID namespace. The
 * gateway PID written to disk inside the previous container instance
 * is meaningless in the new container — PID 10 in container A and
 * PID 10 in container B are unrelated processes. `process.kill(pid, 0)`
 * happily reports "alive" because the PID number is reused by an
 * unrelated current-container process (tini's child, autoaccept-poll,
 * etc.), and the new gateway aborts with `another_gateway_is_live`.
 *
 * Fix: stamp every record with a `bootId` derived from PID 1's
 * `starttime` (clock ticks since system boot, field 22 in /proc/1/stat).
 * Inside a container, PID 1 is tini and its starttime is the container's
 * start instant — survives PID recycling within the namespace, but
 * differs from any other container's PID 1 starttime. On bare metal
 * PID 1 is systemd/init; the field still uniquely identifies the host
 * boot. The PID-liveness check is now gated on bootId match: same boot
 * → trust kill(pid,0); different boot → record is stale regardless.
 *
 * Records written by older versions have no `bootId`. We treat those as
 * "unknown boot" and fall back to the legacy kill-based check — same
 * behavior as before this fix, so the upgrade path is one-way safe.
 */
import {
  link as linkAsync,
  unlink as unlinkAsync,
  writeFile as writeFileAsync,
  readFile as readFileAsync,
} from "node:fs/promises";
import { readFileSync } from "node:fs";

export interface MutexRecord {
  pid: number;
  startedAtMs: number;
  /**
   * Identifier of the OS/container boot during which this record was
   * written. See "Container/PID-namespace correctness" in the file
   * header. Optional for backwards compatibility with records written
   * by pre-#884 gateway versions.
   */
  bootId?: string;
}

/**
 * Read PID 1's start-time-in-clock-ticks from /proc/1/stat (field 22).
 *
 * Inside a docker container the PID-1 starttime is tied to the
 * container instance and survives PID recycling but differs across
 * container recreations. On bare metal it identifies the host boot.
 * Returns `null` outside Linux or when /proc/1/stat is unreadable —
 * callers fall back to legacy PID-only checks in that case.
 *
 * The 22nd field (`starttime`) appears AFTER the `comm` field which
 * is wrapped in parentheses and may contain spaces/parens itself, so
 * we slice past the LAST `)` before splitting on whitespace.
 */
export function readCurrentBootId(): string | null {
  try {
    const stat = readFileSync("/proc/1/stat", "utf-8");
    const lastParen = stat.lastIndexOf(")");
    if (lastParen < 0) return null;
    const tail = stat.slice(lastParen + 1).trim();
    const fields = tail.split(/\s+/);
    // Field index in the post-comm tail: original fields 3..N → tail[0..]
    // starttime is original field 22, so tail index 22 - 3 = 19.
    const starttime = fields[19];
    if (!starttime || !/^\d+$/.test(starttime)) return null;
    return `pid1:${starttime}`;
  } catch {
    return null;
  }
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
   * Override for "what boot are we in right now". Defaults to
   * `readCurrentBootId()`. Injectable so tests can simulate
   * container-restart scenarios without recreating containers.
   * `null` disables the bootId gate (treats all records as
   * same-boot — the legacy pre-#884 behavior).
   */
  currentBootId?: string | null;
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
      const out: MutexRecord = { pid: parsed.pid, startedAtMs: parsed.startedAtMs };
      if (typeof parsed.bootId === "string" && parsed.bootId.length > 0) {
        out.bootId = parsed.bootId;
      }
      return out;
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

  // Resolve the current bootId. `undefined` in opts means "use the
  // process default"; an explicit `null` opts out (legacy behavior).
  const currentBootId =
    opts.currentBootId === undefined ? readCurrentBootId() : opts.currentBootId;

  // Stamp our own record with the bootId so future boots know whether
  // we belong to the same container/host as them. Don't mutate the
  // caller's record object.
  const recordToWrite: MutexRecord =
    currentBootId != null ? { ...record, bootId: currentBootId } : { ...record };
  const tmp = tmpPath(path, record.pid);
  const payload = JSON.stringify(recordToWrite);

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

      // Boot/PID-namespace gate (#884). If the holder record carries a
      // bootId AND it doesn't match ours, the holder PID is from a
      // different container/host boot and `kill(pid, 0)` against it is
      // meaningless — same PID number could be a live unrelated process
      // in our namespace. Skip the kill check, treat as stale, recover.
      // If either side has no bootId we fall back to the legacy PID
      // check (preserves pre-#884 behavior for non-Linux dev/test runs
      // and for upgrades from records that pre-date the bootId field).
      const bootMismatch =
        currentBootId != null && holder.bootId != null && holder.bootId !== currentBootId;

      if (bootMismatch) {
        log(
          `telegram gateway: boot.lock_stale_recovered_boot_mismatch prior_pid=${holder.pid} prior_started_at=${new Date(
            holder.startedAtMs,
          ).toISOString()} prior_boot=${holder.bootId} current_boot=${currentBootId}${agentTag}`,
        );
        await unlinkAsync(path).catch((unlinkErr: unknown) => {
          const code = (unlinkErr as NodeJS.ErrnoException).code;
          if (code !== "ENOENT") throw unlinkErr;
        });
        recoveredFrom = holder;
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
