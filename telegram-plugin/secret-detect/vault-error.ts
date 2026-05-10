/**
 * Vault CLI error classification (issue #969 P0b).
 *
 * `switchroom vault` emits stable stderr markers + exit codes when it
 * detects a failure mode the Telegram gateway should surface with
 * specific UX rather than a raw pre-block of error text. This module
 * parses those markers (introduced in #971 / P0a) and translates them
 * into a structured result the gateway can render against.
 *
 * Markers (from `src/cli/vault.ts`):
 *
 *   VAULT-SANDBOX-CONTEXT     (exit 7) — direct vault file IO is
 *                                       unavailable inside an agent
 *                                       container; the requested verb
 *                                       has no broker equivalent.
 *
 *   VAULT-NEEDS-APPROVAL      (exit 5) — agent tried to write to a key
 *                                       that doesn't exist yet. Broker
 *                                       PUT cannot introduce new keys;
 *                                       operator approval is required.
 *                                       (P1a will wire up an inline
 *                                       approval card; until then we
 *                                       surface the host-CLI hint.)
 *
 *   VAULT-BROKER-UNREACHABLE  (exit 6) — broker socket missing/dead;
 *                                       operator needs to inspect on
 *                                       the host.
 *
 *   VAULT-BROKER-DENIED       (exit 2) — broker reachable but ACL or
 *                                       grant refused; operator needs
 *                                       to add an explicit grant.
 */

export type VaultCliErrorKind =
  | "sandbox_context"
  | "needs_approval"
  | "broker_unreachable"
  | "broker_denied"
  | "other";

export interface VaultCliError {
  kind: VaultCliErrorKind;
  /** The original stderr text (kept for fallback rendering / audit log). */
  original: string;
  /**
   * Best-effort extraction of the affected key name, if surfaced by the
   * marker. Used to compose host-CLI hints like
   * `switchroom vault set <key>`.
   */
  key?: string;
}

const MARKER_TO_KIND: ReadonlyArray<readonly [string, VaultCliErrorKind]> = [
  ["VAULT-SANDBOX-CONTEXT", "sandbox_context"],
  ["VAULT-NEEDS-APPROVAL", "needs_approval"],
  ["VAULT-BROKER-UNREACHABLE", "broker_unreachable"],
  ["VAULT-BROKER-DENIED", "broker_denied"],
];

/**
 * Classify a vault-CLI stderr blob into a structured error. Returns
 * `kind: "other"` when no recognized marker is present — caller should
 * fall back to a raw pre-block.
 *
 * Key extraction is marker-aware. The four markers don't all surface
 * the key the same way:
 *
 *   VAULT-NEEDS-APPROVAL [unknown_key]: secret '<KEY>' does not …
 *   VAULT-BROKER-DENIED  [<CODE>]: agent '<AGENT>' is not in the
 *                          allow list for key '<KEY>'
 *   VAULT-SANDBOX-CONTEXT: … 'switchroom vault set <KEY>' on the host.
 *
 * A naïve "first single-quoted token" regex would grab the agent name
 * for broker_denied. Prefer the token after a `key '` anchor when the
 * marker is broker_denied / needs_approval; for sandbox_context the
 * gateway supplies the key directly via verbHint (extraction here is
 * best-effort and may stay undefined).
 */
export function parseVaultCliError(stderr: string): VaultCliError {
  const text = stderr ?? "";
  for (const [marker, kind] of MARKER_TO_KIND) {
    if (text.includes(marker)) {
      const key = extractKey(text, kind);
      return { kind, original: text, key };
    }
  }
  return { kind: "other", original: text };
}

