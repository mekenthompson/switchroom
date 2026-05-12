/**
 * inbound-classifier.ts — cheap regex classifier for inbound user text.
 *
 * Today the only signal we emit is `status_query` — short user messages
 * asking "are you still working / are you there / status?" — because that's
 * the primary KPI for the conversational turn UX redesign (see issue #1122):
 * if the user has to ask, the design has failed.
 *
 * Strictly read-only: the classifier never alters routing. Inbound text
 * still reaches the agent unchanged.
 */

/**
 * Patterns that mean "are you still working / do you remember me." Kept
 * conservative on purpose — false positives are worse than misses, because
 * a wrong-positive would noise up the very KPI we're trying to measure.
 *
 * All patterns match the entire trimmed message body (anchored), so longer
 * messages that happen to contain "status" don't trip them.
 */
const STATUS_QUERY_PATTERNS: readonly RegExp[] = [
  /^\?+$/,
  /^status\s*\??$/i,
  /^update\s*\??$/i,
  /^any\s+update\s*\??$/i,
  /^still\s+there\s*\??$/i,
  /^still\s+working\s*\??$/i,
  /^are\s+you\s+there\s*\??$/i,
  /^you\s+there\s*\??$/i,
  /^hello\s*\?+$/i,
  /^hey\s*\?+$/i,
]

export interface InboundClassification {
  isStatusQuery: boolean
}

export function classifyInbound(text: string | null | undefined): InboundClassification {
  if (text == null) return { isStatusQuery: false }
  const trimmed = text.trim()
  if (trimmed === '') return { isStatusQuery: false }
  // Cap length — a long message that starts with "status?" isn't a status
  // query; the user's appending real content. Keep the classifier focused
  // on standalone "ping" messages.
  if (trimmed.length > 40) return { isStatusQuery: false }
  for (const pat of STATUS_QUERY_PATTERNS) {
    if (pat.test(trimmed)) return { isStatusQuery: true }
  }
  return { isStatusQuery: false }
}
