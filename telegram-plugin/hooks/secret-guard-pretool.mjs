#!/usr/bin/env node
/**
 * PreToolUse hook — blocks any tool call whose input contains a currently-
 * active vault value verbatim. Second-line defense: if a secret slips past
 * the Telegram-plugin detector (e.g. Claude synthesized it, or it came from
 * another channel), this catches it before the tool fires.
 *
 * Claude Code PreToolUse protocol (v1):
 *   Input:  JSON on stdin — { session_id, tool_name, tool_input, ... }
 *   Output: exit 0 + empty stdout → allow.
 *           exit 0 + JSON on stdout with `decision: "block"` + `reason` → block.
 *
 * This script requires the vault passphrase via SWITCHROOM_VAULT_PASSPHRASE;
 * without it we fail-open (allow) rather than blocking every tool call.
 * The justification is pragmatic — the Telegram plugin only caches the
 * passphrase in memory for 30 min, but the Stop hook needs the vault too,
 * so the agent is expected to run with the env var set in production.
 */

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function loadVaultValues() {
  const pp = process.env.SWITCHROOM_VAULT_PASSPHRASE
  if (!pp) return []
  try {
    const cli = process.env.SWITCHROOM_CLI_PATH ?? 'switchroom'
    const keysOut = execFileSync(cli, ['vault', 'list'], { encoding: 'utf8', timeout: 5000 })
    const keys = keysOut.split('\n').map((k) => k.trim()).filter(Boolean)
    const values = []
    for (const k of keys) {
      try {
        const v = execFileSync(cli, ['vault', 'get', k], { encoding: 'utf8', timeout: 5000 }).trim()
        if (v.length >= 8) values.push({ key: k, value: v })
      } catch {
        /* skip — kind=files etc. */
      }
    }
    return values
  } catch {
    return []
  }
}

function scanToolInput(toolInput, vaultValues) {
  const haystack = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput ?? '')
  for (const v of vaultValues) {
    if (haystack.includes(v.value)) return v
  }
  return null
}

function main() {
  const raw = readStdin().trim()
  if (!raw) {
    process.exit(0)
  }
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    process.exit(0)
  }
  const toolInput = event.tool_input
  if (toolInput == null) {
    process.exit(0)
  }
  const vaultValues = loadVaultValues()
  if (vaultValues.length === 0) {
    // Fail-open when we can't read the vault — don't break the session.
    process.exit(0)
  }
  const hit = scanToolInput(toolInput, vaultValues)
  if (hit) {
    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason: `tool_input contains a vaulted secret — reference it as vault:${hit.key} instead`,
      }),
    )
    process.exit(0)
  }
  process.exit(0)
}

main()
