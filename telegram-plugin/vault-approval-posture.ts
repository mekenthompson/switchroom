/**
 * Resolve the vault grant-card approval posture from switchroom config.
 *
 * Pre-#1115-follow-up this module also loaded the auto-unlock blob
 * (file-based on legacy installs, broker-IPC `get_unlock_passphrase`
 * on Docker) and surfaced the plaintext passphrase to the gateway so
 * it could attest mint_grant calls. The reviewer flagged that as a
 * bypass surface (claude in the same agent container could exfiltrate
 * the passphrase via /proc or broker socket). Pivoted to broker-
 * mediated attestation: the passphrase NEVER leaves the broker
 * process; the gateway just signals operator-tap intent via
 * `attest_via_posture: true` on mint_grant / list_grants.
 *
 * What this module does NOW: read `vault.broker.approvalAuth` from
 * the operator's switchroom.yaml and tell the gateway whether to
 * branch into the silent-mint code path. Nothing else.
 *
 * Behaviour:
 *  - `approvalAuth` absent / `passphrase` → passphrase posture.
 *  - `approvalAuth: telegram-id` → telegram-id posture (gateway will
 *    use attest_via_posture on broker calls).
 *  - `approvalAuth` set to anything else → passphrase posture (the
 *    schema rejects unknown values at startup; this is defence in
 *    depth in case the schema is bypassed).
 */

export interface VaultBrokerPostureConfig {
  approvalAuth?: string
}

export interface ResolvedPosture {
  mode: 'passphrase' | 'telegram-id'
}

export function resolveVaultApprovalPosture(
  broker: VaultBrokerPostureConfig | undefined,
): ResolvedPosture {
  if (broker?.approvalAuth === 'telegram-id') {
    return { mode: 'telegram-id' }
  }
  return { mode: 'passphrase' }
}
