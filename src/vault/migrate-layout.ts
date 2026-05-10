/**
 * Vault layout migration — moves `~/.switchroom/vault.enc` to
 * `~/.switchroom/vault/vault.enc` and replaces the old path with a
 * symlink for backwards compat with v0.7.10 and earlier CLI binaries.
 *
 * Why this exists: in v0.7.11 the broker container bind-mounts the
 * vault file into `/state/vault.enc` as a single-file mount. Single-
 * file bind mounts are on a different filesystem device than the
 * parent dir inside the container, so `atomicWriteFileSync`'s
 * write-temp-rename pattern fails with `EBUSY` (Linux surfaces cross-
 * fs rename for a bind-mount target as in-use). v0.7.12 re-bind-mounts
 * the parent dir instead — atomic-rename works because temp + dest are
 * on the same fs. See plan v3 / RCA in #954.
 *
 * State machine (plan v3 §2):
 *
 *   A: virgin               — neither path exists                 → no-op
 *   B: pre-migration        — old=file, new=missing               → migrate
 *   C: partial-finished     — both exist, hashes equal            → finish symlink
 *   D: post-migration       — old=symlink, new=file               → no-op
 *   E: divergent            — both exist, hashes differ           → REFUSE
 *
 * Drift detection: state E arises if a v0.7.x CLI writes to the old
 * path AFTER migration ran. Linux `rename()` does not follow a
 * symlink at the destination — it REPLACES the symlink with the new
 * regular file. The result: broker writes to new, CLI writes to old,
 * vault state diverges silently. State E catches this at the next
 * `switchroom apply` AND at broker startup (see broker server.ts);
 * either path runs the recovery recipe.
 *
 * Concurrency: the helper acquires the same lock saveVault does,
 * before reading either path's content for hash comparison. This
 * defeats the broker-writes-between-hashes TOCTOU.
 */

