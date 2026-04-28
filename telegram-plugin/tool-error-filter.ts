/**
 * tool-error-filter.ts — severity classifier for tool_result isError events.
 *
 * Acceptance item 5: benign tool failures (no-match, file-not-found,
 * recoverable Telegram errors) don't surface as raw debug in the progress
 * card checklist. Real failures (auth, crash, network) still escalate.
 *
 * Design: pure function, no side effects, no dependencies. The gateway
 * calls isBenignToolError() on every tool_result with isError=true; when
 * it returns true, the progress-card item is marked 'done' (✅) rather
 * than 'failed' (❌) and no operator notification is raised.
 *
 * Important: this classification applies to the DISPLAY only. The agent
 * session transcript is never mutated — the raw error text still reaches
 * the model so it can reason about what happened.
 */

/**
 * Pattern groups for benign tool errors.
 *
 * These are errors that represent "no results" or "resource absent" — the
 * tool ran correctly but found nothing. Surfacing them as ❌ in the checklist
 * is noise: the user can't act on "grep found nothing" and the agent will
 * handle it in context.
 */

// File-not-found patterns (common across Bash, Read, Edit tools)
const FILE_NOT_FOUND_RE =
  /no such file or directory|file not found|path does not exist|enoent/i

// No-match patterns (grep, find, search tools)
const NO_MATCH_RE =
  /no match(es)? found|returned no results?|not found in|0 result/i

// Recoverable Telegram API patterns (message deleted, not modified, etc.)
const TELEGRAM_RECOVERABLE_RE =
  /message (is not modified|to edit not found|can't be deleted|was deleted)|MESSAGE_ID_INVALID|message not found/i

// "Not a git repository" — narrow tool-setup pattern. Earlier drafts also
// matched `command not found` and `permission denied` but those were too
// broad: a real EACCES on /etc/passwd, a real "kubectl not found" during
// a deploy, are genuine failures the user must see. Kept tight to the one
// truly-benign case (running git outside a repo).
const TOOL_SETUP_RE =
  /not a git repository/i

// Timeout / cancellation that the agent will retry. The bare `aborted`
// substring was previously included but matched DB transaction aborts,
// git merge aborts, and policy-rejection messages — all real failures.
// Dropped in favor of explicit timeout and operation-cancelled phrasing.
const TIMEOUT_RE =
  /timed? ?out|operation cancelled/i

/**
 * Returns true when a tool error text matches a known benign pattern (no
 * results / resource absent / recoverable Telegram error / explicit timeout).
 * Returns false for empty input, unknown text, or any text that doesn't
 * match a pattern.
 *
 * The function is fail-closed: empty / undefined input → false. Callers
 * that want to suppress only on positive evidence should call this directly;
 * callers that need an extra short-circuit on missing input should guard at
 * the call site with `text && isBenignToolError(text)`.
 *
 * The text parameter is the raw tool result content; the first ~500 chars
 * are sufficient for pattern matching, and callers should truncate before
 * calling for performance / event-size reasons.
 */
export function isBenignToolError(text: string): boolean {
  if (!text) return false
  return (
    FILE_NOT_FOUND_RE.test(text) ||
    NO_MATCH_RE.test(text) ||
    TELEGRAM_RECOVERABLE_RE.test(text) ||
    TOOL_SETUP_RE.test(text) ||
    TIMEOUT_RE.test(text)
  )
}

/**
 * Severity of a tool error for routing purposes.
 * - `benign`: no-match / not-found / recoverable — suppress from UI
 * - `real`: auth failure, crash, unexpected error — surface in UI
 */
export type ToolErrorSeverity = 'benign' | 'real'

export function classifyToolError(text: string): ToolErrorSeverity {
  return isBenignToolError(text) ? 'benign' : 'real'
}
