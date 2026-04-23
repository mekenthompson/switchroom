#!/usr/bin/env node
/**
 * Stop hook — scans the session transcript file at shutdown and rewrites
 * any occurrences of a vault value to `vault:${slug}`. Backs up the original
 * `.jsonl` to `.bak` before rewriting.
 *
 * Protocol:
 *   Input: JSON on stdin — { session_id, transcript_path, ... }
 *   Output: ignored; hook just runs and exits.
 *
 * Fail-open on any error. This is a best-effort cleanup, not a correctness
 * boundary — the real defense is the Telegram plugin detector preventing
 * secrets from reaching the transcript in the first place.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
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
        /* skip */
      }
    }
    return values
  } catch {
    return []
  }
}

function scrubContent(content, vaultValues) {
  let modified = false
  let out = content
  for (const { key, value } of vaultValues) {
    if (out.includes(value)) {
      // Replace with vault:slug — plain string replace, no regex (no regex
      // escaping needed, and stops weird tokens from turning into meta chars).
      const marker = `vault:${key}`
      let prev
      do {
        prev = out
        out = out.split(value).join(marker)
      } while (prev !== out && out.includes(value))
      modified = true
    }
  }
  return { out, modified }
}

function main() {
  const raw = readStdin().trim()
  if (!raw) process.exit(0)
  let event
  try {
    event = JSON.parse(raw)
  } catch {
    process.exit(0)
  }
  const transcriptPath = event.transcript_path
  if (!transcriptPath || !existsSync(transcriptPath)) process.exit(0)
  const vaultValues = loadVaultValues()
  if (vaultValues.length === 0) process.exit(0)
  let content
  try {
    content = readFileSync(transcriptPath, 'utf8')
  } catch {
    process.exit(0)
  }
  const { out, modified } = scrubContent(content, vaultValues)
  if (!modified) process.exit(0)
  try {
    copyFileSync(transcriptPath, `${transcriptPath}.bak`)
    writeFileSync(transcriptPath, out, 'utf8')
  } catch (err) {
    process.stderr.write(`[secret-scrub-stop] rewrite failed: ${err.message}\n`)
  }
  process.exit(0)
}

main()
