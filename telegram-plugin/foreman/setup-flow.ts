/**
 * Pure /setup wizard state machine.
 *
 * Walks the user through creating a new agent entirely from Telegram:
 *   asked-slug       → ask for the agent slug (e.g. "gymbro")
 *   asked-persona    → ask for the persona display name (e.g. "Gym Bro")
 *   asked-model      → ask which Claude model to use (or skip for default)
 *   asked-emoji      → ask for a topic emoji (or skip)
 *   asked-bot-token  → user creates a bot via BotFather and pastes the token
 *   confirming-allowlist → confirm the calling user_id is the allowed user
 *   reconciling      → foreman provisions + starts the agent (orchestrator step)
 *   done
 *
 * This module is pure: no grammY, no SQLite, no network calls.
 * foreman.ts interprets the returned actions and executes side-effects.
 *
 * Deferral notes in foreman.ts:
 *   // TODO(#<issue>): BotFather auto-flow — currently user creates bot manually
 *   // TODO(#<issue>): OAuth code paste step — currently manual terminal instruction
 *   // TODO(#<issue>): Skills selector — currently shows placeholder message
 */

import type { SetupFlowState, SetupFlowStep } from './setup-state.js'

// ─── Action types ────────────────────────────────────────────────────────

export type SetupFlowAction =
  | { kind: 'ask-slug' }
  | { kind: 'ask-persona'; slug: string }
  | { kind: 'ask-model'; slug: string; persona: string }
  | { kind: 'ask-emoji'; slug: string; persona: string; model: string | null }
  | { kind: 'ask-profile'; slug: string; persona: string; model: string | null; emoji: string | null; profiles: string[] }
  | { kind: 'ask-bot-token'; slug: string; persona: string; model: string | null; emoji: string | null; profile: string }
  | { kind: 'confirm-allowlist'; slug: string; callerId: string }
  // Pre-fix this was call-reconcile (single-step that did createAgent inline +
  // told the user to run `switchroom auth code` from a terminal). Split per
  // #189/#190 into call-create-agent (returns loginUrl) → asked-oauth-code
  // (collects the code via Telegram) → call-complete-creation (runs the
  // submit + starts the agent).
  | { kind: 'call-create-agent'; slug: string; persona: string; model: string | null; emoji: string | null; profile: string; botToken: string; allowedUserId: string }
  | { kind: 'ask-oauth-code'; slug: string; loginUrl: string | null }
  | { kind: 'call-complete-creation'; slug: string; persona: string; code: string }
  | { kind: 'done'; slug: string; botUsername: string | null }
  | { kind: 'error'; message: string; stayInStep: boolean }
  | { kind: 'cancel'; reason: string }

// ─── Validation helpers ───────────────────────────────────────────────────

/** Agent slug: same rules as assertSafeAgentName */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,50}$/.test(slug)
}

/** Persona name: 1-80 printable chars, no control characters */
export function isValidPersonaName(name: string): boolean {
  return name.length >= 1 && name.length <= 80 && !/[\x00-\x1f\x7f]/.test(name)
}

/** Known short model aliases and full IDs we accept */
const KNOWN_MODEL_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'inherit'])

/** Model: alphanumeric with . _ - / [ ] : only, or short alias */
export function isValidModel(model: string): boolean {
  return KNOWN_MODEL_ALIASES.has(model.toLowerCase()) ||
    /^[a-zA-Z0-9][a-zA-Z0-9._\-/[\]:]*$/.test(model)
}

/** Emoji: one or two Unicode grapheme clusters (rough check) */
export function isValidEmoji(emoji: string): boolean {
  const trimmed = emoji.trim()
  return trimmed.length >= 1 && trimmed.length <= 16
}

/** Skip keywords */
export function isSkip(text: string): boolean {
  const t = text.trim().toLowerCase()
  return t === 'skip' || t === 's' || t === '-'
}

/** Cancel keywords */
export function isCancel(text: string): boolean {
  const t = text.trim().toLowerCase()
  return t === '/cancel' || t === 'cancel' || t === 'abort'
}

// ─── Flow entry point ────────────────────────────────────────────────────

/**
 * Start a new /setup wizard. Optionally pre-fills slug from inline arg.
 */
