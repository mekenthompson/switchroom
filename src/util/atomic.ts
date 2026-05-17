/**
 * Atomic file write primitive — shared between vault-broker and
 * auth-broker (RFC H §4.4).
 *
 * Both brokers write secret-bearing files (vault entries, OAuth
 * credentials.json, per-agent mirrors) with the same one-writer-
 * many-readers shape and need the same atomicity guarantee: a
 * concurrent reader either sees the old bytes in full or the new
 * bytes in full, never a half-written file.
 *
 * The primitive: tempfile alongside the destination + fsync the
 * tempfile + rename(2). `rename` is atomic *within a single
 * filesystem*, which is why the tempfile must live in the same
 * directory as the destination (not /tmp).
 *
 * Failure modes:
 *   - mkdir/write/fsync error → tempfile cleaned up, error rethrown.
 *   - rename error → tempfile cleaned up, error rethrown. The
 *     destination is untouched.
 *   - Process crash mid-write → tempfile may be left behind;
 *     unique per-pid + random suffix means concurrent writers
 *     don't collide on the tempfile name.
 *
 * Mode defaults to 0o600 (owner read/write only) because the
 * canonical caller is writing OAuth tokens / vault entries.
 * Callers that need 0o644 (e.g. config files) pass it explicitly.
 */

import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync, renameSync, rmSync, writeSync } from "node:fs";

/**
 * Tempfile open flags — sec #1410 (follow-up to CRITICAL #1393).
 *
 * Both brokers run as ROOT and write secret-bearing files. #1409's
 * `resolveMirrorPathsSafe` lstat-guards the auth-broker mirror's
 * directory components, but a narrow sub-millisecond TOCTOU remained
 * between that lstat sweep and the final tempfile `openSync` here: an
 * attacker who wins the race could plant a symlink at the tempfile
 * path and have the root broker write a secret through it.
 *
 *   - `O_NOFOLLOW` — if the final component is a symlink, fail (ELOOP)
 *     instead of following it. Closes the planted-symlink race.
 *   - `O_EXCL` (with `O_CREAT`) — the open MUST create the file; fail
 *     if anything already exists at the tempfile path. The temp name
 *     is unique per-pid + 4 random bytes so this never trips in
 *     legitimate use; it defeats a pre-planted file/FIFO at a guessed
 *     path and makes the old `"w"` flag's `O_TRUNC` unnecessary (the
 *     file is always brand-new).
 *
 * Fail-closed: any of these tripping throws; the caller cleans the
 * tempfile and rethrows; the destination is left untouched.
 * O_NOFOLLOW is Linux/macOS (the broker runtime); `?? 0` keeps the
 * primitive importable where it's absent.
 */
const TMP_OPEN_FLAGS =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0);

export function atomicWriteFileSync(
  destPath: string,
  contents: string | Buffer,
  mode = 0o600,
): void {
  const tmp = `${destPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const buf = typeof contents === "string" ? Buffer.from(contents, "utf-8") : contents;
  let fd: number | null = null;
  try {
    fd = openSync(tmp, TMP_OPEN_FLAGS, mode);
    writeSync(fd, buf, 0, buf.length, 0);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, destPath);
  } catch (err) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
    try { rmSync(tmp, { force: true }); } catch { /* tempfile already gone */ }
    throw err;
  }
}

export function atomicWriteJsonSync(
  destPath: string,
  value: unknown,
  mode = 0o600,
): void {
  atomicWriteFileSync(destPath, JSON.stringify(value, null, 2) + "\n", mode);
}
