/**
 * Tests for the /setup wizard state machine (setup-flow.ts).
 *
 * Pure function tests — no grammY, no SQLite, no network.
 *
 * Covers:
 *   - startSetupFlow: no slug, valid slug, invalid slug
 *   - handleSetupText: full happy-path step transitions
 *   - Validator helpers: isValidSlug, isValidPersonaName, isValidModel, isValidEmoji
 *   - Skip / cancel / error paths at each step
 *   - makeSetupInitialState / advanceSetupState / setupStepLabel helpers
 */

import { describe, it, expect } from 'vitest'
import {
  startSetupFlow,
  handleSetupText,
  makeSetupInitialState,
  advanceSetupState,
  setupStepLabel,
  isValidSlug,
  isValidPersonaName,
  isValidModel,
  isValidEmoji,
  isSkip,
  isCancel,
} from '../foreman/setup-flow.js'
import type { SetupFlowState } from '../foreman/setup-state.js'

const CALLER = '12345678'

function makeState(overrides: Partial<SetupFlowState> = {}): SetupFlowState {
  return {
    chatId: 'chat1',
    step: 'asked-slug',
    slug: null,
    persona: null,
    model: null,
    emoji: null,
    botToken: null,
    allowedUserId: null,
    startedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

// ─── isValidSlug ─────────────────────────────────────────────────────────

describe('isValidSlug', () => {
  it('accepts simple lowercase', () => expect(isValidSlug('gymbro')).toBe(true))
  it('accepts hyphens', () => expect(isValidSlug('gym-bro')).toBe(true))
  it('accepts underscores', () => expect(isValidSlug('gym_bro')).toBe(true))
  it('accepts leading digit', () => expect(isValidSlug('1agent')).toBe(true))
  it('rejects uppercase', () => expect(isValidSlug('GymBro')).toBe(false))
  it('rejects spaces', () => expect(isValidSlug('gym bro')).toBe(false))
  it('rejects empty', () => expect(isValidSlug('')).toBe(false))
  it('accepts 51-char slug', () => expect(isValidSlug('a'.repeat(51))).toBe(true))
  it('rejects 52-char slug', () => expect(isValidSlug('a'.repeat(52))).toBe(false))
})

// ─── isValidPersonaName ───────────────────────────────────────────────────

describe('isValidPersonaName', () => {
  it('accepts normal name', () => expect(isValidPersonaName('Gym Bro')).toBe(true))
  it('accepts emoji in name', () => expect(isValidPersonaName('Clerk 💼')).toBe(true))
  it('rejects empty string', () => expect(isValidPersonaName('')).toBe(false))
  it('rejects control char', () => expect(isValidPersonaName('bad\x00name')).toBe(false))
  it('rejects 81-char name', () => expect(isValidPersonaName('a'.repeat(81))).toBe(false))
  it('accepts 80-char name', () => expect(isValidPersonaName('a'.repeat(80))).toBe(true))
})

// ─── isValidModel ─────────────────────────────────────────────────────────

describe('isValidModel', () => {
  it('accepts sonnet alias', () => expect(isValidModel('sonnet')).toBe(true))
  it('accepts opus alias', () => expect(isValidModel('opus')).toBe(true))
  it('accepts haiku alias', () => expect(isValidModel('haiku')).toBe(true))
  it('accepts inherit alias', () => expect(isValidModel('inherit')).toBe(true))
  it('accepts full model ID', () => expect(isValidModel('claude-sonnet-4-5')).toBe(true))
  it('rejects spaces', () => expect(isValidModel('bad model')).toBe(false))
  it('rejects empty', () => expect(isValidModel('')).toBe(false))
})

// ─── isValidEmoji ─────────────────────────────────────────────────────────

describe('isValidEmoji', () => {
  it('accepts single emoji', () => expect(isValidEmoji('🏋️')).toBe(true))
  it('accepts simple ascii (single char)', () => expect(isValidEmoji('x')).toBe(true))
  it('rejects empty string', () => expect(isValidEmoji('')).toBe(false))
  it('rejects only whitespace', () => expect(isValidEmoji('   ')).toBe(false))
})

// ─── isSkip / isCancel ────────────────────────────────────────────────────

describe('isSkip', () => {
  it('matches "skip"', () => expect(isSkip('skip')).toBe(true))
  it('matches "s"', () => expect(isSkip('s')).toBe(true))
  it('matches "-"', () => expect(isSkip('-')).toBe(true))
  it('ignores case', () => expect(isSkip('SKIP')).toBe(true))
  it('does not match other words', () => expect(isSkip('no')).toBe(false))
})

describe('isCancel', () => {
  it('matches "cancel"', () => expect(isCancel('cancel')).toBe(true))
  it('matches "/cancel"', () => expect(isCancel('/cancel')).toBe(true))
  it('matches "abort"', () => expect(isCancel('abort')).toBe(true))
  it('ignores case', () => expect(isCancel('CANCEL')).toBe(true))
  it('does not match "yes"', () => expect(isCancel('yes')).toBe(false))
})

// ─── startSetupFlow ───────────────────────────────────────────────────────

describe('startSetupFlow', () => {
  it('asks for slug when no inline arg', () => {
    const action = startSetupFlow(null)
    expect(action.kind).toBe('ask-slug')
  })

  it('asks for persona when valid inline slug given', () => {
    const action = startSetupFlow('gymbro')
    expect(action.kind).toBe('ask-persona')
    if (action.kind === 'ask-persona') expect(action.slug).toBe('gymbro')
  })

  it('returns error for invalid inline slug', () => {
    const action = startSetupFlow('INVALID SLUG!')
    expect(action.kind).toBe('error')
  })
})

// ─── handleSetupText: cancel at any step ─────────────────────────────────

describe('handleSetupText: cancel', () => {
  const steps = [
    'asked-slug', 'asked-persona', 'asked-model', 'asked-emoji',
    'asked-bot-token', 'confirming-allowlist',
  ] as const

  for (const step of steps) {
    it(`cancels at step ${step}`, () => {
      const state = makeState({ step, slug: 'gymbro', persona: 'Gym Bro' })
      const action = handleSetupText({ state, text: 'cancel', callerId: CALLER })
      expect(action.kind).toBe('cancel')
      if (action.kind === 'cancel') expect(action.reason).toBe('user-cancelled')
    })
  }
})

// ─── handleSetupText: null state ──────────────────────────────────────────

describe('handleSetupText: null state', () => {
  it('returns cancel with no-active-flow reason', () => {
    const action = handleSetupText({ state: null, text: 'gymbro', callerId: CALLER })
    expect(action.kind).toBe('cancel')
    if (action.kind === 'cancel') expect(action.reason).toBe('no-active-flow')
  })
})

// ─── handleSetupText: step asked-slug ────────────────────────────────────

describe('handleSetupText: asked-slug', () => {
  it('advances to ask-persona on valid slug', () => {
    const state = makeState({ step: 'asked-slug' })
    const action = handleSetupText({ state, text: 'gymbro', callerId: CALLER })
    expect(action.kind).toBe('ask-persona')
    if (action.kind === 'ask-persona') expect(action.slug).toBe('gymbro')
  })

  it('returns error on invalid slug', () => {
    const state = makeState({ step: 'asked-slug' })
    const action = handleSetupText({ state, text: 'BAD SLUG', callerId: CALLER })
    expect(action.kind).toBe('error')
    if (action.kind === 'error') expect(action.stayInStep).toBe(true)
  })
})

// ─── handleSetupText: step asked-persona ─────────────────────────────────

describe('handleSetupText: asked-persona', () => {
  it('advances to ask-model on valid persona', () => {
    const state = makeState({ step: 'asked-persona', slug: 'gymbro' })
    const action = handleSetupText({ state, text: 'Gym Bro', callerId: CALLER })
    expect(action.kind).toBe('ask-model')
    if (action.kind === 'ask-model') {
      expect(action.slug).toBe('gymbro')
      expect(action.persona).toBe('Gym Bro')
    }
  })

  it('returns error on empty persona', () => {
    const state = makeState({ step: 'asked-persona', slug: 'gymbro' })
    const action = handleSetupText({ state, text: '', callerId: CALLER })
    expect(action.kind).toBe('error')
  })
})

// ─── handleSetupText: step asked-model ───────────────────────────────────

describe('handleSetupText: asked-model', () => {
  it('advances to ask-emoji with skip', () => {
    const state = makeState({ step: 'asked-model', slug: 'gymbro', persona: 'Gym Bro' })
    const action = handleSetupText({ state, text: 'skip', callerId: CALLER })
    expect(action.kind).toBe('ask-emoji')
    if (action.kind === 'ask-emoji') expect(action.model).toBeNull()
  })

  it('advances to ask-emoji with valid model', () => {
    const state = makeState({ step: 'asked-model', slug: 'gymbro', persona: 'Gym Bro' })
    const action = handleSetupText({ state, text: 'sonnet', callerId: CALLER })
    expect(action.kind).toBe('ask-emoji')
    if (action.kind === 'ask-emoji') expect(action.model).toBe('sonnet')
  })

  it('returns error on model string with spaces', () => {
    const state = makeState({ step: 'asked-model', slug: 'gymbro', persona: 'Gym Bro' })
    // Spaces are not allowed in model IDs
    const action = handleSetupText({ state, text: 'bad model name', callerId: CALLER })
    expect(action.kind).toBe('error')
    if (action.kind === 'error') expect(action.stayInStep).toBe(true)
  })
})

// ─── handleSetupText: step asked-emoji ───────────────────────────────────

describe('handleSetupText: asked-emoji', () => {
  it('advances to ask-bot-token with skip', () => {
    const state = makeState({ step: 'asked-emoji', slug: 'gymbro', persona: 'Gym Bro', model: 'sonnet' })
    const action = handleSetupText({ state, text: 'skip', callerId: CALLER })
    expect(action.kind).toBe('ask-bot-token')
    if (action.kind === 'ask-bot-token') expect(action.emoji).toBeNull()
  })

  it('advances to ask-bot-token with emoji', () => {
    const state = makeState({ step: 'asked-emoji', slug: 'gymbro', persona: 'Gym Bro', model: null })
    const action = handleSetupText({ state, text: '🏋️', callerId: CALLER })
    expect(action.kind).toBe('ask-bot-token')
    if (action.kind === 'ask-bot-token') expect(action.emoji).toBe('🏋️')
  })
})

// ─── handleSetupText: step asked-bot-token ───────────────────────────────

describe('handleSetupText: asked-bot-token', () => {
  it('advances to confirm-allowlist with valid token shape', () => {
    const state = makeState({
      step: 'asked-bot-token',
      slug: 'gymbro',
      persona: 'Gym Bro',
      model: null,
      emoji: null,
    })
    const action = handleSetupText({ state, text: '1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxx', callerId: CALLER })
    expect(action.kind).toBe('confirm-allowlist')
    if (action.kind === 'confirm-allowlist') expect(action.callerId).toBe(CALLER)
  })

  it('returns error on bad token shape', () => {
    const state = makeState({
      step: 'asked-bot-token',
      slug: 'gymbro',
      persona: 'Gym Bro',
    })
    const action = handleSetupText({ state, text: 'notavalidtoken', callerId: CALLER })
    expect(action.kind).toBe('error')
    if (action.kind === 'error') expect(action.stayInStep).toBe(true)
  })

  it('returns cancel when slug or persona is missing', () => {
    const state = makeState({
      step: 'asked-bot-token',
      slug: null,
      persona: null,
    })
    const action = handleSetupText({ state, text: '1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxx', callerId: CALLER })
    expect(action.kind).toBe('cancel')
  })
})

// ─── handleSetupText: step confirming-allowlist ───────────────────────────

describe('handleSetupText: confirming-allowlist', () => {
  const baseState = makeState({
    step: 'confirming-allowlist',
    slug: 'gymbro',
    persona: 'Gym Bro',
    model: null,
    emoji: null,
    botToken: '1234567890:AAHxxxxxxxxxxxxxxxxxxxxxxx',
  })

  it('advances to call-reconcile on "yes"', () => {
    const action = handleSetupText({ state: baseState, text: 'yes', callerId: CALLER })
    expect(action.kind).toBe('call-reconcile')
    if (action.kind === 'call-reconcile') {
      expect(action.allowedUserId).toBe(CALLER)
      expect(action.slug).toBe('gymbro')
      expect(action.persona).toBe('Gym Bro')
    }
  })

  it('advances to call-reconcile on "y"', () => {
    const action = handleSetupText({ state: baseState, text: 'y', callerId: CALLER })
    expect(action.kind).toBe('call-reconcile')
    if (action.kind === 'call-reconcile') expect(action.allowedUserId).toBe(CALLER)
  })

  it('uses custom user_id when not "yes"', () => {
    const action = handleSetupText({ state: baseState, text: '99999999', callerId: CALLER })
    expect(action.kind).toBe('call-reconcile')
    if (action.kind === 'call-reconcile') expect(action.allowedUserId).toBe('99999999')
  })
})

// ─── handleSetupText: terminal steps ─────────────────────────────────────

describe('handleSetupText: terminal steps', () => {
  it('returns cancel for reconciling step', () => {
    const state = makeState({ step: 'reconciling' })
    const action = handleSetupText({ state, text: 'anything', callerId: CALLER })
    expect(action.kind).toBe('cancel')
  })

  it('returns cancel for done step', () => {
    const state = makeState({ step: 'done' })
    const action = handleSetupText({ state, text: 'anything', callerId: CALLER })
    expect(action.kind).toBe('cancel')
  })
})

// ─── makeSetupInitialState ────────────────────────────────────────────────

describe('makeSetupInitialState', () => {
  it('sets step to asked-slug when no slug', () => {
    const s = makeSetupInitialState('chat1', null)
    expect(s.step).toBe('asked-slug')
    expect(s.slug).toBeNull()
  })

  it('sets step to asked-persona when slug provided', () => {
    const s = makeSetupInitialState('chat1', 'gymbro')
    expect(s.step).toBe('asked-persona')
    expect(s.slug).toBe('gymbro')
  })
})

// ─── advanceSetupState ────────────────────────────────────────────────────

describe('advanceSetupState', () => {
  it('merges updates and bumps updatedAt', () => {
    const original = makeState({ updatedAt: 1000 })
    const advanced = advanceSetupState(original, { step: 'asked-persona', slug: 'gymbro' })
    expect(advanced.step).toBe('asked-persona')
    expect(advanced.slug).toBe('gymbro')
    expect(advanced.chatId).toBe(original.chatId)
    expect(advanced.updatedAt).toBeGreaterThanOrEqual(original.updatedAt)
  })
})

// ─── setupStepLabel ───────────────────────────────────────────────────────

describe('setupStepLabel', () => {
  const cases: [import('../foreman/setup-state.js').SetupFlowStep, string][] = [
    ['asked-slug', 'waiting for agent slug'],
    ['asked-persona', 'waiting for persona name'],
    ['asked-model', 'waiting for model choice'],
    ['asked-emoji', 'waiting for emoji'],
    ['asked-bot-token', 'waiting for BotFather token'],
    ['confirming-allowlist', 'waiting for allowlist confirmation'],
    ['reconciling', 'provisioning agent'],
    ['done', 'done'],
  ]
  for (const [step, expected] of cases) {
    it(`labels ${step} correctly`, () => expect(setupStepLabel(step)).toBe(expected))
  }
})
