/**
 * Context-based suppressor — downgrades hits that look like examples,
 * fixtures, or test data based on nearby keywords.
 *
 * Spec: if any of `test`, `mock`, `example`, `fixture`, `dummy` appears as a
 * whole word within 40 characters of the matched secret, mark the hit as
 * `suppressed: true`.
 *
 * IMPORTANT — suppressed does NOT mean "silent-allow":
 *   The pipeline routes `confidence: 'high' && suppressed: true` hits into
 *   the AMBIGUOUS tier (see pipeline.ts), so the user is explicitly asked
 *   `stash NAME` / `ignore` / `forget` / `rename`. We never silently pass
 *   a structured-pattern match just because the word "test" is nearby.
 *
 *   Asymmetric risk: a false-negative leaks a real credential into the
 *   agent's session log forever; a false-positive briefly redacts a fake
 *   one and the user dismisses it with a single word. We bias toward the
 *   user being the final arbiter on every structured-pattern hit.
 *
 *   See secret-detect-suppressor-no-silent-allow.test.ts for the
 *   regression contract.
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
