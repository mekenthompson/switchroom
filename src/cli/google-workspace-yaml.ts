/**
 * YAML editor for the top-level `google_workspace:` block.
 *
 * Pure module — string-in / string-out — so the CLI can read the
 * existing file, mutate, and atomic-write the result without losing
 * comments or surrounding formatting. Mirrors the pattern in
 * `auth-active-yaml.ts` / `google-accounts-yaml.ts`.
 *
 * One caller today: the `switchroom auth google connect` onboarding
 * wizard, which writes the block after vaulting the OAuth client
 * id/secret. The wizard already refuses to run when the block exists;
 * the never-clobber guard here is defense-in-depth + makes the
 * function idempotent and independently testable.
 */

import { parseDocument, isMap } from "yaml";

export interface GoogleWorkspaceBlock {
  /** Vault ref or literal for the OAuth client id, e.g. `vault:google-oauth-client-id`. */
  clientIdRef: string;
  /** Vault ref or literal for the OAuth client secret. */
  clientSecretRef: string;
  /** ≥1 Telegram numeric user id authorized to approve Drive onboarding. */
  approvers: number[];
  /** Upstream MCP tool tier. */
  tier: "core" | "extended" | "complete";
}

/**
 * Add a `google_workspace:` block to the YAML text. Returns the input
 * verbatim (byte-equal) when a `google_workspace:` OR the legacy
 * `drive:` alias key already exists — the loader treats `drive:` as
 * the same block, so clobbering either would silently drop operator
 * config. Caller owns the atomic-write + mode preservation.
 */
export function setGoogleWorkspaceBlock(
  yamlText: string,
  block: GoogleWorkspaceBlock,
): string {
  if (!block.clientIdRef || !block.clientSecretRef) {
    throw new Error(
      "setGoogleWorkspaceBlock: clientIdRef and clientSecretRef are required",
    );
  }
  if (!Array.isArray(block.approvers) || block.approvers.length === 0) {
    throw new Error(
      "setGoogleWorkspaceBlock: at least one approver id is required",
    );
  }

  const doc = parseDocument(yamlText);
  const root = doc.contents;
  if (!isMap(root)) {
    throw new Error("setGoogleWorkspaceBlock: YAML root is not a map");
  }

  // Never clobber an existing block (canonical key or legacy alias).
  if (root.has("google_workspace") || root.has("drive")) {
    return yamlText;
  }

  doc.set("google_workspace", {
    google_client_id: block.clientIdRef,
    google_client_secret: block.clientSecretRef,
    approvers: block.approvers,
    tier: block.tier,
  });

  const out = String(doc);
  return out.endsWith("\n") ? out : out + "\n";
}
