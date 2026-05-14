/**
 * Vault slot helpers for RFC D §4 + RFC G Phase 2.
 *
 * Two slot families coexist during the transition:
 *
 * **Legacy (RFC D §4.1)** — per-agent slots:
 *   - `gdrive:<agent_unit>:refresh_token`
 *   - `gdrive:<agent_unit>:status`
 *
 * **Canonical (RFC G §4.4)** — per-Google-account slots, ACL-gated by
 * `google_accounts.<account>.enabled_for[]` at the broker:
 *   - `google:<account_email>:refresh_token`
 *   - `google:<account_email>:status`
 *
 * The two are NOT auto-migrated. RFC G Phase 2 adds the new helpers
 * alongside the old ones; RFC G §7 Phase 2 ships an apply-time detector
 * that refuses to start the wrapper while legacy slots exist (clean
 * cutover, no compat shim — see decision #10 in
 * `share-auth-across-the-fleet.md`).
 *
 * Access tokens NEVER touch this module — they live in process memory only.
 */

import {
  setStringSecret,
  getStringSecret,
  removeSecret,
  type VaultEntryScope,
} from "../vault/vault.js";

export type DriveStatus = "connected" | "invalid_grant" | "reconnect_pending";

export interface DriveStatusRecord {
  status: DriveStatus;
  ts: number;
  detail?: string;
}

export function refreshTokenSlot(agentUnit: string): string {
  return `gdrive:${agentUnit}:refresh_token`;
}

export function statusSlot(agentUnit: string): string {
  return `gdrive:${agentUnit}:status`;
}

/**
 * Persist the refresh token. ACL grants the agent's unit only — no other
 * agent can read the token. Overwrites any prior value (no version history,
 * per §4.1 — Google may have already invalidated it).
 */
export function writeRefreshToken(args: {
  passphrase: string;
  vaultPath: string;
  agentUnit: string;
  refreshToken: string;
}): void {
  const scope: VaultEntryScope = { allow: [args.agentUnit] };
  setStringSecret(
    args.passphrase,
    args.vaultPath,
    refreshTokenSlot(args.agentUnit),
    args.refreshToken,
    undefined,
    scope,
  );
}

export function readRefreshToken(args: {
  passphrase: string;
  vaultPath: string;
  agentUnit: string;
}): string | null {
  return getStringSecret(
    args.passphrase,
    args.vaultPath,
    refreshTokenSlot(args.agentUnit),
  );
}

export function writeStatus(args: {
  passphrase: string;
  vaultPath: string;
  agentUnit: string;
  status: DriveStatus;
  detail?: string;
  now?: number;
}): void {
  const record: DriveStatusRecord = {
    status: args.status,
    ts: args.now ?? Date.now(),
    detail: args.detail,
  };
  const scope: VaultEntryScope = { allow: [args.agentUnit] };
  setStringSecret(
    args.passphrase,
    args.vaultPath,
    statusSlot(args.agentUnit),
    JSON.stringify(record),
    "json",
    scope,
  );
}