export function startSetupFlow(
  inlineSlug: string | null,
): SetupFlowAction {
  if (!inlineSlug) {
    return { kind: 'ask-slug' }
  }

  if (!isValidSlug(inlineSlug)) {
    return {
      kind: 'error',
      message: `"${inlineSlug}" is not a valid agent slug. Use lowercase letters, numbers, hyphens or underscores (max 51 chars).`,
      stayInStep: false,
    }
  }

  return { kind: 'ask-persona', slug: inlineSlug }
}

// ─── Step transition ──────────────────────────────────────────────────────

export interface SetupStepInput {
  state: SetupFlowState | null
  text: string
  /** The Telegram user_id of the foreman caller (used for allowlist confirmation). */
  callerId: string
  /** Available profile names — passed through to the asked-profile step.
   *  Foreman calls listAvailableProfiles() and forwards the list. */
  profiles: string[]
}

/**
 * Given the current state and user text, compute the next action.
 * Returns 'cancel' with reason='user-cancelled' when the user types /cancel.
 */
export function handleSetupText(input: SetupStepInput): SetupFlowAction {
  const { state, text, callerId, profiles } = input
  const trimmed = text.trim()

  if (!state) {
    return { kind: 'cancel', reason: 'no-active-flow' }
  }

  // Global cancel at any step
  if (isCancel(trimmed)) {
    return { kind: 'cancel', reason: 'user-cancelled' }
  }

  switch (state.step) {
    case 'asked-slug': {
      if (!isValidSlug(trimmed)) {
        return {
          kind: 'error',
          message: `"${trimmed}" is not a valid agent slug. Use lowercase letters, numbers, hyphens or underscores (max 51 chars). Try again:`,
          stayInStep: true,
        }
      }
      return { kind: 'ask-persona', slug: trimmed }
    }

    case 'asked-persona': {
      const slug = state.slug ?? trimmed
      if (!isValidPersonaName(trimmed)) {
        return {
          kind: 'error',
          message: 'Persona name must be 1-80 printable characters. Try again:',
          stayInStep: true,
        }
      }
      return { kind: 'ask-model', slug, persona: trimmed }
    }

    case 'asked-model': {
      const slug = state.slug ?? ''
      const persona = state.persona ?? ''
      if (isSkip(trimmed)) {
        // Use default model
        return { kind: 'ask-emoji', slug, persona, model: null }
      }
      if (!isValidModel(trimmed)) {
        return {
          kind: 'error',
          message: `Unknown model "${trimmed}". Use <code>sonnet</code>, <code>opus</code>, <code>haiku</code>, a full model ID, or <code>skip</code> for the default:`,
          stayInStep: true,
        }
      }
      return { kind: 'ask-emoji', slug, persona, model: trimmed }
    }

    case 'asked-emoji': {
      const slug = state.slug ?? ''
      const persona = state.persona ?? ''
      const model = state.model ?? null
      const emoji = isSkip(trimmed) ? null : trimmed
      if (!isSkip(trimmed) && !isValidEmoji(trimmed)) {
        return {
          kind: 'error',
          message: 'Emoji must be 1-16 characters. Try again, or type <code>skip</code>:',
          stayInStep: true,
        }
      }
      // #190: gate on the profile selector before bot-token. The previous
      // wizard skipped straight to bot-token and hard-coded profile='default'.
      return { kind: 'ask-profile', slug, persona, model, emoji, profiles }
    }

    case 'asked-profile': {
      // #190: validate against the live list passed in by the foreman.
      if (!profiles.includes(trimmed)) {
        return {
          kind: 'error',
          message: `Unknown profile "${escapeForMessage(trimmed)}". Choose one of: ${profiles.join(', ')}`,
          stayInStep: true,
        }
      }
      const slug = state.slug ?? ''
      const persona = state.persona ?? ''
      const model = state.model ?? null
      const emoji = state.emoji ?? null
      if (!slug || !persona) {
        return { kind: 'cancel', reason: 'missing-slug-or-persona' }
      }
      return { kind: 'ask-bot-token', slug, persona, model, emoji, profile: trimmed }
    }

    case 'asked-bot-token': {
      const slug = state.slug ?? ''
      const persona = state.persona ?? ''
      // Basic bot token shape check
      if (!trimmed.includes(':') || trimmed.length < 20) {
        return {
          kind: 'error',
          message: "That doesn't look like a BotFather token (expected <code>1234567890:AAH...</code>). Try again:",
          stayInStep: true,
        }
      }
      if (!slug || !persona) {
        return { kind: 'cancel', reason: 'missing-slug-or-persona' }
      }
      return { kind: 'confirm-allowlist', slug, callerId }
    }

    case 'confirming-allowlist': {
      const slug = state.slug ?? ''
      const persona = state.persona ?? ''
      const model = state.model ?? null
      const emoji = state.emoji ?? null
      // #190: profile is captured in asked-profile. Default to 'default' for
      // legacy in-flight flows that started before the selector was added —
      // they pre-date the schema migration and have profile=null.
      const profile = state.profile ?? 'default'
      const botToken = state.botToken ?? ''
      const allowedUserId = trimmed.toLowerCase() === 'yes' || trimmed.toLowerCase() === 'y'
        ? callerId
        : trimmed // let the user override with a different user_id

      if (!allowedUserId) {
        return {
          kind: 'error',
          message: 'Please reply <b>yes</b> to use your own user_id, or paste a different user_id:',
          stayInStep: true,
        }
      }
      // #189: was 'call-reconcile' (createAgent + send-to-terminal); now
      // 'call-create-agent' which returns loginUrl so we can ask for the
      // OAuth code in-wizard. completeCreation runs in the next state.
      return { kind: 'call-create-agent', slug, persona, model, emoji, profile, botToken, allowedUserId }
    }

    case 'asked-oauth-code': {
      // #189: collect the OAuth code pasted by the user and pass it to
      // call-complete-creation. Same shape as the create-flow's equivalent.
      const slug = state.slug ?? ''
      const persona = state.persona ?? ''
      if (!slug) return { kind: 'cancel', reason: 'missing-slug' }
      if (trimmed.length < 4) {
        return {
          kind: 'error',
          message: 'That code looks too short. Paste the full code from the browser:',
          stayInStep: true,
        }
      }
      return { kind: 'call-complete-creation', slug, persona, code: trimmed }
    }

    case 'reconciling':
      // Should not receive text during reconciliation — foreman handles this step programmatically
      return { kind: 'cancel', reason: 'unexpected-text-in-reconciling' }

    case 'done':
      return { kind: 'cancel', reason: 'flow-already-done' }

    default: {
      const _exhaustive: never = state.step
      return { kind: 'cancel', reason: `unknown-step:${String(_exhaustive)}` }
    }
  }
}