import {
  copyFileSync,
  chmodSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { acquireVaultLock } from "./vault.js";

export type MigrationResult =
  | { kind: "no-vault" }
  | { kind: "already-migrated" }
  | { kind: "completed-partial" }
  | { kind: "migrated" }
  | { kind: "divergent"; details: DivergentDetails }
  | { kind: "custom-path-skipped"; path: string };

export interface DivergentDetails {
  oldPath: string;
  newPath: string;
  oldHash: string;
  newHash: string;
  oldSize: number;
  newSize: number;
  oldMtime: string;
  newMtime: string;
}

/**
 * Compute the canonical layout paths under a given home directory.
 * Exported so callers (compose-gen, broker server) can reason about
 * the layout without re-deriving.
 */
export function vaultLayoutPaths(home: string): {
  oldPath: string;
  newPath: string;
  parent: string;
  switchroomRoot: string;
} {
  const switchroomRoot = join(home, ".switchroom");
  return {
    oldPath: join(switchroomRoot, "vault.enc"),
    newPath: join(switchroomRoot, "vault", "vault.enc"),
    parent: join(switchroomRoot, "vault"),
    switchroomRoot,
  };
}

/**
 * Read-only inspection: returns the current state without mutating
 * disk. Used by compose-gen to refuse generation when state is E,
 * and by broker server.ts on startup to detect drift.
 */
export function inspectVaultLayout(home: string): MigrationResult {
  return runMigration(home, { dryRun: true });
}

/**
 * Execute the migration. Idempotent: calling on already-migrated state
 * (D) returns `{kind: "already-migrated"}` without changes.
 *
 * Custom vault paths (operator set `vault.path` to something other than
 * the default) are skipped — pass the resolved path to the optional
 * `customVaultPath` parameter and we'll return `custom-path-skipped`
 * if it's not the canonical layout.
 */
export function migrateVaultLayout(
  home: string,
  opts: { customVaultPath?: string } = {},
): MigrationResult {
  // Custom path detection — only run migration on the canonical default.
  if (opts.customVaultPath !== undefined) {
    const { newPath, oldPath } = vaultLayoutPaths(home);
    const isCanonicalNew = opts.customVaultPath === newPath;
    const isCanonicalOld = opts.customVaultPath === oldPath;
    if (!isCanonicalNew && !isCanonicalOld) {
      return { kind: "custom-path-skipped", path: opts.customVaultPath };
    }
  }
  return runMigration(home, { dryRun: false });
}

function runMigration(
  home: string,
  opts: { dryRun: boolean },
): MigrationResult {
  const { oldPath, newPath, parent, switchroomRoot } = vaultLayoutPaths(home);

  // Acquire the same lock saveVault uses, IF either of the involved
  // files exists. This holds across the hash-compare + rename so a
  // concurrent broker write can't slip in between read and decision.
  // For the dry-run inspection path, we skip the lock — broker startup
  // calls inspectVaultLayout BEFORE it acquires its own lock, and
  // taking the lock here would deadlock the boot path.
  const lockTarget = existsSync(newPath) ? newPath : (existsSync(oldPath) ? oldPath : null);
  const release = (!opts.dryRun && lockTarget !== null)
    ? acquireVaultLock(lockTarget)
    : null;

  try {
    const oldStat = lstatSyncOrNull(oldPath);
    const newExists = existsSync(newPath);

    // State A: virgin install (no vault yet).
    if (oldStat === null && !newExists) {
      return { kind: "no-vault" };
    }

    // State D: already migrated (symlink at old path, file at new path).
    if (oldStat?.isSymbolicLink() && newExists) {
      return { kind: "already-migrated" };
    }

    // State C or E: both regular files exist.
    if (oldStat?.isFile() && newExists) {
      const oldHash = sha256File(oldPath);
      const newHash = sha256File(newPath);
      if (oldHash === newHash) {
        // State C — partial migration finished, replace old with symlink.
        if (opts.dryRun) return { kind: "completed-partial" };
        atomicReplaceWithSymlink(oldPath, "vault/vault.enc");
        fsyncDir(switchroomRoot);
        return { kind: "completed-partial" };
      }
      // State E — divergence; refuse, surface details.
      const oldRealStat = statSync(oldPath);
      const newRealStat = statSync(newPath);
      return {
        kind: "divergent",
        details: {
          oldPath,
          newPath,
          oldHash,
          newHash,
          oldSize: oldRealStat.size,
          newSize: newRealStat.size,
          oldMtime: oldRealStat.mtime.toISOString(),
          newMtime: newRealStat.mtime.toISOString(),
        },
      };
    }

    // State B: pre-migration. Old is a regular file, new is missing.
    if (oldStat?.isFile() && !newExists) {
      if (opts.dryRun) return { kind: "migrated" };
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      const tempNew = `${newPath}.tmp`;
      // copyFileSync does NOT preserve mode by default. Explicit chmod
      // to 0600 after copy. (Round-2 R3 callout.)
      copyFileSync(oldPath, tempNew);
      chmodSync(tempNew, 0o600);
      fsyncFile(tempNew);
      renameSync(tempNew, newPath);
      fsyncDir(parent);
      atomicReplaceWithSymlink(oldPath, "vault/vault.enc");
      fsyncDir(switchroomRoot);
      return { kind: "migrated" };
    }

    // Defensive fallthrough — shouldn't reach here. Treat as no-op.
    return { kind: "no-vault" };
  } finally {
    if (release !== null) {
      try { release(); } catch { /* */ }
    }
  }
}

/**
 * Format a state-E divergence result as the literal recovery message
 * pinned in plan v3 §2.1. Tested in CI byte-for-byte (with the path
 * and hash placeholders normalised).
 */
export function formatDivergentRecoveryMessage(d: DivergentDetails): string {
  const oldShort = d.oldHash.slice(0, 16) + "...";
  const newShort = d.newHash.slice(0, 16) + "...";
  return `\
✗ Vault layout divergence detected — refusing to proceed.

Two distinct vault files exist:

  ${d.oldPath}
    sha256: ${oldShort}
    mtime:  ${d.oldMtime}
    size:   ${d.oldSize}

  ${d.newPath}
    sha256: ${newShort}
    mtime:  ${d.newMtime}
    size:   ${d.newSize}

This usually means an old version of the switchroom CLI wrote to the
legacy path AFTER migration ran, replacing the symlink with a fresh
regular file. The broker has been writing to the new path; the legacy
path now has stale or independent state.

Pick one to keep:

  a) Keep the NEW path (recommended if broker writes are the source
     of truth — e.g. you've been using vault from inside agent
     containers since the migration):

       cp ${d.oldPath} ${d.oldPath}.divergent.bak
       rm ${d.oldPath}
       ln -s vault/vault.enc ${d.oldPath}
       switchroom apply

  b) Keep the OLD path (recommended if you wrote to the legacy path
     deliberately and want to discard broker-side rotations):

       cp ${d.newPath} ${d.newPath}.divergent.bak
       cp ${d.oldPath} ${d.newPath}
       rm ${d.oldPath}
       ln -s vault/vault.enc ${d.oldPath}
       switchroom apply

  c) If unsure, decrypt both and diff (you'll be prompted for the
     vault passphrase twice):

       switchroom vault list --no-broker --vault-path \\
         ${d.oldPath} | sort > /tmp/legacy-keys.txt
       switchroom vault list --no-broker --vault-path \\
         ${d.newPath} | sort > /tmp/new-keys.txt
       diff /tmp/legacy-keys.txt /tmp/new-keys.txt

In every case, the .divergent.bak file is your safety net. Verify
your fleet works after \`switchroom apply\`, then delete it.
`;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function lstatSyncOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try { return lstatSync(path); }
  catch { return null; }
}

function sha256File(path: string): string {
  const data = readFileSync(path);
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Replace `target` with a symlink to `linkTarget`. Atomic via temp +
 * rename, idempotent on partial state (cleans up stale .symlink-tmp
 * before creating fresh).
 */
function atomicReplaceWithSymlink(target: string, linkTarget: string): void {
  const tmp = join(dirname(target), `.${basename(target)}.symlink-tmp`);
  if (existsSync(tmp)) {
    try { unlinkSync(tmp); } catch { /* */ }
  }
  symlinkSync(linkTarget, tmp);
  renameSync(tmp, target);
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r+");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}

function fsyncDir(path: string): void {
  // Open dir for read; fsync. Required after rename to guarantee
  // directory entry update is durable across power loss.
  const fd = openSync(path, "r");
  try { fsyncSync(fd); }
  finally { closeSync(fd); }
}
