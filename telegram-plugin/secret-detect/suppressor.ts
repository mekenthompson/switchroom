/**
 * Context-based suppressor — downgrades or suppresses hits that look like
 * examples, fixtures, or test data based on nearby keywords.
 *
 * Spec: if any of `test`, `mock`, `example`, `fixture`, `dummy` appears as a
 * whole word within 40 characters of the matched secret, mark the hit as
 * `suppressed`. The caller decides how to treat suppressed hits — typically
 * they become "ambiguous" (ask, don't auto-store) rather than "confirmed".
 */
const MARKERS = ['test', 'mock', 'example', 'fixture', 'dummy']
const WINDOW = 40

// Pre-compile a single regex for all markers as whole words.
const MARKER_RE = new RegExp(`\\b(?:${MARKERS.join('|')})\\b`, 'i')

export function isSuppressed(text: string, start: number, end: number): boolean {
  const left = Math.max(0, start - WINDOW)
  const right = Math.min(text.length, end + WINDOW)
  const context = text.slice(left, start) + text.slice(end, right)
  return MARKER_RE.test(context)
}
