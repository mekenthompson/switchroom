/**
 * `redact(text)` — sanitize text by replacing detected secrets and
 * credential-bearing URL parts with `[REDACTED]` markers.
 *
 * This is the chokepoint used by:
 *   - `switchroom issues record` — every code path that writes to
 *     `issues.jsonl` flows through `src/issues/store.ts:capDetail`,
 *     which calls `redact()` before truncating to `DETAIL_MAX_BYTES`.
 *     `bin/run-hook.sh` is the canonical caller; programmatic callers
 *     elsewhere in the codebase get the scrub for free.
 *   - `switchroom secret-detect redact --stdin` — bash-callable shim
 *     for ad-hoc operator use and tests. (Not on the hook hot path;
 *     each `bun` CLI fork costs ~785ms cold-start, so chaining
 *     `... | secret-detect redact | issues record` would double per-
 *     failure latency for no additional security beyond the server-
 *     side chokepoint above.)
 *
 * Threat model: any token a failing hook prints on its error path (a 401
 * echoing the bearer, a `git clone` failure showing a PAT URL, a recall.py
 * traceback echoing the LLM provider response) used to land verbatim in
 * `issues.jsonl` and surface in Telegram via the issues-card / `/issues`
 * list. This module is the choke point that prevents that.
 *
 * Detection is delegated to the existing telegram-plugin engine
 * (`telegram-plugin/secret-detect/index.ts`) — same patterns, same
 * suppressor behavior, same secretlint integration as the outbound
 * Telegram redaction path. We do NOT re-invent regexes here.
 *
 * Idempotence: for token-shape detections the marker doesn't re-match
 * (no high-entropy run, no provider prefix). For *structural* detectors
 * — `cli_flag` (`--api-key <value>`), `json_secret_field` (`"key":
 * "value"`) — a second pass over already-redacted text will replace
 * `[REDACTED:openai_api_key]` with `[REDACTED:cli_flag]`. The bytes
 * remain redacted in either case, so this is a tag-rewrite, not a
 * leak. Don't rely on `redact(redact(x)) === redact(x)` for every `x`;
 * do rely on "no detected secret bytes survive any number of passes".
 */

import {
  detectSecrets,
  redactUrls,
  type Detection,
} from "../../telegram-plugin/secret-detect/index.js";

export const REDACTED_MARKER = "[REDACTED]";

/**
 * Synchronous, fast redactor. Uses the vendored pattern engine only —
 * no secretlint (which is async). Suitable for the hot path (every
 * failing hook fires this).
 *
 * Order matters:
 *   1. URL credentials (`https://u:p@host` → `https://***@host`,
 *      sensitive query params → `?key=***`). This catches credentials
 *      that the token-shape detector wouldn't, AND normalizes them so
 *      step 2 doesn't double-redact a URL that already had its
 *      sensitive parts scrubbed.
 *   2. Token-shape detection over the URL-normalized text. We replace
 *      matched byte ranges right-to-left so earlier offsets remain
 *      valid.
 */
export function redact(text: string): string {
  if (!text || text.length === 0) return text;

  // Step 1 — URL credentials and known-sensitive query params.
  const urlScrubbed = redactUrls(text);

  // Step 2 — token shape detection over the URL-scrubbed text.
  const hits: Detection[] = detectSecrets(urlScrubbed);
  if (hits.length === 0) return urlScrubbed;

  // Apply replacements right-to-left so byte offsets stay valid.
  const sorted = [...hits].sort((a, b) => b.start - a.start);
  let out = urlScrubbed;
  for (const h of sorted) {
    // Use a rule-tagged marker so operators can identify what was
    // scrubbed without seeing the bytes. The tag is detector-controlled
    // (never user-input bytes), so it remains safe to render in
    // Telegram HTML / chat.
    out = out.slice(0, h.start) + redactedMarker(h.rule_id) + out.slice(h.end);
  }
  return out;
}

/**
 * `[REDACTED:<rule_id>]` when the rule_id is informative,
 * `[REDACTED]` otherwise. The rule_id is detector-emitted, so it
 * never contains attacker-controlled bytes — safe to embed verbatim.
 */
function redactedMarker(ruleId: string): string {
  // Strip the `kv_` / `env_` heuristic prefixes that aren't useful to
  // operators; keep provider-shape tags like `github_pat`, `openai_key`.
  const trimmed = ruleId.replace(/^(kv|env)_/, "");
  if (!trimmed || trimmed === "key_value" || trimmed === "kv_entropy") {
    return REDACTED_MARKER;
  }
  return `[REDACTED:${trimmed}]`;
}