/** Tiny HTML-escape for inline error messages. The foreman renders these
 *  via switchroomReply with html: true, so user-supplied text needs the
 *  same escape pass the rest of the wizard does. */
function escapeForMessage(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ─── State factory helpers ────────────────────────────────────────────────

export function makeSetupInitialState(
  chatId: string,
  slug: string | null,
): SetupFlowState {
  const now = Date.now()
  return {
    chatId,
    step: slug ? 'asked-persona' : 'asked-slug',
    slug,
    persona: null,
    model: null,
    emoji: null,
    profile: null,
    botToken: null,
    allowedUserId: null,
    authSessionName: null,
    loginUrl: null,
    startedAt: now,
    updatedAt: now,
  }
}

export function advanceSetupState(
  state: SetupFlowState,
  updates: Partial<Omit<SetupFlowState, 'chatId' | 'startedAt'>>,
): SetupFlowState {
  return {
    ...state,
    ...updates,
    updatedAt: Date.now(),
  }
}

/** Human-readable step label for resume messages. */
export function setupStepLabel(step: SetupFlowStep): string {
  switch (step) {
    case 'asked-slug': return 'waiting for agent slug'
    case 'asked-persona': return 'waiting for persona name'
    case 'asked-model': return 'waiting for model choice'
    case 'asked-emoji': return 'waiting for emoji'
    case 'asked-profile': return 'waiting for profile selection'
    case 'asked-bot-token': return 'waiting for BotFather token'
    case 'confirming-allowlist': return 'waiting for allowlist confirmation'
    case 'reconciling': return 'provisioning agent'
    case 'asked-oauth-code': return 'waiting for OAuth code'
    case 'done': return 'done'
  }
}