export function readStatus(args: {
  passphrase: string;
  vaultPath: string;
  agentUnit: string;
}): DriveStatusRecord | null {
  const raw = getStringSecret(
    args.passphrase,
    args.vaultPath,
    statusSlot(args.agentUnit),
  );
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DriveStatusRecord>;
    if (
      parsed &&
      typeof parsed.status === "string" &&
      typeof parsed.ts === "number"
    ) {
      return parsed as DriveStatusRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Delete BOTH the refresh-token slot and the status slot for the agent.
 * Used by `switchroom drive disconnect <agent>` and the kernel's
 * `/revoke-all` killswitch path. Idempotent — removing a missing slot is
 * not an error.
 */
export function deleteSlots(args: {
  passphrase: string;
  vaultPath: string;
  agentUnit: string;
}): void {
  try {
    removeSecret(
      args.passphrase,
      args.vaultPath,
      refreshTokenSlot(args.agentUnit),
    );
  } catch {
    /* slot was absent — that's fine */
  }
  try {
    removeSecret(args.passphrase, args.vaultPath, statusSlot(args.agentUnit));
  } catch {
    /* slot was absent — that's fine */
  }
}

// ────────────────────────────────────────────────────────────────────────
// RFC G §4.4 — per-Google-account slots, ACL-gated by google_accounts[]
// ────────────────────────────────────────────────────────────────────────

/**
 * Normalize a Google account email — lowercase, trim, no surrounding
 * whitespace. Google treats account local-parts as case-insensitive; we
 * normalize so the same account email entered with different casing
 * resolves to the same vault slot.
 */
export function normalizeGoogleAccount(account: string): string {
  return account.trim().toLowerCase();
}

export function googleAccountRefreshTokenSlot(account: string): string {
  return `google:${normalizeGoogleAccount(account)}:refresh_token`;
}

export function googleAccountStatusSlot(account: string): string {
  return `google:${normalizeGoogleAccount(account)}:status`;
}

/**
 * Persist the refresh token for a Google account. Unlike the legacy
 * per-agent slot, the entry-level scope is NOT set to a single agent —
 * the per-agent ACL lives in `config.google_accounts[<account>].enabled_for`
 * and is enforced by the broker (see `acl.ts:checkAclByAgent`).
 *
 * We pass `scope: undefined` so the entry-level scope check (`checkEntryScope`)
 * accepts any agent that passed the higher-level `checkAclByAgent` Google
 * account check. Two-layer gating: broker-level ACL (config-driven) +
 * entry-level scope (this default = open-to-all-passing-the-broker).
 */
export function writeGoogleAccountRefreshToken(args: {
  passphrase: string;
  vaultPath: string;
  account: string;
  refreshToken: string;
}): void {
  setStringSecret(
    args.passphrase,
    args.vaultPath,
    googleAccountRefreshTokenSlot(args.account),
    args.refreshToken,
    undefined,
    undefined,
  );
}

export function readGoogleAccountRefreshToken(args: {
  passphrase: string;
  vaultPath: string;
  account: string;
}): string | null {
  return getStringSecret(
    args.passphrase,
    args.vaultPath,
    googleAccountRefreshTokenSlot(args.account),
  );
}

export function writeGoogleAccountStatus(args: {
  passphrase: string;
  vaultPath: string;
  account: string;
  status: DriveStatus;
  detail?: string;
  now?: number;
}): void {
  const record: DriveStatusRecord = {
    status: args.status,
    ts: args.now ?? Date.now(),
    detail: args.detail,
  };
  setStringSecret(
    args.passphrase,
    args.vaultPath,
    googleAccountStatusSlot(args.account),
    JSON.stringify(record),
    "json",
    undefined,
  );
}

export function readGoogleAccountStatus(args: {
  passphrase: string;
  vaultPath: string;
  account: string;
}): DriveStatusRecord | null {
  const raw = getStringSecret(
    args.passphrase,
    args.vaultPath,
    googleAccountStatusSlot(args.account),
  );
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DriveStatusRecord>;
    if (
      parsed &&
      typeof parsed.status === "string" &&
      typeof parsed.ts === "number"
    ) {
      return parsed as DriveStatusRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Delete BOTH per-account slots. Used by `switchroom auth google account
 * remove <account>` (Phase 3). Idempotent.
 */
export function deleteGoogleAccountSlots(args: {
  passphrase: string;
  vaultPath: string;
  account: string;
}): void {
  try {
    removeSecret(
      args.passphrase,
      args.vaultPath,
      googleAccountRefreshTokenSlot(args.account),
    );
  } catch {
    /* slot was absent — that's fine */
  }
  try {
    removeSecret(
      args.passphrase,
      args.vaultPath,
      googleAccountStatusSlot(args.account),
    );
  } catch {
    /* slot was absent — that's fine */
  }
}

// ────────────────────────────────────────────────────────────────────────
// RFC G Phase 2 helpers — used by Phase 3's apply-time detector and the
// future wrapper launcher (drive-mcp-launcher.ts) to spot installations
// still on the legacy per-agent slot shape.
// ────────────────────────────────────────────────────────────────────────

/**
 * Pure-function classifier — given a list of vault slot names (typically
 * from `listSecrets()`), returns the agent units whose `gdrive:<unit>:
 * refresh_token` slots still exist. Empty array means "fully migrated to
 * RFC G or never used Drive."
 *
 * Phase 3 wires this into `runApplyPreflight()` (advisory-mode warning)
 * and into the wrapper launcher (hard refusal). Phase 2 just exposes the
 * helper so both consumers share one source of truth on what counts as
 * a legacy slot.
 */
export function detectLegacyGdriveSlots(slotKeys: string[]): string[] {
  const legacy: string[] = [];
  const re = /^gdrive:([^:]+):refresh_token$/;
  for (const key of slotKeys) {
    const m = key.match(re);
    if (m) legacy.push(m[1]);
  }
  return legacy;
}
