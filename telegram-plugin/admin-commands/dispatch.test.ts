import { describe, it, expect } from 'vitest'
import {
  dispatchAdminCommand,
  parseCommandName,
  parseCommandArg,
  classifyAdminGate,
  ADMIN_COMMAND_NAMES,
} from './index.js'

// ─── parseCommandName ────────────────────────────────────────────────────────

describe('parseCommandName', () => {
  it('extracts a simple command', () => {
    expect(parseCommandName('/agents')).toBe('agents')
  })

  it('strips a @botname suffix', () => {
    expect(parseCommandName('/agents@mybot')).toBe('agents')
  })

  it('ignores arguments after a space', () => {
    expect(parseCommandName('/logs 50')).toBe('logs')
  })

  it('normalises to lowercase', () => {
    expect(parseCommandName('/Agents')).toBe('agents')
  })

  it('returns null for non-slash text', () => {
    expect(parseCommandName('hello')).toBeNull()
    expect(parseCommandName('')).toBeNull()
    expect(parseCommandName('agents')).toBeNull()
  })

  it('returns an empty string for a bare slash', () => {
    expect(parseCommandName('/ ')).toBe('')
  })
})

// ─── ADMIN_COMMAND_NAMES ─────────────────────────────────────────────────────

describe('ADMIN_COMMAND_NAMES', () => {
  it('contains the fleet-management admin commands', () => {
    const required = ['agents', 'logs', 'restart', 'update', 'reconcile', 'stop', 'agentstart', 'grant', 'dangerous', 'permissions', 'vault']
    for (const cmd of required) {
      expect(ADMIN_COMMAND_NAMES.has(cmd)).toBe(true)
    }
  })

  it('does not contain per-agent auth ops (must work without model)', () => {
    // /auth, /reauth, /authfallback are handled by the gateway directly so
    // the user can re-authenticate even when the model is rate-limited or the
    // token is expired. Routing them through Claude would defeat the point.
    expect(ADMIN_COMMAND_NAMES.has('auth')).toBe(false)
    expect(ADMIN_COMMAND_NAMES.has('reauth')).toBe(false)
    expect(ADMIN_COMMAND_NAMES.has('authfallback')).toBe(false)
  })

  it('does not contain interrupt (cancellation must always work)', () => {
    expect(ADMIN_COMMAND_NAMES.has('interrupt')).toBe(false)
  })

  it('does not contain the permission-response flow', () => {
    // /approve, /deny, /pending are intercepted by the gateway before the
    // model is invoked anyway — they have nothing to do with admin gating.
    expect(ADMIN_COMMAND_NAMES.has('approve')).toBe(false)
    expect(ADMIN_COMMAND_NAMES.has('deny')).toBe(false)
    expect(ADMIN_COMMAND_NAMES.has('pending')).toBe(false)
  })

  it('does not contain info commands (must work when model is down)', () => {
    expect(ADMIN_COMMAND_NAMES.has('version')).toBe(false)
    expect(ADMIN_COMMAND_NAMES.has('doctor')).toBe(false)
    expect(ADMIN_COMMAND_NAMES.has('usage')).toBe(false)
    expect(ADMIN_COMMAND_NAMES.has('commands')).toBe(false)
  })

  it('does not contain session-reset commands', () => {
    expect(ADMIN_COMMAND_NAMES.has('new')).toBe(false)
    expect(ADMIN_COMMAND_NAMES.has('reset')).toBe(false)
  })

  it('does not contain create-agent (out of scope for phase 1)', () => {
    expect(ADMIN_COMMAND_NAMES.has('create-agent')).toBe(false)
  })

  it('does not contain legacy verbs upgrade or rebuild', () => {
    expect(ADMIN_COMMAND_NAMES.has('upgrade')).toBe(false)
    expect(ADMIN_COMMAND_NAMES.has('rebuild')).toBe(false)
  })
})

// ─── dispatchAdminCommand ────────────────────────────────────────────────────

