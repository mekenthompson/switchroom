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

// ─────────────────────────────────────────────────────────────────────────
// Adversarial / load-bearing invariants (#1115 follow-up).
//
// The threat the toggle introduces: in `telegram-id` posture the ONLY check
// between a callback firing and a real vault grant being minted is the
// allowlist. Anything that runs BEFORE the allowlist check, or any handler
// that skips it, is a potential bypass.
//
// These tests pin the invariants identified by the threat-model review:
//   - allowlist check is the FIRST gate in every handler (no posture
//     branch, stage lookup, or side-effect runs before it).
//   - `handleVaultDeferCallback` honours `telegram-id` posture too (same
//     silent-mint contract as the access + save handlers).
//   - `handleVaultGrantCallback` (the operator-initiated wizard) does
//     NOT reference VAULT_APPROVAL_AUTH_MODE — flipping posture can never
//     change wizard behaviour, since the wizard requires the operator
//     to drive every step.
// ─────────────────────────────────────────────────────────────────────────

describe('allowlist is the first gate in every vault callback handler', () => {
  // Slice the body of a handler from its declaration to the next
  // `async function` boundary.
  function handlerBody(name: string): string {
    const after = gatewaySrc.split(`async function ${name}(`)[1] ?? ''
    return after.split('\nasync function ')[0] ?? ''
  }

  // The first `if (...)` block inside the handler MUST be the allowlist
  // check — i.e., it must mention `access.allowFrom.includes(senderId)`.
  // Future refactors that move stage-lookup, posture branching, or
  // `pending*` map reads above the allowlist would break this contract.
  function firstGuardOf(body: string): string {
    const idx = body.indexOf('if (')
    if (idx < 0) return ''
    // crude but sufficient: take the line containing the `if (` plus 1 line
    return body.slice(idx, body.indexOf('\n', body.indexOf('\n', idx) + 1))
  }

  for (const handler of [
    'handleVaultRequestAccessCallback',
    'handleVaultRequestSaveCallback',
    'handleVaultDeferCallback',
    'handleVaultGrantCallback',
  ]) {
    it(`${handler}: allowlist check fires before any other branching`, () => {
      const body = handlerBody(handler)
      expect(body, `expected handler ${handler} to be present`).not.toBe('')
      const firstGuard = firstGuardOf(body)
      expect(firstGuard, `first guard in ${handler}`).toMatch(
        /access\.allowFrom\.includes\(senderId\)/,
      )
    })

    it(`${handler}: no callback side-effect (mint / passphrase prompt / pendingVault* mutation) appears before the allowlist check`, () => {
      const body = handlerBody(handler)
      const beforeAllowlist = body.split('access.allowFrom.includes(senderId)')[0] ?? body
      // Things that MUST NOT appear before the allowlist gate:
      //   - mintGrantViaBroker (the actual broker mint)
      //   - performVaultAccessApproval (the wrapper that mints + edits card)
      //   - pendingVaultOps.set (would let a non-operator queue an op)
      //   - VAULT_APPROVAL_AUTH_MODE === 'telegram-id' branch
      for (const sentinel of [
        'mintGrantViaBroker',
        'performVaultAccessApproval',
        'pendingVaultOps.set',
        "VAULT_APPROVAL_AUTH_MODE === 'telegram-id'",
      ]) {
        expect(
          beforeAllowlist.includes(sentinel),
          `${handler}: sentinel "${sentinel}" must NOT appear before the allowlist check`,
        ).toBe(false)
      }
    })
  }
})

