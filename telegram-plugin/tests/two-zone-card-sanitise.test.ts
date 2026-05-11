/**
 * P1 of #662 — renderer output never reintroduces raw absolute paths
 * or bearer-shaped tokens. Most coverage lives in fleet-state.test.ts;
 * this asserts the *renderer* basenames/redacts via the FleetMember's
 * sanitised values (i.e. it doesn't re-pull from raw input anywhere).
 */

import { describe, it, expect } from 'vitest'
import { renderTwoZoneCard } from '../two-zone-card.js'
import type { FleetMember } from '../fleet-state.js'
import type { ProgressCardState } from '../progress-card.js'

const baseState: ProgressCardState = {
  turnStartedAt: 1,
  items: [],
  narratives: [],
  stage: 'run',
  thinking: false,
  subAgents: new Map(),
  pendingAgentSpawns: new Map(),
  tasks: [],
}

function fm(over: Partial<FleetMember>): FleetMember {
  return {
    agentId: 'aaaaaaaaaaaa',
    role: 'agent',
    startedAt: 0,
    toolCount: 1,
    lastActivityAt: 1000,
    lastTool: null,
    status: 'running',
    terminalAt: null,
    errorSeen: false,
    originatingTurnKey: 'k',
    ...over,
  }
}

describe('two-zone-card sanitise', () => {
  // Post-#861 the fleet row no longer renders the sanitisedArg at all
  // (the row shows a humanized verb phrase like "Reading file" or
  // "Running command" instead). These tests collapse to a stronger
  // assertion: the renderer can't leak secret paths/bearer tokens no
  // matter what shape the sanitisedArg takes, because that field
  // doesn't reach the output.
  it('does not contain raw absolute path even if sanitisedArg leaked one (defense-in-depth)', () => {
    const fleet = new Map([['a', fm({
      // Deliberately pass an *un*sanitised value here to assert the
      // renderer can't be tricked into leaking it.
      lastTool: { name: 'Read', sanitisedArg: '/etc/secrets/foo.key' },
    })]])
    const out = renderTwoZoneCard({ state: baseState, fleet, now: 2000 })
    expect(out).not.toContain('/etc/secrets')
    expect(out).not.toContain('foo.key')
    // The row should still surface that *some* file read happened.
    expect(out).toContain('Reading file')
  })

  it('does not contain bearer-shaped tokens even if sanitisedArg leaked one', () => {
    const fleet = new Map([['a', fm({
      lastTool: { name: 'Bash', sanitisedArg: 'curl -H "Authorization: Bearer abc123def456ghi789jkl" https://api' },
    })]])
    const out = renderTwoZoneCard({ state: baseState, fleet, now: 2000 })
    expect(out).not.toMatch(/Bearer\s+[A-Za-z0-9]{16,}/)
    expect(out).not.toContain('abc123def456ghi789jkl')
    // The row should still surface that *some* command ran.
    expect(out).toContain('Running command')
  })
})
