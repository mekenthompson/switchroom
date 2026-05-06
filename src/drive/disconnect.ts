/**
 * Drive disconnect / killswitch path per RFC C §4.3.
 *
 * Order of operations matters: revoke locally FIRST so a Google API outage
 * cannot leave the agent with a live refresh token in vault. Best-effort
 * Google revoke runs after; failure is surfaced but does NOT block local
 * cleanup.
 *
 * Composes the OAuth `revokeRefreshToken()` helper with the vault-slot
 * `deleteSlots()` helper. Returned record tells the caller (CLI, killswitch
 * orchestrator) what happened so the user can be told "we cleared it on our
 * end, but Google's revoke endpoint failed — visit
 * myaccount.google.com/permissions to be sure."
 */

import { revokeRefreshToken } from "./oauth.js";
import { deleteSlots, readRefreshToken } from "./vault-slots.js";

export interface DisconnectResult {
  /** The agent slug we disconnected. */
  agent_unit: string;
  /** True iff the local vault slots were removed (or were already absent). */
  local_revoked: boolean;
  /**
   * `ok` — Google's revoke endpoint accepted the token (or already rejected
   *        it as invalid, which we count as "consistent").
   * `failed` — Google rejected the revoke for an unexpected reason.
   * `skipped` — there was no refresh token to revoke (slot already empty).
   */
  google_revoke: "ok" | "failed" | "skipped";
  google_revoke_detail?: string;
}

export async function disconnectDrive(args: {
  passphrase: string;
  vaultPath: string;
  agentUnit: string;
  fetchImpl?: typeof fetch;
}): Promise<DisconnectResult> {
  const result: DisconnectResult = {
    agent_unit: args.agentUnit,
    local_revoked: false,
    google_revoke: "skipped",
  };

  // Read FIRST (so we have the token to send to Google), then delete locally
  // before contacting Google. If the network call hangs or fails, the local
  // state is still cleaned up — which is what the killswitch promises.
  let refreshToken: string | null = null;
  try {
    refreshToken = readRefreshToken({
      passphrase: args.passphrase,
      vaultPath: args.vaultPath,
      agentUnit: args.agentUnit,
    });
  } catch {
    refreshToken = null;
  }

  deleteSlots({
    passphrase: args.passphrase,
    vaultPath: args.vaultPath,
    agentUnit: args.agentUnit,
  });
  result.local_revoked = true;

  if (refreshToken) {
    const r = await revokeRefreshToken(refreshToken, args.fetchImpl);
    if (r.ok) {
      result.google_revoke = "ok";
    } else {
      result.google_revoke = "failed";
      result.google_revoke_detail = `${r.status}: ${r.detail}`;
    }
  }

  return result;
}