function extractKey(text: string, kind: VaultCliErrorKind): string | undefined {
  // Prefer the explicit `key '<X>'` anchor when present — it's the
  // unambiguous form used in broker_denied's stderr.
  const anchored = text.match(/key '([A-Za-z0-9_.-]+)'/);
  if (anchored) return anchored[1];

  // needs_approval: `secret '<X>' does not …` is the canonical form;
  // the only other quoted token in that message is the agent name in
  // the suggestion clause (which is never present today, but guard
  // against drift).
  if (kind === "needs_approval") {
    const m = text.match(/secret '([A-Za-z0-9_.-]+)'/);
    if (m) return m[1];
  }

  // Fall back to first single-quoted token, skipping the
  // `'switchroom vault …'` hint that sandbox_context emits.
  const allQuoted = [...text.matchAll(/'([^']+)'/g)];
  for (const m of allQuoted) {
    const candidate = m[1];
    if (candidate.includes("switchroom")) continue;
    if (!/^[A-Za-z0-9_.-]+$/.test(candidate)) continue;
    return candidate;
  }
  return undefined;
}

export interface VaultErrorRendering {
  /** Telegram HTML message (no surrounding decoration). */
  html: string;
  /**
   * When true, the gateway should NOT print the raw stderr blob — the
   * rendered message already conveys the actionable next step. When
   * false (kind="other"), the gateway should append the original
   * output in a <pre> block as before.
   */
  suppressRaw: boolean;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Compose the user-facing Telegram HTML for a parsed vault error.
 *
 * @param err       Result from parseVaultCliError.
 * @param verbHint  Optional descriptor of the in-progress action used
 *                  to compose the host-side command suggestion (e.g.
 *                  "set", "remove", "init").
 */
export function renderVaultCliError(
  err: VaultCliError,
  verbHint: { verb: "set" | "get" | "list" | "init" | "remove" | "save"; key?: string } = { verb: "set" },
): VaultErrorRendering {
  // The gateway always knows which key the user was acting on for
  // get/set/remove — prefer that over the parser's best-effort
  // extraction so a renderer mistake can't surface the wrong key in
  // the host command suggestion (e.g. an agent name from a
  // broker_denied message). Fall back to parser extraction only when
  // the gateway didn't pass a key (e.g. list).
  const key = verbHint.key ?? err.key;
  switch (err.kind) {
    case "sandbox_context":
      return {
        suppressRaw: true,
        html:
          `⚠️ <b>This action must run on the host.</b>\n` +
          `The vault file isn't mounted inside the agent sandbox; only ` +
          `the broker socket is. Open a host shell and run:\n` +
          `<pre>switchroom vault ${verbHint.verb}${key ? ` ${htmlEscape(key)}` : ""}</pre>`,
      };
    case "needs_approval":
      return {
        suppressRaw: true,
        html:
          `⚠️ <b>New vault key — operator approval required.</b>\n` +
          (key
            ? `The agent tried to save <code>${htmlEscape(key)}</code>, but `
            : `The agent tried to save a new key, but `) +
          `agents can only rotate existing keys via the broker; introducing ` +
          `a new key needs an operator action.\n\n` +
          `For now, run on a host shell:\n` +
          `<pre>switchroom vault set${key ? ` ${htmlEscape(key)}` : " &lt;key&gt;"}</pre>\n` +
          `<i>A one-tap approval card is on the way (#969 P1a).</i>`,
      };
    case "broker_unreachable":
      return {
        suppressRaw: true,
        html:
          `⚠️ <b>Vault broker isn't reachable.</b>\n` +
          `From inside the agent sandbox there's no fallback path. ` +
          `Operator can check on the host:\n` +
          `<pre>switchroom vault broker status</pre>`,
      };
    case "broker_denied":
      return {
        suppressRaw: true,
        html:
          `⚠️ <b>Vault broker refused the request.</b>\n` +
          (key
            ? `The agent isn't authorized to access <code>${htmlEscape(key)}</code>. `
            : `The agent isn't authorized to access this key. `) +
          `Operator can grant access from a host shell:\n` +
          `<pre>switchroom vault grant &lt;agent&gt; --keys ${key ? htmlEscape(key) : "&lt;key&gt;"}</pre>`,
      };
    case "other":
      return { suppressRaw: false, html: "" };
  }
}
