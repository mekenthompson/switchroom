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

// "Not a git repository" and similar tool-setup errors that aren't real failures
const TOOL_SETUP_RE =
  /not a git repository|command not found|permission denied/i

// Timeout / cancellation that the agent will retry
const TIMEOUT_RE =
  /timed? ?out|operation cancelled|aborted/i

/**
 * Returns true when a tool error text represents a benign outcome that
 * doesn't need ❌ in the UI and shouldn't trigger operator notifications.
 *
 * The text parameter is the raw tool result content (the first ~500 chars
 * are sufficient for pattern matching — callers may truncate).
 */
export function isBenignToolError(text: string): boolean {
  if (!text) return true // empty error = treat as benign
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
