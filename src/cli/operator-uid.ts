/**
 * Operator-identity + post-sudo ownership restore (#1473 prevention).
 *
 * `switchroom apply` self-elevates by re-exec'ing the WHOLE process
 * under `sudo` (`reexecUnderSudo`). Everything it then writes —
 * `migrateVaultLayout` rewriting `vault/vault.enc`, the audit-log
 * mkdirs, etc. — is created as root, with no chown-back. The broker
 * still reads via CAP_DAC_READ_SEARCH, so it's invisible until the
 * operator runs `switchroom vault …` and gets EACCES (the recurring
 * lockout this prevents — detected by doctor since #1474, now also
 * prevented at the source).
 *
 * Scattered per-artifact chowns regress every time a new operator-owned
 * artifact lands, so this is ONE generic sweep over the operator-owned
 * `~/.switchroom` subtree. Per-agent state dirs are intentionally NOT
 * touched — `alignAgentUid` owns those at the per-agent UID.
 */

import {
  chownSync,
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Resolve the real invoking operator's uid even under sudo. `sudo`
 * exports the underlying user's uid as `SUDO_UID` (process.getuid()
 * would return 0). Falls back to getuid() when >0, else undefined
 * (root with no SUDO_UID, or non-POSIX where getuid is unavailable).
 */
export function resolveOperatorUid(): number | undefined {
  const sudoUid = process.env.SUDO_UID;
  if (sudoUid !== undefined) {
    const parsed = parseInt(sudoUid, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  if (typeof process.getuid === "function") {
    const uid = process.getuid();
    if (uid > 0) return uid;
  }
  return undefined;
}

export interface OwnershipRestoreDeps {
  chown?: (path: string, uid: number, gid: number) => void;
  exists?: (path: string) => boolean;
  /** True if path is a directory (follows symlinks). */
  isDir?: (path: string) => boolean;
  /** True if path is itself a symlink (no follow). */
  isSymlink?: (path: string) => boolean;
  realpath?: (path: string) => string;
  readdir?: (path: string) => string[];
}

/**
 * Operator-owned artifacts directly under `~/.switchroom` that a
 * root-mode `apply` can leave root-owned and thereby lock the operator
 * out of. NOT per-agent dirs (alignAgentUid handles those at the agent
 * UID — chowning them to the operator would itself break the agents).
 */
export function operatorOwnedPaths(home: string): string[] {
  const root = join(home, ".switchroom");
  return [
    join(root, "vault"), // dir (recursive) — holds vault.enc
    join(root, "vault-auto-unlock"), // machine-id-keyed unlock blob
    join(root, "vault-audit.log"),
    join(root, "host-control-audit.log"),
    join(root, "accounts"), // dir (recursive) — OAuth account store
    join(root, "compose"), // dir (recursive) — generated docker-compose.yml
  ];
}

/**
 * Best-effort: chown the operator-owned `~/.switchroom` subtree back to
 * `operatorUid:operatorUid`. Recurses into directories. Every chown is
 * best-effort (dev/non-docker, missing path, no CAP_CHOWN, raced
 * delete) — a failure on one path never aborts the rest. Returns the
 * realpaths it successfully chowned (logging/tests).
 *
 * For the `vault` dir this resolves the real target so the v0.7.12
 * legacy symlink (`vault.enc -> vault/vault.enc`) doesn't matter.
 */
export function restoreOperatorOwnership(
  home: string,
  operatorUid: number,
  deps: OwnershipRestoreDeps = {},
): string[] {
  const chown = deps.chown ?? ((p, u, g) => chownSync(p, u, g));
  const exists = deps.exists ?? ((p) => existsSync(p));
  const isSymlink =
    deps.isSymlink ??
    ((p) => {
      try {
        return lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    });
  const isDir =
    deps.isDir ??
    ((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
  const realpath =
    deps.realpath ??
    ((p) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    });
  const readdir =
    deps.readdir ??
    ((p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    });

  const chowned: string[] = [];
  const seen = new Set<string>();

  const visit = (path: string): void => {
    if (!exists(path)) return;
    // Resolve symlinks to the real target (the v0.7.12 vault.enc
    // legacy link, accounts symlinks, …) so we chown the actual file,
    // not the link entry.
    const target = isSymlink(path) ? realpath(path) : path;
    if (seen.has(target)) return;
    seen.add(target);
    try {
      chown(target, operatorUid, operatorUid);
      chowned.push(target);
    } catch {
      /* best-effort: dev/no CAP_CHOWN/raced; keep going */
    }
    if (isDir(target)) {
      for (const entry of readdir(target)) {
        visit(join(target, entry));
      }
    }
  };

  for (const p of operatorOwnedPaths(home)) visit(p);
  return chowned;
}
