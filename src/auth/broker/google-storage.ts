/**
 * Google credential storage for the auth-broker (RFC G Phase 3b.2c).
 *
 * **Pragmatic shortcut**: Google credentials live in the auth-broker's
 * own state dir at `~/.switchroom/state/auth-broker/google/<account>/`,
 * NOT (yet) in the vault-broker. RFC G v3 §4.4 specified vault-broker-
 * mediated storage (so refresh tokens live in the encrypted vault),
 * but that requires:
 *   - A `set-secret-for-peer` verb on vault-broker (doesn't exist)
 *   - auth-broker as a vault-broker peer with appropriate ACL
 *   - Cross-broker IPC client library
 *
 * Building those is its own multi-PR architectural piece. **Phase
 * 3b.2d** (future) will migrate from on-disk-here to vault-broker-
 * mediated. Until then Google credentials live alongside Anthropic
 * (which also stores plaintext on disk under `~/.switchroom/accounts/`)
 * — same security posture as the existing pattern.
 *
 * Storage layout:
 *
 *   ~/.switchroom/state/auth-broker/google/
 *     alice@example.com/
 *       credentials.json   ← `{ googleOauth: { ... } }` verbatim, mode 0600
 *     work@bigcorp.com/
 *       credentials.json
 *
 * Account labels are normalized to lowercase + trimmed (Phase 2's
 * `normalizeGoogleAccount` shape) before being used as directory
 * names. Email-shape emails contain `@` which is safe in filesystem
 * names but worth confirming.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { atomicWriteFileSync } from "../../util/atomic.js";
import type { GoogleCredentialsShape } from "./protocol.js";

/**
 * Normalize an account email to the on-disk-safe form. Mirrors
 * `src/drive/vault-slots.ts:normalizeGoogleAccount` so the same
 * label resolves identically regardless of which subsystem writes
 * it.
 */
export function normalizeGoogleAccountForStorage(account: string): string {
  return account.trim().toLowerCase();
}

/**
 * Validate that an account label is safe to use as a filesystem path
 * component before any fs op touches it. Refuses path-traversal
 * (`..`), separators (`/` `\`), null bytes, empty, and anything else
 * that doesn't fit the email-shape contract Phase 2 already
 * enforces at the schema layer.
 *
 * Throws on rejection with an operator-actionable message. Callers
 * (broker dispatcher) wrap throws into `INVALID_ARGS` errors.
 *
 * Mirrors the schema-side regex from
 * `src/config/schema.ts:google_accounts` key validator. Defense in
 * depth — the broker can't assume the schema has already filtered
 * (admin clients sending raw protocol frames bypass schema).
 */
export function validateGoogleAccountLabel(account: string): void {
  if (typeof account !== "string" || account.length === 0) {
    throw new Error(`Google account label must be a non-empty string`);
  }
  if (account !== account.trim()) {
    throw new Error(`Google account label must not have leading/trailing whitespace`);
  }
  // Reject control characters explicitly. `\s` in JS regex matches
  // ASCII/Unicode whitespace but NOT `\x00` (null) or other control
  // chars, so a label like `"alice\0@example.com"` would slip through
  // the email-shape regex below. POSIX filenames also reject null
  // bytes — defending here keeps fs ops well-formed.
  if (/[\x00-\x1f\x7f]/.test(account)) {
    throw new Error(`Google account label '${account.replace(/[\x00-\x1f\x7f]/g, "?")}' contains control characters; email shape rejects them.`);
  }
  // Character allowlist matches the schema regex (`[^@\s:]+@[^@\s:]+\.[^@\s:]+`).
  // No path separators, no `..`, no whitespace, no `:` (which the
  // broker's slot-key parser uses).
  if (!/^[^@\s:/\\]+@[^@\s:/\\]+\.[^@\s:/\\]+$/.test(account)) {
    throw new Error(
      `Google account label '${account}' is not a valid email shape. Expected like 'alice@example.com' (no slashes, colons, or whitespace).`,
    );
  }
}

/**
 * Resolve the per-account directory under the broker's state dir.
 * Caller passes the broker's own stateDir (typically
 * `~/.switchroom/state/auth-broker/`).
 */
export function googleAccountDir(stateDir: string, account: string): string {
  return resolve(
    stateDir,
    "google",
    normalizeGoogleAccountForStorage(account),
  );
}

export function googleAccountCredentialsPath(
  stateDir: string,
  account: string,
): string {
  return join(googleAccountDir(stateDir, account), "credentials.json");
}

/**
 * Whether the per-account directory exists. Used by `add-account` to
 * detect "account already exists" vs "first add."
 */
export function googleAccountExists(
  stateDir: string,
  account: string,
): boolean {
  return existsSync(googleAccountCredentialsPath(stateDir, account));
}

/**
 * Read the per-account credentials.json. Returns null if absent or
 * malformed (broker treats missing/malformed as "needs add-account").
 */
export function readGoogleAccountCredentials(
  stateDir: string,
  account: string,
): GoogleCredentialsShape | null {
  const path = googleAccountCredentialsPath(stateDir, account);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<GoogleCredentialsShape>;
    if (!parsed?.googleOauth?.accessToken) return null;
    return parsed as GoogleCredentialsShape;
  } catch {
    return null;
  }
}

/**
 * Write per-account credentials.json. Creates the parent dir if
 * absent (mode 0700). File written via atomicWriteFileSync — same
 * semantics as Anthropic credential writes; survives concurrent
 * readers.
 *
 * Returns the absolute path written so callers can audit.
 */
export function writeGoogleAccountCredentials(
  stateDir: string,
  account: string,
  credentials: GoogleCredentialsShape,
): string {
  const path = googleAccountCredentialsPath(stateDir, account);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(path, JSON.stringify(credentials, null, 2), 0o600);
  return path;
}

/**
 * Delete the per-account directory + credentials. Idempotent — no
 * error if the account doesn't exist.
 */
export function removeGoogleAccount(stateDir: string, account: string): void {
  const dir = googleAccountDir(stateDir, account);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * List all Google accounts the broker has stored. Used by the
 * `list-google-accounts` op (powering `switchroom auth google account
 * list`), the refresh-tick loop (`refreshOneGoogleAccount`), and the
 * doctor.
 *
 * Reads filesystem layout, not in-memory state — operators can drop
 * a credentials.json by hand and the broker will pick it up on next
 * read (same shape as Anthropic).
 */
export function listGoogleAccounts(stateDir: string): string[] {
  const root = join(stateDir, "google");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => {
      try {
        return statSync(join(root, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .filter((name) =>
      existsSync(join(root, name, "credentials.json")),
    );
}
