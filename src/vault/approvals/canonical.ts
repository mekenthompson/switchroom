/**
 * Canonicalize an approver set for drift-revocation comparison (RFC §5.1).
 *
 * Inputs are arbitrary `allowFrom`-style string lists (Telegram user_ids,
 * usernames, etc). Two equivalent sets must produce byte-identical strings;
 * the reverse must also hold. We normalize each entry with NFC, sort
 * lexicographically, and JSON-encode with no whitespace.
 *
 * NOT cryptographic. The string is compared with `===` only.
 */
export function canonicalizeApproverSet(approvers: readonly string[]): string {
  const normalized = approvers
    .map((a) => a.normalize("NFC").trim())
    .filter((a) => a.length > 0);
  // Sort + dedupe in one pass so callers don't have to remember to dedupe.
  const unique = Array.from(new Set(normalized)).sort();
  return JSON.stringify(unique);
}
