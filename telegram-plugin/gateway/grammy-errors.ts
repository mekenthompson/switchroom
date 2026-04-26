/**
 * Shared Grammy error classification helpers.
 *
 * These utilities are used in multiple places to classify Telegram Bot API
 * errors without repeating the `instanceof GrammyError` + `error_code` +
 * description-regex pattern inline.
 *
 * Precedent: the same classification was inlined at gateway.ts:4755 for the
 * progress-card driver. This module extracts it so boot-card.ts, gateway.ts,
 * and any future callers can share the logic.
 */

import { GrammyError } from 'grammy'

/**
 * Returns true when `err` is a GrammyError with error_code 400 and a
 * description matching "message is not modified".
 *
 * This is the error Telegram returns when `editMessageText` is called with
 * content byte-identical to the current message — a benign race condition,
 * not a real failure.
 */
export function isMessageNotModified(err: unknown): err is GrammyError {
  return (
    err instanceof GrammyError &&
    err.error_code === 400 &&
    /\bmessage is not modified\b/i.test(err.description ?? '')
  )
}

/**
 * Returns true when `err` is a GrammyError with error_code 400 and a
 * description matching "message to edit not found" or "message to delete not found".
 *
 * These occur when a message was already deleted before an edit or delete
 * attempt arrives — benign in many contexts.
 */
export function isMessageNotFound(err: unknown): err is GrammyError {
  return (
    err instanceof GrammyError &&
    err.error_code === 400 &&
    /\bmessage to (edit|delete) not found\b/i.test(err.description ?? '')
  )
}

/**
 * Returns true for known-benign Telegram Bot API errors that should be
 * absorbed silently rather than treated as unexpected failures:
 *   - "message is not modified" — duplicate edit with identical content
 *   - "message to edit/delete not found" — race with external deletion
 */
export function isBenignGrammyError(err: unknown): err is GrammyError {
  return isMessageNotModified(err) || isMessageNotFound(err)
}
