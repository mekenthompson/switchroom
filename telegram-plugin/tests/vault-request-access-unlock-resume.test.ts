/**
 * Contract pin for the tap-to-unlock-and-approve flow added on top of
 * #1012 Phase 2 (#1030 broker passphrase-attested mint_grant).
 *
 * Before this PR: tapping Approve on a vault_request_access card
 * without first unlocking the vault edited the card to "🔒 Vault is
 * locked. Run /vault unlock... then ask the agent to re-issue." The
 * operator had to (a) clear that card, (b) /vault unlock, (c) ask
 * the agent to re-emit the request, (d) tap Approve again. Four steps
 * for one decision.
 *
 * After this PR: the cache-miss tap keeps the card open, prompts for
 * the passphrase as the next message, captures+caches it, deletes the
 * passphrase message from chat, then auto-resumes the mint. One tap
 * + one reply = one grant.
 *
 * Mirrors the `passphrase-for-deferred` flow from #44 (deferred-secret
 * card's "🔓 Unlock vault & save"). Same idiom, same trust posture.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

describe('vault_request_access — tap-to-unlock-and-approve UX', () => {
  it('declares the passphrase-for-access-approve PendingVaultOp variant', () => {
    // fails when: the new PendingVaultOp kind is dropped. The
    // resume flow leans on this discriminator — without it the
    // text handler can't route the passphrase reply back to the
    // staged request.
    expect(gatewaySrc).toMatch(/kind:\s*['"]passphrase-for-access-approve['"]/)
  })

  it('Approve on a locked vault stages a passphrase prompt instead of clearing the card', () => {
    // fails when: the cache-miss branch reverts to the old behaviour
    // of editing the card to "ask the agent to re-issue." That UX
    // is the four-step workaround we just replaced.
    //
    // Anchor: the approve-action block inside handleVaultRequestAccessCallback.
    const approveBlock =
      gatewaySrc.split('if (action === \'approve\')')[1]?.split('await ctx.answerCallbackQuery({ text: \'Unknown action\'')[0] ?? ''
    expect(approveBlock).toMatch(/pendingVaultOps\.set/)
    expect(approveBlock).toMatch(/passphrase-for-access-approve/)
    // Card text must invite a passphrase reply, not punt to a
    // /vault unlock detour.
    expect(approveBlock).toMatch(/Reply with your passphrase/i)
    // The "ask the agent to re-issue the request card" copy belonged
    // to the pre-fix path. Should be gone from the cache-miss branch.
    expect(approveBlock).not.toMatch(/ask the agent to re-issue the request card/)
  })

  it('passphrase intercept deletes the chat message and resumes mint', () => {
    // fails when: the new pending-op handler stops calling
    // deleteSensitiveMessage on the passphrase message OR stops
    // routing into performVaultAccessApproval. Both are load-bearing:
    //   - delete: prevents the passphrase from lingering in chat history
    //   - resume: closes the "one decision" UX promise
    //
    // Anchor: the text-handler branch keyed on the new kind.
    const handlerBlock =
      gatewaySrc
        .split("pendingVault.kind === 'passphrase-for-access-approve'")[1]
        ?.split("pendingVault.kind === 'grant-wizard'")[0] ?? ''
    expect(handlerBlock).toMatch(/deleteSensitiveMessage/)
    expect(handlerBlock).toMatch(/performVaultAccessApproval/)
    // Cache the passphrase so future operations in the same chat
    // don't re-prompt within the TTL window.
    expect(handlerBlock).toMatch(/vaultPassphraseCache\.set/)
  })

  it('expired-stage path edits the card cleanly, does not silently drop', () => {
    // fails when: the resume path forgets to handle the edge case
    // where the staged access entry's 10-min TTL elapsed between
    // tap-on-locked and passphrase reply. Without this branch the
    // operator types their passphrase, gets nothing visible back,
    // and is confused about whether their secret leaked.
    const handlerBlock =
      gatewaySrc
        .split("pendingVault.kind === 'passphrase-for-access-approve'")[1]
        ?.split("pendingVault.kind === 'grant-wizard'")[0] ?? ''
    expect(handlerBlock).toMatch(/expired before you replied|expired/)
    expect(handlerBlock).toMatch(/editMessageText/)
  })

  it('mint failure (e.g. wrong passphrase) edits the card; does not silent-drop', () => {
    // fails when: performVaultAccessApproval's error branch returns
    // without editing the card. Without the edit, a wrong-passphrase
    // attempt leaves the locked-vault prompt on screen forever and
    // the operator can't tell whether the system saw their reply.
    //
    // Anchor: performVaultAccessApproval's `result.kind === 'error'`
    // branch.
    const mintHelper =
      gatewaySrc.split('async function performVaultAccessApproval')[1]?.split('async function handleVaultRequestAccessCallback')[0] ?? ''
    expect(mintHelper).toMatch(/result\.kind === 'error'/)
    // After error: card edited AND pending entry dropped (no
    // zombie staged request).
    expect(mintHelper).toMatch(/editMessageText[\s\S]{0,400}mint_grant failed/)
    expect(mintHelper).toMatch(/pendingVaultRequestAccesses\.delete/)
  })
})
