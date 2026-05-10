/**
 * Vault writer lock — PID-file flock replacing `proper-lockfile`.
 *
 * Background (#964 / plan v3 §4 / §11). v0.7.12 (#955) added flock to
 * `saveVault` via `proper-lockfile`, which creates a sentinel directory
 * `vault.enc.lock/` next to the file. That worked but missed three
 * properties #964 calls out:
 *
 *   1. **PID exposure.** plan v3 §11 wanted contention errors of shape
 *      `vault busy: held by pid <N> path <P>`. proper-lockfile's
 *      sentinel-dir doesn't surface the holder PID anywhere readable,
 *      so we shipped a worse message ("another writer holds the lock
 *      at <path>") and lost forensic ground.
 *   2. **Ad-hoc tooling.** A sentinel directory is only honored by
 *      other proper-lockfile callers. Operators shelling in with a
 *      different lock tool (`flock(1)`, lsof, /proc/locks) see nothing.
 *   3. **Crash recovery.** proper-lockfile auto-recovers stale locks
 *      via mtime + pid liveness, but that logic lives inside the
 *      library — no other consumer can replicate it without reading
 *      proper-lockfile internals.
 *
 * The issue suggested native `fcntl(F_SETLK)` via N-API or FFI. That
 * IS the most honest kernel-backed primitive, but it adds a native
 * build step (broken without node-gyp present, problematic on bun
 * vs node, cross-arch headache) for a problem where 99% of contention
 * is between *our own processes*. So this module takes a no-deps
 * middle path:
 *
 *   - Lock is a **regular file** (not a directory) at `<vaultPath>.lock`.
 *   - Acquisition is `openSync(path, O_WRONLY | O_CREAT | O_EXCL)` —
 *     the kernel does the atomic "create-if-not-exists" check.
 *   - On success we write `<pid>\n<ts_ms>\n<argv0>\n` and fsync. The
 *     content is human-readable; any peer or operator can `cat` it.
 *   - On EEXIST we read the existing file, parse the holder PID, and
 *     check liveness via `/proc/<pid>` (Linux) or `kill(pid, 0)`
 *     (portable). A dead PID = stale lock; we unlink and retry.
 *   - Contention error embeds the holder PID + acquired-ago seconds
 *     per plan v3 §11.
 *
 * Migration from v0.7.14: an in-flight v0.7.14 sentinel-DIR at the
 * lock path looks the same as a never-released file to the new
 * acquirer. The acquire path handles this lazily — if openSync fails
 * with EISDIR (path exists as a directory), the dir is a stale v0.7.14
 * artifact (no v0.7.15+ writer makes a dir), so we rmdir it and retry.
 * Safe because v0.7.15 binary replacement requires a service restart,
 * which terminates any v0.7.14 process that could legitimately have
 * been mid-write.
 */

import {
  existsSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  constants as fsConstants,
} from "node:fs";

/** Default retry budget — matches the v0.7.12 number for behavioral parity. */
export const DEFAULT_LOCK_RETRY_MS = 5000;

/** Path suffix appended to the protected file. */
export function lockPathFor(vaultPath: string): string {
  return `${vaultPath}.lock`;
}

/** Parsed holder metadata read from a live lock file. */
export interface LockHolder {
  /** PID of the writer that currently holds the lock. */
  pid: number;
  /** Wallclock time (ms since epoch) when the lock was acquired. */
  acquiredAtMs: number;
  /** argv[0] of the holder process, best-effort. May be empty string. */
  argv0: string;
}

/**
 * Read holder metadata from a lock file. Returns `null` on any parse or
 * read failure (caller treats null as "unknown holder"; the error
 * message degrades from "held by pid 12345" to "held by another writer"
 * but doesn't break correctness).
 */
export function readLockHolder(lockPath: string): LockHolder | null {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const lines = raw.split("\n");
    const pid = Number.parseInt(lines[0] ?? "", 10);
    const acquiredAtMs = Number.parseInt(lines[1] ?? "", 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    if (!Number.isFinite(acquiredAtMs) || acquiredAtMs <= 0) return null;
    return { pid, acquiredAtMs, argv0: lines[2] ?? "" };
  } catch {
    return null;
  }
}

/**
 * Liveness check for a held-lock PID. Linux uses `/proc/<pid>`
 * existence (preferred — `kill(0)` has portability quirks around
 * privilege boundaries). Other platforms fall back to `kill(pid, 0)`,
 * which raises ESRCH when the process is gone.
 */
