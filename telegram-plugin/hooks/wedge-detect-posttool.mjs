#!/usr/bin/env node
/**
 * PostToolUse hook — detect a wedged persistent-bash session.
 *
 * Claude Code's Bash tool uses a persistent `bash` subprocess for state
 * continuity (so `cd /foo` in one call survives to the next). When that
 * subprocess's IO state desyncs — typically after a long-running or
 * interrupted command leaves stdin in mid-heredoc, or after sentinel
 * parsing breaks — every subsequent Bash call returns exit-1 with empty
 * stdout and empty stderr. Even `true` returns exit 1. The wedge is
 * sticky for the session; `switchroom agent restart <self>` is the only
 * reliable recovery (it spawns a fresh `claude` → fresh persistent bash).
 *
 * This hook watches PostToolUse events for the wedge signature and,
 * after N consecutive matches, writes a sentinel + logs to stderr so
 * the operator (via `docker logs`) or the gateway (via a future card)
 * can prompt for restart. The hook itself can NEVER fix the wedge —
 * PostToolUse fires after the tool already ran. It's a detection +
 * surfacing surface, not a recovery surface.
 *
 * Claude Code PostToolUse protocol:
 *   stdin:  JSON { tool_name, tool_use_id, tool_input, tool_response, ... }
 *   stdout: optional JSON (hookSpecificOutput.additionalContext for next
 *           turn). We use this to nudge the model toward KillBash +
 *           self-restart guidance once the wedge is detected.
 *   exit:   0 always. Hook failures must never block the tool flow.
 *
 * State:
 *   $TELEGRAM_STATE_DIR/wedge-counter.txt — integer, consecutive empty Bash
 *     results. Reset to 0 on any non-Bash event or any non-empty Bash
 *     result. Incremented on each empty Bash result.
 *   $TELEGRAM_STATE_DIR/wedge-detected.json — JSON sentinel written when
 *     counter reaches THRESHOLD. Contains { ts, session_id, agent,
 *     consecutive }. Gateway can poll for this and surface a card; for
 *     now its presence is informational only.
 *
 * Threshold: 3. Picked to balance false positives (some real commands
 * legitimately produce no output and exit non-zero, e.g. `test -f
 * /nonexistent`) against latency-to-detect. Three in a row is rare
 * outside genuine wedge.
 *
 * Detection is shape-based not exit-code-based because the tool_response
 * shape varies by Claude Code version. We match on:
 *   - tool_name === "Bash"
 *   - stringified response contains BOTH empty stdout marker AND empty
 *     stderr marker. Marker patterns covered: <bash-stdout></bash-stdout>,
 *     "stdout":"" + "stderr":"", and the bare "(no output)" string some
 *     versions emit.
 *
 * If detection markers change in a future Claude Code release, this hook
 * silently misses the wedge — that's the right failure mode (better than
 * false-firing).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const THRESHOLD = 3

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function stateDir() {
  return process.env.TELEGRAM_STATE_DIR || null
}

function counterPath() {
  const dir = stateDir()
  return dir ? join(dir, 'wedge-counter.txt') : null
}

function sentinelPath() {
  const dir = stateDir()
  return dir ? join(dir, 'wedge-detected.json') : null
}

function readCounter() {
  const p = counterPath()
  if (!p || !existsSync(p)) return 0
  try {
    const raw = readFileSync(p, 'utf8').trim()
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

function writeCounter(n) {
  const p = counterPath()
  if (!p) return
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, String(n), 'utf8')
  } catch {
    // fail-silent; counter loss just delays detection by a couple of cycles
  }
}

function writeSentinel(payload) {
  const p = sentinelPath()
  if (!p) return
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8')
  } catch {
    // fail-silent
  }
}

/**
 * Test whether a Bash tool_response matches the wedge signature
 * (empty stdout AND empty stderr).
 *
 * Defensive: tool_response shape varies across Claude Code versions and
 * across plain-string vs structured-object representations. We check a
 * handful of likely markers and fail-no-match on anything else.
 */
function isEmptyBashResponse(toolResponse) {
  if (toolResponse == null) return false
  let body
  try {
    body = typeof toolResponse === 'string' ? toolResponse : JSON.stringify(toolResponse)
  } catch {
    return false
  }
  // Cap scan to keep us cheap on huge outputs (which are by definition
  // not empty, so we can early-return).
  if (body.length > 4096) return false

  // Several response shapes Claude Code has used:
  //   1. XML-style tags: <bash-stdout></bash-stdout><bash-stderr></bash-stderr>
  //   2. JSON object stringified: {"stdout":"","stderr":"",...}
  //   3. JSON object's literal stdout/stderr fields (when we passed the
  //      object directly).
  const hasEmptyStdoutTag = /<bash-stdout>\s*<\/bash-stdout>/i.test(body)
  const hasEmptyStderrTag = /<bash-stderr>\s*<\/bash-stderr>/i.test(body)
  if (hasEmptyStdoutTag && hasEmptyStderrTag) return true

  const hasEmptyStdoutJson = /"stdout"\s*:\s*""/.test(body)
  const hasEmptyStderrJson = /"stderr"\s*:\s*""/.test(body)
  if (hasEmptyStdoutJson && hasEmptyStderrJson) return true

  // Defensive: if the response is literally `{}` or `""`, that's also a
  // zero-info Bash result. Treat the same as empty.
  if (body === '{}' || body === '""' || body === '') return true

  return false
}

function emitWedgeContext(consecutive) {
  // PostToolUse can prepend additionalContext to the model's next turn.
  // Use it to surface a single-line nudge once the wedge is suspected
  // so the agent knows to try recovery rather than retrying the same
  // command in a loop.
  const text =
    `[wedge-detect] ${consecutive} consecutive empty-result Bash calls — ` +
    `your persistent shell is likely wedged. Try \`KillBash\` to drop ` +
    `the wedged session, OR ask the user for \`switchroom agent restart ${process.env.SWITCHROOM_AGENT_NAME || '<self>'}\` ` +
    `if KillBash doesn't recover. Don't retry the same command.`
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: text,
    },
  }
  try {
    process.stdout.write(JSON.stringify(payload) + '\n')
  } catch {
    // fail-silent
  }
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

  // Non-Bash events reset the counter (the wedge is specific to the
  // persistent shell; other tools succeeding doesn't tell us anything
  // about Bash, but a different tool firing means we're at least not in
  // a tight loop of Bash retries — safe to reset).
  if (evt.tool_name !== 'Bash') {
    writeCounter(0)
    return
  }

  if (!isEmptyBashResponse(evt.tool_response)) {
    // Bash call returned real output → not wedged → reset.
    writeCounter(0)
    return
  }

  // Empty Bash result. Increment.
  const next = readCounter() + 1
  writeCounter(next)

  if (next >= THRESHOLD) {
    const sentinel = {
      ts: new Date().toISOString(),
      session_id: evt.session_id || null,
      agent: process.env.SWITCHROOM_AGENT_NAME || null,
      consecutive: next,
      // Capture the last tool_use_id so an operator-side investigator
      // can pin which tool calls triggered the threshold.
      last_tool_use_id: evt.tool_use_id || null,
    }
    writeSentinel(sentinel)
    process.stderr.write(
      `wedge-detect: ${next} consecutive empty-result Bash calls; ` +
      `sentinel at ${sentinelPath()}; recommend KillBash or ` +
      `switchroom agent restart\n`,
    )
    emitWedgeContext(next)
  }
}

try {
  main()
} catch {
  // PostToolUse must never block the tool flow.
}
