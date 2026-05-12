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
 * The source-text contracts (same shape as the unlock-resume suite next
 * door) guard wiring stays in the gateway file. The negative-path
 * resolver test covers the refuse-to-boot behaviour at runtime.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveVaultApprovalPosture } from '../vault-approval-posture.js'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

// Anchor the approve-branch slice on `handleVaultRequestAccessCallback`
// so it's robust against future occurrences of `action === 'approve'`
// elsewhere in the file.
function sliceAccessApproveBlock(): string {
  const fn =
    gatewaySrc.split('async function handleVaultRequestAccessCallback')[1]?.split('async function')[0] ?? ''
  return fn.split("if (action === 'approve')")[1]?.split("await ctx.answerCallbackQuery({ text: 'Unknown action'")[0] ?? ''
}

describe('vault grant approval posture — module-level wiring', () => {
  it('declares the posture mode and auto-unlock passphrase holders', () => {
    expect(gatewaySrc).toMatch(/let VAULT_APPROVAL_AUTH_MODE:\s*['"]passphrase['"]\s*\|\s*['"]telegram-id['"]/)
    expect(gatewaySrc).toMatch(/let AUTO_UNLOCK_PASSPHRASE:\s*string\s*\|\s*null/)
  })

  it('initialises posture from switchroom config at startup', () => {
    expect(gatewaySrc).toMatch(/function initVaultApprovalPosture/)
    // wired into the startup IIFE
    expect(gatewaySrc).toMatch(/initVaultApprovalPosture\(\)/)
    // delegates to the resolver helper (testable in isolation)
    expect(gatewaySrc).toMatch(/resolveVaultApprovalPosture\(/)
  })
})

describe('handleVaultRequestAccessCallback — posture branch', () => {
  it('mints directly without prompting when posture is telegram-id', () => {
    const approveBlock = sliceAccessApproveBlock()
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
    const approveBlock = sliceAccessApproveBlock()
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

describe('resolveVaultApprovalPosture — runtime behaviour', () => {
  it('returns the passphrase default when approvalAuth is unset', () => {
    const result = resolveVaultApprovalPosture(undefined, () => {
      throw new Error('reader must not be called for passphrase posture')
    })
    expect(result.mode).toBe('passphrase')
    expect(result.passphrase).toBeNull()
  })

  it('returns the passphrase default when approvalAuth is explicitly passphrase', () => {
    const result = resolveVaultApprovalPosture({ approvalAuth: 'passphrase' }, () => {
      throw new Error('reader must not be called for passphrase posture')
    })
    expect(result.mode).toBe('passphrase')
    expect(result.passphrase).toBeNull()
  })

  it('loads the blob and returns telegram-id posture on success', () => {
    const result = resolveVaultApprovalPosture(
      { approvalAuth: 'telegram-id', autoUnlockCredentialPath: '/tmp/fake-blob' },
      (path) => {
        expect(path).toBe('/tmp/fake-blob')
        return 'unlock-secret'
      },
      { HOME: '/home/test' },
    )
    expect(result.mode).toBe('telegram-id')
    expect(result.passphrase).toBe('unlock-secret')
    expect(result.credPath).toBe('/tmp/fake-blob')
  })

  it('expands ~ in the credential path against env.HOME', () => {
    let seen = ''
    resolveVaultApprovalPosture(
      { approvalAuth: 'telegram-id' },
      (path) => { seen = path; return 'ok' },
      { HOME: '/home/test' },
    )
    expect(seen).toBe('/home/test/.switchroom/vault-auto-unlock')
  })

  it('THROWS when telegram-id is configured but the auto-unlock blob is unreadable — refuses to silently downgrade', () => {
    expect(() =>
      resolveVaultApprovalPosture(
        { approvalAuth: 'telegram-id', autoUnlockCredentialPath: '/nonexistent/blob' },
        () => { throw new Error('ENOENT: no such file or directory') },
      ),
    ).toThrow(/Refusing to boot/)

    // The thrown error must clearly identify the security-posture
    // mismatch so the operator knows why boot is failing.
    expect(() =>
      resolveVaultApprovalPosture(
        { approvalAuth: 'telegram-id' },
        () => { throw new Error('EACCES: permission denied') },
      ),
    ).toThrow(/approvalAuth=telegram-id but reading/)

    expect(() =>
      resolveVaultApprovalPosture(
        { approvalAuth: 'telegram-id' },
        () => { throw new Error('boom') },
      ),
    ).toThrow(/silently falling back to passphrase posture/)
  })
})
