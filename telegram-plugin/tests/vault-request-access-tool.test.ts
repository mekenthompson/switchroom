/**
 * Pin the agent-initiated vault ACL request flow shipped in #1012.
 *
 * Regressions guarded here:
 *   1. `vault_request_access` MCP tool dropping from bridge.ts schema
 *      (the agent would lose the tool with no compile-time signal).
 *   2. `vault_request_access` missing from the gateway's ALLOWED_TOOLS
 *      set (bridge would emit it but gateway would 403 with
 *      `tool not allowed`).
 *   3. The `vra:` callback prefix losing its dispatcher branch (taps
 *      on [Approve] / [Deny] silently fall through to the trailing
 *      "unknown callback" arm).
 *   4. The 90-day TTL ceiling and `read|write` scope shape — both are
 *      part of the threat model (agents can't request perpetual or
 *      undefined-scope grants).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const bridgeSrc = readFileSync(
  resolve(__dirname, '..', 'bridge', 'bridge.ts'),
  'utf-8',
)
const gatewaySrc = readFileSync(
  resolve(__dirname, '..', 'gateway', 'gateway.ts'),
  'utf-8',
)

describe('vault_request_access (#1012)', () => {
  it('bridge advertises the tool to MCP clients', () => {
    // fails when: the schema is removed from TOOL_SCHEMAS — agents
    // running the new tool will hit a generic "unknown tool" path
    // before they ever see the gateway.
    expect(bridgeSrc).toContain("name: 'vault_request_access'")
  })

  it('bridge schema declares the threat-model-critical fields', () => {
    // fails when: a refactor drops `scope` (defaults to read) or
    // `duration` (caps requested TTL at 90d). Both gates are part of
    // the agent-can-only-request-not-mint boundary described in #1012.
    const block = bridgeSrc.split("name: 'vault_request_access'")[1]?.split("name: '")[0] ?? ''
    expect(block).toContain("'read'")
    expect(block).toContain("'write'")
    expect(block).toMatch(/duration/)
    // Required fields: chat_id + key. Value is NOT required (this is
    // an access request, not a save — the agent doesn't have the
    // value, it wants permission to read it).
    expect(block).toMatch(/required:\s*\[\s*'chat_id',\s*'key'\s*\]/)
  })

  it('gateway accepts vault_request_access in ALLOWED_TOOLS', () => {
    // fails when: the ALLOWED_TOOLS set is touched and the entry
    // gets dropped. Bridge would forward the call and the gateway
    // would reject with `tool not allowed`.
    expect(gatewaySrc).toMatch(/ALLOWED_TOOLS[\s\S]*?'vault_request_access'/)
  })

  it('gateway routes vault_request_access in executeToolCall', () => {
    // fails when: the switch arm is dropped. Tool would be accepted
    // by ALLOWED_TOOLS but fall through to the `unknown tool` branch.
    expect(gatewaySrc).toMatch(/case\s+'vault_request_access':\s*\n\s*return\s+executeVaultRequestAccess/)
  })

  it('gateway dispatches vra: callback prefix', () => {
    // fails when: the callback_query dispatcher loses the `vra:`
    // branch. Operator taps on [Approve] / [Deny] would fall to the
    // catch-all "unknown callback" path and the card would stay
    // open forever.
    expect(gatewaySrc).toMatch(/data\.startsWith\('vra:'\)/)
    expect(gatewaySrc).toMatch(/handleVaultRequestAccessCallback/)
  })

  it('approve handler mints via broker (not direct grants.db write)', () => {
    // fails when: someone tries to short-circuit by writing to the
    // grants DB directly. The broker is the single point of grant
    // issuance — bypassing it skips audit-log emission and breaks
    // the path-as-identity ACL contract.
    const handlerBlock = gatewaySrc.split('async function handleVaultRequestAccessCallback')[1]?.split('async function handleVaultRequestSaveCallback')[0] ?? ''
    expect(handlerBlock).toMatch(/mintGrantViaBroker/)
    // Description string must carry the audit breadcrumb so post-hoc
    // forensics can tell agent-initiated grants apart from
    // operator-host-CLI grants and from /vault audit one-tap grants.
    expect(handlerBlock).toMatch(/vault_request_access/)
    expect(handlerBlock).toMatch(/#1012/)
  })

  it('duration parser enforces the 90-day ceiling', () => {
    // fails when: the cap is removed or widened without a corresponding
    // doc/threat-model update. Agent-initiated grants must have a
    // finite sunset; "never" must be refused outright.
    const execBlock = gatewaySrc.split('async function executeVaultRequestAccess')[1]?.split('async function ')[0] ?? ''
    expect(execBlock).toMatch(/NINETY_DAYS/)
    expect(execBlock).toMatch(/90\s*\*\s*86400/)
  })

  it('approve handler is gated on the operator allowFrom list', () => {
    // fails when: the access check is dropped. Without this gate any
    // chat member could approve a grant — breaks the operator-only
    // mint authority that's load-bearing for #1012's threat model.
    const handlerBlock = gatewaySrc.split('async function handleVaultRequestAccessCallback')[1]?.split('async function handleVaultRequestSaveCallback')[0] ?? ''
    expect(handlerBlock).toMatch(/loadAccess\(\)/)
    expect(handlerBlock).toMatch(/allowFrom\.includes/)
  })
})
