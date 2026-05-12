#!/usr/bin/env node
/**
 * PostToolUse hook — detects sandbox-related errors in tool_response and
 * injects a one-line hint via Claude Code's `hookSpecificOutput.
 * additionalContext` channel. The hint reminds the agent that the
 * read-only file system / EROFS error is the switchroom sandbox working
 * as intended, and that it should respond to the user with a concrete
 * "Operator action: ..." line rather than retrying or echoing the raw
 * kernel error.
 *
 * Pairs with the SANDBOX_GUIDANCE primer in --append-system-prompt
 * (src/agents/scaffold.ts). The primer is the always-on context; this
 * hook is the just-in-time nudge that fires only when the agent
 * actually hits the boundary.
 *
 * Claude Code PostToolUse protocol:
 *   stdin:  JSON { tool_name, tool_use_id, tool_input, tool_response, ... }
 *   stdout: optional JSON
 *             {"hookSpecificOutput":{"hookEventName":"PostToolUse",
 *              "additionalContext":"<text>"}}
 *           prepended to the model's next-turn context after the tool
 *           result is shown.
 *   exit:   0 always. Hook failures must never block the tool flow.
 *
 * Design notes:
 *   - Detection is a substring/regex match against the stringified
 *     tool_response (covers stdout, stderr, error fields).
 *   - No DB writes, no IPC. Pure stdin → stdout, fail-silent.
 *   - Idempotent: re-reading the same tool_response yields the same
 *     hint. Claude Code dedupes additionalContext naturally because the
 *     hook fires once per PostToolUse event.
 */

import { readFileSync } from 'node:fs'

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Patterns that indicate a sandbox-boundary hit, in order of specificity.
 * Each entry: [regex, hint-key]. Hint text is composed below from the
 * matched key — keeps the patterns easy to scan.
 */
const PATTERNS = [
  // The canonical kernel error code + message. Covers most write/mkdir/
  // rename/unlink failures against the read-only rootfs.
  [/\bEROFS\b/, 'erofs'],
  [/read[- ]only file ?system/i, 'erofs'],
  // npm/pip install attempts that hit a read-only prefix. These usually
  // surface as ENOENT or permission errors against /usr/lib/node_modules
  // or /usr/local/lib — listing the explicit paths keeps us from
  // false-matching on user code that legitimately mentions /usr.
  [/EACCES.+\/(usr|opt|etc|bin|lib)\//, 'eacces-rootfs'],
  // apt / dpkg refusing to write to /var/lib/dpkg etc.
  [/dpkg.*permission denied|apt.*permission denied|Unable to acquire the dpkg/i, 'apt'],
]

function buildHint(key) {
  const common =
    'Sandbox boundary hit. The agent container has `read_only: true` rootfs ' +
    '(see the SANDBOX primer in the system prompt). Do NOT retry the same ' +
    'write. Tell the user what you tried, why the sandbox blocked it, and ' +
    'name an operator action (e.g. "edit on host then `switchroom apply`", ' +
    'or "add to docker/Dockerfile.agent and rebuild"). Writable paths: ' +
    '$HOME (/state/agent/home), /tmp, /state/agent/**, /var/log/switchroom.'

  if (key === 'apt') {
    return (
      common +
      ' For package installs specifically: ask the operator to add the ' +
      'package to docker/Dockerfile.agent and rebuild the agent image — ' +
      'in-container apt is not the right path.'
    )
  }
  return common
}

function emitContext(text) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: text,
    },
  }
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function main() {
  const raw = readStdin()
  if (!raw) return

  let evt
  try {
    evt = JSON.parse(raw)
  } catch {
    return
  }

  // tool_response shape varies by tool — string for Bash, object with
  // file/oldString/newString for Edit/Write, etc. Stringify the whole
  // thing so we match against every nested error field at once. Cap the
  // scan window to keep memory bounded if the model just dumped a 10MB
  // log into the tool_response.
  let body
  try {
    body = JSON.stringify(evt.tool_response ?? '')
  } catch {
    return
  }
  if (!body) return
  if (body.length > 64 * 1024) body = body.slice(0, 64 * 1024)

  for (const [pattern, key] of PATTERNS) {
    if (pattern.test(body)) {
      emitContext(buildHint(key))
      return
    }
  }
}

try {
  main()
} catch {
  // Fail-silent. The PostToolUse must never block the tool flow.
}
