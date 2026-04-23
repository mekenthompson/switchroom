/**
 * Sliding-window chunker for ReDoS-bounded detection.
 *
 * Inputs larger than 32 KB are split into 16 KB windows with 1 KB overlap.
 * Each window is scanned independently; the caller is responsible for
 * dedupe-by-byte-offset when merging per-window hits back together.
 *
 * The overlap exists so a secret that straddles a window boundary is still
 * matched by at least one scan (provided the secret is ≤ 1 KB, which covers
 * every known token format plus typical PEM private keys).
 */

export interface Window {
  /** Start offset in the original string. */
  offset: number
  /** The window text. */
  text: string
}

export const CHUNK_THRESHOLD = 32 * 1024
export const WINDOW_SIZE = 16 * 1024
export const OVERLAP = 1024

export function chunk(text: string): Window[] {
  if (text.length <= CHUNK_THRESHOLD) {
    return [{ offset: 0, text }]
  }
  const out: Window[] = []
  let offset = 0
  while (offset < text.length) {
    const end = Math.min(offset + WINDOW_SIZE, text.length)
    out.push({ offset, text: text.slice(offset, end) })
    if (end >= text.length) break
    offset = end - OVERLAP
  }
  return out
}
