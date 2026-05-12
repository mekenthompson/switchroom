/**
 * Contract pins for the `vault.broker.approvalAuth` posture toggle.
 *
 * Behaviour:
 *   - `passphrase` (default): Approve on a grant card prompts the
 *     operator to type the vault passphrase before minting. Two-factor:
 *     Telegram ID (allowlist) + passphrase.
 *   - `telegram-id` (opt-in): Approve mints immediately using the
 *     auto-unlock-derived passphrase silently held in memory. Single-
 *     factor; the schema rejects this without `autoUnlock: true`.
 *
 * These tests are source-text contracts (same shape as the unlock-resume
 * suite next door) — they don't spin up a bot, just guard the wiring
 * stays in the file.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

describe('vault grant approval posture — module-level wiring', () => {
  it('declares the posture mode and auto-unlock passphrase holders', () => {
    expect(gatewaySrc).toMatch(/let VAULT_APPROVAL_AUTH_MODE:\s*['"]passphrase['"]\s*\|\s*['"]telegram-id['"]/)
    expect(gatewaySrc).toMatch(/let AUTO_UNLOCK_PASSPHRASE:\s*string\s*\|\s*null/)
  })

  it('initialises posture from switchroom config at startup', () => {
    expect(gatewaySrc).toMatch(/function initVaultApprovalPosture/)
    // wired into the startup IIFE
    expect(gatewaySrc).toMatch(/initVaultApprovalPosture\(\)/)
    // reads the machine-bound blob via the canonical helper
    expect(gatewaySrc).toMatch(/readAutoUnlockFile\(/)
  })
})

describe('handleVaultRequestAccessCallback — posture branch', () => {
  it('mints directly without prompting when posture is telegram-id', () => {
    const approveBlock =
      gatewaySrc
        .split("if (action === 'approve')")[1]
        ?.split("await ctx.answerCallbackQuery({ text: 'Unknown action'")[0] ?? ''
    // telegram-id branch is present before the passphrase-cache lookup
    expect(approveBlock).toMatch(/VAULT_APPROVAL_AUTH_MODE === ['"]telegram-id['"]/)
    expect(approveBlock).toMatch(/performVaultAccessApproval\(ctx, pending, stageId, senderId, AUTO_UNLOCK_PASSPHRASE\)/)
    // body says "Approved by @..." rather than "Reply with your passphrase"
    expect(approveBlock).toMatch(/Approved by @/)
  })

  it('preserves the allowlist guard regardless of posture', () => {
    const handlerBlock =
      gatewaySrc.split('async function handleVaultRequestAccessCallback')[1]?.split('async function')[0] ?? ''
    expect(handlerBlock).toMatch(/if \(!access\.allowFrom\.includes\(senderId\)\)/)
    expect(handlerBlock).toMatch(/Not authorized/)
  })

  it('leaves the passphrase-prompt path intact for the default posture', () => {
    const approveBlock =
      gatewaySrc
        .split("if (action === 'approve')")[1]
        ?.split("await ctx.answerCallbackQuery({ text: 'Unknown action'")[0] ?? ''
    // The "passphrase mode" code path (cache lookup + prompt) MUST still exist.
    // This is the regression check: passphrase posture is unchanged.
    expect(approveBlock).toMatch(/vaultPassphraseCache\.get\(pending\.chat_id\)/)
    expect(approveBlock).toMatch(/Reply with your passphrase/i)
    expect(approveBlock).toMatch(/passphrase-for-access-approve/)
  })
})

describe('performVaultAccessApproval — posture-aware card footer', () => {
  it('annotates the success card with the telegram-id footer when applicable', () => {
    const fnBlock =
      gatewaySrc
        .split('async function performVaultAccessApproval')[1]
        ?.split('async function handleVaultRequestAccessCallback')[0] ?? ''
    expect(fnBlock).toMatch(/VAULT_APPROVAL_AUTH_MODE === ['"]telegram-id['"]/)
    expect(fnBlock).toMatch(/Approver verified by Telegram identity/)
    expect(fnBlock).toMatch(/broker auto-unlocked at startup/)
  })
})

describe('handleVaultRequestSaveCallback — silent fallback in telegram-id mode', () => {
  it('uses AUTO_UNLOCK_PASSPHRASE without prompting when posture is telegram-id', () => {
    const fnBlock =
      gatewaySrc
        .split('async function handleVaultRequestSaveCallback')[1]
        ?.split('async function handleVaultDeferCallback')[0] ?? ''
    expect(fnBlock).toMatch(/VAULT_APPROVAL_AUTH_MODE === ['"]telegram-id['"]/)
    expect(fnBlock).toMatch(/AUTO_UNLOCK_PASSPHRASE/)
  })
})