describe('dispatchAdminCommand', () => {
  describe('when admin=true', () => {
    it('handles a known admin command', () => {
      expect(dispatchAdminCommand('/agents', true)).toEqual({ handled: true })
      expect(dispatchAdminCommand('/logs', true)).toEqual({ handled: true })
      expect(dispatchAdminCommand('/restart', true)).toEqual({ handled: true })
      expect(dispatchAdminCommand('/update', true)).toEqual({ handled: true })
      expect(dispatchAdminCommand('/vault', true)).toEqual({ handled: true })
      expect(dispatchAdminCommand('/permissions', true)).toEqual({ handled: true })
    })

    it('does NOT handle per-agent ops (auth/interrupt/info/session)', () => {
      // These are intentionally NOT admin-gated — they always run via the
      // gateway, regardless of admin status, so the user can recover when
      // the model is unreachable.
      expect(dispatchAdminCommand('/auth', true)).toEqual({ handled: false })
      expect(dispatchAdminCommand('/reauth', true)).toEqual({ handled: false })
      expect(dispatchAdminCommand('/interrupt', true)).toEqual({ handled: false })
      expect(dispatchAdminCommand('/version', true)).toEqual({ handled: false })
      expect(dispatchAdminCommand('/doctor', true)).toEqual({ handled: false })
      expect(dispatchAdminCommand('/usage', true)).toEqual({ handled: false })
      expect(dispatchAdminCommand('/new', true)).toEqual({ handled: false })
      expect(dispatchAdminCommand('/reset', true)).toEqual({ handled: false })
    })

    it('handles a known command with arguments', () => {
      expect(dispatchAdminCommand('/logs 50', true)).toEqual({ handled: true })
      expect(dispatchAdminCommand('/restart myagent', true)).toEqual({ handled: true })
    })

    it('handles a known command with @botname suffix', () => {
      expect(dispatchAdminCommand('/agents@switchroombot', true)).toEqual({ handled: true })
    })

    it('does NOT handle an unknown slash command', () => {
      expect(dispatchAdminCommand('/nope', true)).toEqual({ handled: false })
      expect(dispatchAdminCommand('/unknown-command', true)).toEqual({ handled: false })
    })

    it('does NOT handle plain text (non-slash)', () => {
      expect(dispatchAdminCommand('hello', true)).toEqual({ handled: false })
      expect(dispatchAdminCommand('show me the agents', true)).toEqual({ handled: false })
    })

    it('does NOT handle empty string', () => {
      expect(dispatchAdminCommand('', true)).toEqual({ handled: false })
    })
  })

  describe('when admin=false', () => {
    it('does NOT handle any command — all fall through to Claude', () => {
      // Belt-and-braces: even if the gateway calls the dispatcher for a known
      // admin command, it must return handled=false when admin is off.
      expect(dispatchAdminCommand('/agents', false)).toEqual({ handled: false })
      expect(dispatchAdminCommand('/logs', false)).toEqual({ handled: false })
      expect(dispatchAdminCommand('/restart', false)).toEqual({ handled: false })
      expect(dispatchAdminCommand('/nope', false)).toEqual({ handled: false })
      expect(dispatchAdminCommand('hello', false)).toEqual({ handled: false })
    })
  })
})

// ─── parseCommandArg ─────────────────────────────────────────────────────────

describe('parseCommandArg', () => {
  it('returns empty string when no arg', () => {
    expect(parseCommandArg('/restart')).toBe('')
  })
  it('returns empty string when only whitespace', () => {
    expect(parseCommandArg('/restart   ')).toBe('')
  })
  it('returns single arg', () => {
    expect(parseCommandArg('/restart foo')).toBe('foo')
  })
  it('returns multi-word arg trimmed', () => {
    expect(parseCommandArg('/restart   foo bar  ')).toBe('foo bar')
  })
  it('works with @botname suffix', () => {
    expect(parseCommandArg('/restart@bot foo')).toBe('foo')
  })
  it('returns empty string for non-slash text', () => {
    expect(parseCommandArg('hello world')).toBe('')
  })
})

// ─── classifyAdminGate ───────────────────────────────────────────────────────

describe('classifyAdminGate', () => {
  const me = 'clerk'

  it('passes through plain text', () => {
    expect(classifyAdminGate('hello there', me)).toEqual({ action: 'pass-through' })
  })

  it('passes through unknown slash commands', () => {
    expect(classifyAdminGate('/whatever', me)).toEqual({ action: 'pass-through' })
  })

  it('passes through non-admin commands', () => {
    expect(classifyAdminGate('/version', me)).toEqual({ action: 'pass-through' })
    expect(classifyAdminGate('/auth', me)).toEqual({ action: 'pass-through' })
    expect(classifyAdminGate('/new', me)).toEqual({ action: 'pass-through' })
  })

  describe('/restart', () => {
    it('passes through with no arg (self-restart)', () => {
      expect(classifyAdminGate('/restart', me)).toEqual({ action: 'pass-through' })
    })
    it('passes through with whitespace-only arg', () => {
      expect(classifyAdminGate('/restart   ', me)).toEqual({ action: 'pass-through' })
    })
    it('passes through when arg matches my agent name', () => {
      expect(classifyAdminGate('/restart clerk', me)).toEqual({ action: 'pass-through' })
    })
    it('passes through with @botname suffix and self target', () => {
      expect(classifyAdminGate('/restart@switchroombot clerk', me)).toEqual({
        action: 'pass-through',
      })
    })
    it('blocks when targeting a different agent', () => {
      expect(classifyAdminGate('/restart finn', me)).toEqual({
        action: 'block',
        reason: 'other-agent',
        cmd: 'restart',
      })
    })
    it('blocks when targeting `all`', () => {
      expect(classifyAdminGate('/restart all', me)).toEqual({
        action: 'block',
        reason: 'other-agent',
        cmd: 'restart',
      })
    })
  })

  describe('other admin commands', () => {
    it('blocks /logs with admin-required reason', () => {
      expect(classifyAdminGate('/logs', me)).toEqual({
        action: 'block',
        reason: 'admin-required',
        cmd: 'logs',
      })
    })
    it('blocks /grant with admin-required reason regardless of args', () => {
      expect(classifyAdminGate('/grant clerk telegram', me)).toEqual({
        action: 'block',
        reason: 'admin-required',
        cmd: 'grant',
      })
    })
    it('blocks /agents, /update, /vault, /permissions', () => {
      for (const c of ['agents', 'update', 'vault', 'permissions', 'stop', 'agentstart', 'reconcile', 'dangerous', 'memory', 'topics']) {
        const r = classifyAdminGate(`/${c}`, me)
        expect(r).toEqual({ action: 'block', reason: 'admin-required', cmd: c })
      }
    })
    it('handles @botname suffix', () => {
      expect(classifyAdminGate('/logs@switchroombot 50', me)).toEqual({
        action: 'block',
        reason: 'admin-required',
        cmd: 'logs',
      })
    })
  })
})
