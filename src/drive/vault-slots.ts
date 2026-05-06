/**
 * Vault slot helpers for RFC C §4.
 *
 * Slots:
 *   - `gdrive:<agent_unit>:refresh_token` — durable refresh token (string).
 *   - `gdrive:<agent_unit>:status` — sidecar with `connected` |
 *     `invalid_grant` | `reconnect_pending` plus a timestamp. Absent slot
 *     means "healthy / never connected" — callers must distinguish based on
 *     refresh-token presence.
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
