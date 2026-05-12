/**
 * Tests for the sandbox-hint-posttool hook (Layer 2 of the sandbox UX work).
 *
 * Hook contract:
 *   stdin:  PostToolUse JSON event { tool_name, tool_response, ... }
 *   stdout: optional JSON
 *             {"hookSpecificOutput":{"hookEventName":"PostToolUse",
 *              "additionalContext":"..."}}
 *   exit:   0 always.
 *
 * Tests spawn the hook as a subprocess (mirroring how Claude Code invokes
 * it), feed a tool_response, and assert whether additionalContext was
 * emitted and that it carries the load-bearing strings the agent needs.
 */

import { describe, it, expect } from 'bun:test'
import { join } from 'path'
import { spawnSync } from 'child_process'

const HOOK_SCRIPT = join(import.meta.dir, '..', 'hooks', 'sandbox-hint-posttool.mjs')

function runHook(event: object) {
  const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: process.env,
    timeout: 5_000,
  })
  return result
}

function parseContext(stdout: string): string | null {
  if (!stdout.trim()) return null
  const parsed = JSON.parse(stdout)
  return parsed?.hookSpecificOutput?.additionalContext ?? null
}

describe('sandbox-hint-posttool', () => {
  it('emits sandbox hint when tool_response contains EROFS', () => {
    const result = runHook({
      tool_name: 'Write',
      tool_use_id: 'toolu_001',
      tool_response: {
        error: "EROFS: read-only file system, open '/opt/switchroom/skills/foo.md'",
      },
    })

    expect(result.status).toBe(0)
    const ctx = parseContext(result.stdout)
    expect(ctx).not.toBeNull()
    expect(ctx).toContain('Sandbox boundary hit')
    expect(ctx).toContain('operator action')
    expect(ctx).toContain('Writable paths')
  })

  it('emits sandbox hint when tool_response contains "Read-only file system"', () => {
    const result = runHook({
      tool_name: 'Edit',
      tool_use_id: 'toolu_002',
      tool_response: 'mkdir: cannot create directory: Read-only file system',
    })

    expect(result.status).toBe(0)
    const ctx = parseContext(result.stdout)
    expect(ctx).toContain('Sandbox boundary hit')
  })

  it('emits an apt-specific hint when tool_response shows dpkg permission denied', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_use_id: 'toolu_003',
      tool_response: {
        stderr:
          'E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), are you root?',
      },
    })

    expect(result.status).toBe(0)
    const ctx = parseContext(result.stdout)
    expect(ctx).toContain('docker/Dockerfile.agent')
    expect(ctx).toContain('rebuild')
  })

  it('emits a hint for EACCES on a rootfs path', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_use_id: 'toolu_004',
      tool_response: 'npm ERR! EACCES: permission denied, mkdir "/usr/lib/node_modules/foo"',
    })

    expect(result.status).toBe(0)
    const ctx = parseContext(result.stdout)
    expect(ctx).toContain('Sandbox boundary hit')
  })

  it('emits nothing when tool_response is a normal success', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_use_id: 'toolu_005',
      tool_response: { stdout: 'hello world\n', exit_code: 0 },
    })

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })

  it('emits nothing when tool_response merely mentions /usr but is not a sandbox error', () => {
    // Guard against false positives — the agent may legitimately discuss
    // paths under /usr in normal output (e.g. `which node` returning
    // /usr/local/bin/node). Only EACCES / EROFS patterns should trigger.
    const result = runHook({
      tool_name: 'Bash',
      tool_use_id: 'toolu_006',
      tool_response: { stdout: '/usr/local/bin/node\n' },
    })

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })

  it('exits 0 on malformed stdin without crashing', () => {
    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: 'not json at all',
      encoding: 'utf8',
      timeout: 5_000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })

  it('exits 0 on empty stdin', () => {
    const result = spawnSync(process.execPath, [HOOK_SCRIPT], {
      input: '',
      encoding: 'utf8',
      timeout: 5_000,
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })

  it('caps the scan window for huge tool_response payloads', () => {
    // 100 KiB of harmless output followed by an EROFS — we cap at 64 KiB
    // so this should NOT match. Keeps a runaway tool_response from
    // pinning the hook on a regex scan.
    const huge = 'x'.repeat(100 * 1024) + ' EROFS happened'
    const result = runHook({
      tool_name: 'Bash',
      tool_use_id: 'toolu_007',
      tool_response: { stdout: huge },
    })

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toBe('')
  })
})
