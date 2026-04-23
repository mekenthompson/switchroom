/**
 * Shannon entropy — bits per character of a string.
 *
 * Used as the gate for KEY=value scanning (see kv-scanner.ts). Pure,
 * deterministic, O(n). Returns 0 for empty input.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0
  const counts = new Map<string, number>()
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1)
  }
  let h = 0
  const len = s.length
  for (const c of counts.values()) {
    const p = c / len
    h -= p * Math.log2(p)
  }
  return h
}