describe('handleVaultDeferCallback — telegram-id posture also mints silently', () => {
  it('uses AUTO_UNLOCK_PASSPHRASE and skips the prompt under telegram-id', () => {
    const fnBlock =
      gatewaySrc
        .split('async function handleVaultDeferCallback')[1]
        ?.split('\nasync function ')[0] ?? ''
    // The unlock branch must short-circuit with AUTO_UNLOCK_PASSPHRASE
    // BEFORE the vaultPassphraseCache lookup + pendingVaultOps prompt.
    const unlockBranch = fnBlock.split("if (action === 'unlock')")[1] ?? ''
    expect(unlockBranch).toMatch(/VAULT_APPROVAL_AUTH_MODE === ['"]telegram-id['"]/)
    expect(unlockBranch).toMatch(/AUTO_UNLOCK_PASSPHRASE/)
    // Ordering: telegram-id branch must precede the cache lookup.
    const teleIdIdx = unlockBranch.indexOf("VAULT_APPROVAL_AUTH_MODE === 'telegram-id'")
    const cacheIdx = unlockBranch.indexOf('vaultPassphraseCache.get(')
    expect(teleIdIdx, 'telegram-id branch must appear').toBeGreaterThanOrEqual(0)
    expect(cacheIdx, 'cache lookup must still appear (passphrase posture)').toBeGreaterThanOrEqual(0)
    expect(teleIdIdx).toBeLessThan(cacheIdx)
  })
})

describe('handleVaultGrantCallback (wizard) — posture cannot affect the wizard path', () => {
  it('wizard handler never references VAULT_APPROVAL_AUTH_MODE — posture flips are inert here', () => {
    const fnBlock =
      gatewaySrc
        .split('async function handleVaultGrantCallback')[1]
        ?.split('\nasync function ')[0] ?? ''
    expect(fnBlock).not.toMatch(/VAULT_APPROVAL_AUTH_MODE/)
    // And the wizard MUST NOT silently use AUTO_UNLOCK_PASSPHRASE either.
    expect(fnBlock).not.toMatch(/AUTO_UNLOCK_PASSPHRASE/)
  })
})

describe('resolveVaultApprovalPosture — adversarial / property fuzz', () => {
  // The contract under test: the resolver MUST NEVER return
  // `{ mode: 'telegram-id', passphrase: null | '' }`. Either it returns
  // a non-empty passphrase, or it throws.
  it('never returns telegram-id mode with a null/empty passphrase, across 200 randomized config + reader pairs', () => {
    const rand = mulberry32(0xdeadbeef)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!
    const approvalChoices = [undefined, 'passphrase', 'telegram-id', 'PASSPHRASE', 'telegram_id', '', 'nonsense', null]
    const pathChoices: (string | undefined)[] = [
      undefined,
      '~/.switchroom/vault-auto-unlock',
      '/tmp/x',
      '/nonexistent/blob',
      '~/empty',
      '~',
      '',
    ]
    const readerOutcomes = [
      () => 'unlock-secret',
      () => '',
      () => '   ',
      () => 'x'.repeat(2048),
      () => { throw new Error('ENOENT: no such file or directory') },
      () => { throw new Error('EACCES: permission denied') },
      () => { throw new TypeError('weird non-error') },
    ]
    for (let i = 0; i < 200; i++) {
      const broker = {
        approvalAuth: pick(approvalChoices) as string | undefined,
        autoUnlockCredentialPath: pick(pathChoices),
      } as Record<string, unknown>
      const reader = pick(readerOutcomes)
      let returned: ResolvedPostureLike | null = null
      let threw = false
      try {
        returned = resolveVaultApprovalPosture(
          broker as never,
          reader,
          { HOME: '/home/test' },
        ) as ResolvedPostureLike
      } catch {
        threw = true
      }
      if (threw) continue
      // If a value came back, it MUST satisfy the safety contract.
      expect(returned, `iter ${i}: must return a posture`).not.toBeNull()
      if (returned!.mode === 'telegram-id') {
        expect(returned!.passphrase, `iter ${i}: telegram-id mode must carry a non-empty passphrase`).toBeTruthy()
        expect(typeof returned!.passphrase).toBe('string')
        expect((returned!.passphrase as string).length).toBeGreaterThan(0)
      } else {
        // passphrase mode — passphrase field is null by construction.
        expect(returned!.mode).toBe('passphrase')
      }
    }
  })
})

interface ResolvedPostureLike {
  mode: 'passphrase' | 'telegram-id'
  passphrase: string | null
}

// Deterministic PRNG so the fuzz is reproducible across CI runs.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

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

  it('THROWS when telegram-id is configured and the auto-unlock blob is empty or whitespace — refuses to silently boot with no passphrase', () => {
    // Found by the property fuzz above: a *readable but empty* blob is
    // just as dangerous as a missing one — the gateway would silently
    // hold "" as the auto-unlock passphrase, and any Approve tap would
    // invoke the broker with an empty passphrase. Refuse to boot.
    expect(() =>
      resolveVaultApprovalPosture(
        { approvalAuth: 'telegram-id' },
        () => '',
        { HOME: '/home/test' },
      ),
    ).toThrow(/empty.*whitespace-only|whitespace-only/i)
    expect(() =>
      resolveVaultApprovalPosture(
        { approvalAuth: 'telegram-id' },
        () => '   \n\t',
        { HOME: '/home/test' },
      ),
    ).toThrow(/Refusing to boot/)
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
