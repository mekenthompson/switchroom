/**
 * Partial-reveal mask for a detected secret.
 *
 * Rule (locked spec): if length ≥ 18, show first 6 + "..." + last 4; else "***".
 * Never reveals the middle bytes, never returns a substring an attacker could
 * search for verbatim.
 */
export function maskToken(s: string): string {
  if (s.length >= 18) {
    return `${s.slice(0, 6)}...${s.slice(-4)}`
  }
  return '***'
}
