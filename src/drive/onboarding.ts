/**
 * Onboarding + reconnect card builders per RFC C §5 and §4.2.
 *
 * These are pure structure-builders — the real Telegram emit lives in
 * the gateway plugin (telegram-plugin/gateway/approval-card.ts). The CLI
 * `switchroom drive connect <agent>` command calls into the kernel via
 * `approvalRequest()` from src/vault/approvals/client.ts using the
 * structures returned here as the request payload, then waits for the
 * decision through the same pending/granted flow as any other approval.
 *
 * RFC C §5 spells out three options:
 *   1. Allow my Drive (read-only) — recommended (writes the kernel grant
 *      `doc:gdrive:**` action `read`)
 *   2. Allow specific folder — deferred-folder-picker, currently surfaces
 *      a "paste a folder ID" prompt; see §6 (folder picker is out of
 *      scope, so this option is intentionally low-key)
 *   3. Per-doc prompts — writes nothing; future doc accesses each go
 *      through requestApproval. Copy warns "20+ prompts on day 1".
 *
 * The fourth option (Cancel) is rendered by the gateway as a standard
 * deny button.
 */

import { scopeFor, actionGrammar, type DriveAction } from "./grants.js";

export type OnboardingChoice =
  | { kind: "allow_drive_read" }
  | { kind: "allow_folder"; folder_id: string }
  | { kind: "per_doc" }
  | { kind: "cancel" };

export interface OnboardingCardSpec {
  agent: string;
  surface: "mcp:gdrive";
  /** Top-level scope used for the onboarding card itself (system-level). */
  scope: "system:onboarding:gdrive";
  action_grammar: "onboard";
  body: string;
  options: Array<{
    label: string;
    choice: OnboardingChoice;
    /** Scope to write on selection (null for `cancel` and `per_doc`). */
    grant_scope: string | null;
    grant_action: DriveAction | null;
  }>;
}

export function buildOnboardingCard(agent: string): OnboardingCardSpec {
  return {
    agent,
    surface: "mcp:gdrive",
    scope: "system:onboarding:gdrive",
    action_grammar: "onboard",
    body:
      `Google Drive enabled for ${agent}.\n\n` +
      `Most users pick "Allow my Drive" — one tap now, then it just works.\n` +
      `"Per-doc approval" prompts you for every single file the agent opens ` +
      `(20+ prompts in the first hour is typical). Pick that only if you ` +
      `want a tap-by-tap audit trail.`,
    options: [
      {
        label: "✅ Allow my Drive (read-only) — recommended",
        choice: { kind: "allow_drive_read" },
        grant_scope: scopeFor({ kind: "all" }, "read"),
        grant_action: "read",
      },
      {
        label: "📁 Allow specific folder (paste folder ID)",
        // The folder ID is filled in by the gateway when this option is
        // tapped; the spec here is a template.
        choice: { kind: "allow_folder", folder_id: "<pending>" },
        grant_scope: null, // deferred — gateway prompts for folder ID
        grant_action: "read",
      },
      {
        label: "🔒 Per-doc approval — high-touch, high-friction",
        choice: { kind: "per_doc" },
        grant_scope: null,
        grant_action: null,
      },
      {
        label: "❌ Cancel — don't enable Drive",
        choice: { kind: "cancel" },
        grant_scope: null,
        grant_action: null,
      },
    ],
  };
}

export interface ReconnectCardSpec {
  agent: string;
  surface: "system";
  scope: "system:reconnect:gdrive";
  action_grammar: "reconnect_drive";
  body: string;
  /** What the [Reconnect] / [Disconnect permanently] buttons run. */
  options: Array<{
    label: string;
    action: "reconnect" | "disconnect";
  }>;
}

export function buildReconnectCard(agent: string, detail?: string): ReconnectCardSpec {
  const detailLine = detail ? `\n\nGoogle said: ${detail}` : "";
  return {
    agent,
    surface: "system",
    scope: "system:reconnect:gdrive",
    action_grammar: "reconnect_drive",
    body:
      `Drive disconnected — reconnect ${agent}?\n\n` +
      `The refresh token Google issued has been rotated or revoked. ` +
      `This usually means the password changed or the app's access was ` +
      `removed in the Google Account dashboard.${detailLine}`,
    options: [
      { label: "🔁 Reconnect", action: "reconnect" },
      { label: "🚫 Disconnect permanently", action: "disconnect" },
    ],
  };
}