function pidIsLive(pid: number): boolean {
  if (process.platform === "linux") {
    return existsSync(`/proc/${pid}`);
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort cleanup of a v0.7.14 sentinel-DIRECTORY lock at the
 * given path. Removes the directory's contents (proper-lockfile may
 * leave one or two files inside) then rmdir's it. Returns true on
 * success or if nothing was there.
 *
 * Safe only because v0.7.15 binary replacement requires a service
 * restart, which terminates any v0.7.14 writer that might have been
 * holding the sentinel dir legitimately.
 */
function clearStaleSentinelDir(lockPath: string): boolean {
  try {
    if (!existsSync(lockPath)) return true;
    const s = statSync(lockPath);
    if (!s.isDirectory()) return true; // already a file — nothing to do
    for (const entry of readdirSync(lockPath)) {
      try { unlinkSync(`${lockPath}/${entry}`); } catch { /* */ }
    }
    rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquire an exclusive lock on `vaultPath`. Blocks (via Atomics.wait)
 * until acquired or the retry budget expires. Returns a release
 * function — call it from `finally{}` to unlink the lock file.
 *
 * @throws VaultBusyError if the budget expires with the lock still
 *   held. The error message names the holder PID per plan v3 §11.
 */
export function acquireLock(
  vaultPath: string,
  options: { budgetMs?: number } = {},
): { release: () => void } {
  const budgetMs = options.budgetMs ?? DEFAULT_LOCK_RETRY_MS;
  const lockPath = lockPathFor(vaultPath);
  const deadline = Date.now() + budgetMs;
  // SharedArrayBuffer-backed Atomics.wait sleeps the current thread
  // without burning CPU. Same shape as the previous proper-lockfile
  // retry loop.
  const sleepBuf = new Int32Array(new SharedArrayBuffer(4));

  while (true) {
    let fd: number | null = null;
    try {
      fd = openSync(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code ?? "";
      if (code === "EEXIST") {
        // Path exists. It might be:
        //   (a) a live PID-file lock from a peer writer → wait
        //   (b) a stale PID-file lock from a dead holder → unlink + retry
        //   (c) a v0.7.14 sentinel DIRECTORY → migrate to file
        //
        // statSync tells us (c) vs (a/b). O_EXCL doesn't return
        // EISDIR — the kernel checks existence before type — so we
        // do the type-check ourselves in the EEXIST branch.
        let isDir = false;
        try { isDir = statSync(lockPath).isDirectory(); } catch { /* */ }
        if (isDir) {
          // v0.7.14 sentinel-dir migration — see file header. Clear
          // it and retry immediately (no sleep — this is a one-shot
          // migration step, not contention).
          if (clearStaleSentinelDir(lockPath)) continue;
          // clearStaleSentinelDir returned false — couldn't remove
          // the dir (permission error, races with another acquirer).
          // Fall through to the contention path so we don't busy-loop.
        }

        // Regular file: PID-file lock. Inspect liveness.
        const holder = readLockHolder(lockPath);
        if (holder && !pidIsLive(holder.pid)) {
          // Stale lock — best-effort unlink + retry. If another
          // racing acquirer beats us to the unlink, the next loop
          // iteration's openSync just contends again normally.
          try { unlinkSync(lockPath); } catch { /* lost the race */ }
          continue;
        }
        if (Date.now() >= deadline) {
          // Budget expired. Build the diagnostic message.
          throw makeBusyError(vaultPath, lockPath, holder, budgetMs);
        }
        // 100ms backoff between retries — matches the v0.7.12 cadence.
        Atomics.wait(sleepBuf, 0, 0, 100);
        continue;
      } else {
        // Some other open error (EACCES, ENOENT on parent dir, etc.).
        // Don't swallow — the caller needs the real reason.
        throw err;
      }
    }

    // Acquired. Write holder metadata.
    try {
      const meta = `${process.pid}\n${Date.now()}\n${process.argv[1] ?? ""}\n`;
      writeSync(fd, meta);
      fsyncSync(fd);
    } catch {
      // Metadata-write failed but the FD is ours. Close + clean up.
      try { closeSync(fd); } catch { /* */ }
      try { unlinkSync(lockPath); } catch { /* */ }
      throw new Error(`vault flock: failed to write holder metadata to ${lockPath}`);
    }

    const ownedFd = fd;
    return {
      release: () => {
        try { closeSync(ownedFd); } catch { /* */ }
        try { unlinkSync(lockPath); } catch { /* */ }
      },
    };
  }
}

/**
 * VaultBusyError — thrown by acquireLock when the retry budget
 * expires. Subclass of Error so callers can `instanceof` distinguish
 * "contention timeout" from "filesystem error / permission denied".
 *
 * The holder details are attached to fields so a programmatic caller
 * (e.g. the Telegram gateway error-renderer added in #972) can format
 * the message however it wants without re-parsing the string.
 */
export class VaultBusyError extends Error {
  readonly vaultPath: string;
  readonly lockPath: string;
  readonly holderPid: number | null;
  readonly heldForMs: number | null;
  readonly budgetMs: number;

  constructor(
    message: string,
    fields: {
      vaultPath: string;
      lockPath: string;
      holderPid: number | null;
      heldForMs: number | null;
      budgetMs: number;
    },
  ) {
    super(message);
    this.name = "VaultBusyError";
    this.vaultPath = fields.vaultPath;
    this.lockPath = fields.lockPath;
    this.holderPid = fields.holderPid;
    this.heldForMs = fields.heldForMs;
    this.budgetMs = fields.budgetMs;
  }
}

function makeBusyError(
  vaultPath: string,
  lockPath: string,
  holder: LockHolder | null,
  budgetMs: number,
): VaultBusyError {
  const holderPid = holder?.pid ?? null;
  const heldForMs = holder ? Date.now() - holder.acquiredAtMs : null;
  // Plan v3 §11 message shape: "vault busy: held by pid <N> path <P>".
  const holderClause = holder
    ? `held by pid ${holder.pid} (acquired ${Math.round((heldForMs ?? 0) / 1000)}s ago)`
    : "held by another writer (holder PID unreadable — lock file empty or unparseable)";
  return new VaultBusyError(
    `vault busy: ${holderClause} at ${lockPath} (retried for ${budgetMs}ms). ` +
    `Try again in a moment. If the holder process is gone, the next acquirer ` +
    `will clear the stale lock automatically.`,
    { vaultPath, lockPath, holderPid, heldForMs, budgetMs },
  );
}
