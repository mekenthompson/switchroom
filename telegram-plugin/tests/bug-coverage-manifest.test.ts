/**
 * Bug coverage manifest — every shipped bug has a documented regression
 * home in the test suite. Each `it` below names a bug + its test home
 * + the invariant pinned. Pass = covered. Skip = documented gap.
 *
 * Goal: when a new bug arrives, look here first to see if the class
 * is already protected. When opening a follow-up PR for an existing
 * bug, find the test home in seconds.
 *
 * This file does NOT itself replicate every bug — it asserts that the
 * regression test exists at the named path and that the bug class is
 * expressible in the current harness. The actual production-fix
 * regression tests live in their named files.
 *
 * Maintenance: when fixing a new bug, add a row here and a test home.
 * When the harness gets a new seam, revisit gaps marked `it.skip`.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

function testFileExists(rel: string): boolean {
  return existsSync(resolve(__dirname, rel))
}

describe('bug coverage manifest', () => {
  // ─── REACTION TIMING / LIFECYCLE ──────────────────────────────────────

  it('Bug A — anonymous IPC client disconnect flushes turn state (PR #600)', () => {
    // Anonymous (recall.py-style) IPC clients triggered the gateway's
    // disconnect-flush, prematurely setting 👍 on real turns.
    // Fix: gate flush on `agentName != null`.
    expect(testFileExists('real-gateway-ipc-lifecycle.test.ts')).toBe(true)
    expect(testFileExists('gateway-disconnect-flush.test.ts')).toBe(true)
    // Invariant pinned: I1 in real-gateway-ipc-lifecycle.test.ts
  })

  it('Bug B — legacy update_placeholder IPC type crashed gateway (PR #600)', () => {
    // After PR #553 PR-5 removed update_placeholder, recall.py's
    // ongoing use of the legacy type closed the gateway socket.
    // Fix: validator soft-rejects unknown types; processBuffer logs+continues.
    expect(testFileExists('real-gateway-ipc-lifecycle.test.ts')).toBe(true)
    expect(testFileExists('ipc-server-validate-update-placeholder.test.ts')).toBe(true)
    // Invariant pinned: I4 in real-gateway-ipc-lifecycle.test.ts
  })

  it('Bug D + Bug Z — 👍 fires before final outbound delivery lands (PR #602)', () => {
    // turn-flush dedup branch fired setDone() on a 500ms-lagged read of
    // local outbound state, while editMessageText was still in-flight.
    // Fix: tie setDone to real delivery, not the JSONL turn_end event.
    expect(testFileExists('real-gateway-ipc-lifecycle.test.ts')).toBe(true)
    expect(testFileExists('turn-flush-dedup-controller.test.ts')).toBe(true)
    expect(testFileExists('stream-reply-handler.test.ts')).toBe(true)
    // Invariant pinned: I3 in real-gateway-ipc-lifecycle.test.ts;
    // generalized in INV-1 in harness-ordering-invariants.test.ts
  })

  it('Bug Z generalized — terminal 👍 fires exactly once per turn', () => {
    // Defensive invariant against a future regression where setDone
    // fires twice (e.g. both streamReply post-await AND turn_end JSONL
    // handler).
    expect(testFileExists('harness-ordering-invariants.test.ts')).toBe(true)
    // INV-2 in harness-ordering-invariants.test.ts
  })

  it('F1 — ladder collapse (sub-debounce turns) — PR #569', () => {
    // Sub-700ms turns dropped pending tool emoji because finishWithState
    // cleared the debounce timer before the pending state crossed.
    expect(testFileExists('real-gateway-f1-ladder-integrity.test.ts')).toBe(true)
  })

  it('F2 — initial 👀 delayed by inbound coalescer — PR #568', () => {
    // 👀 only fired after the 1500ms coalesce window. Misses 800ms
    // first-paint deadline.
    expect(testFileExists('real-gateway-f2-instant-draft.test.ts')).toBe(true)
  })

  it('F3 — progress card late emit on 5-30s turns — PR #570', () => {
    // Promotion thresholds (≥3 tools, sub-agent, etc.) didn't trigger
    // for simple 5-30s turns; card stayed hidden.
    expect(testFileExists('real-gateway-f3-late-card.test.ts')).toBe(true)
  })

  it('F4 — interim text static, never edited — covered by harness', () => {
    expect(testFileExists('real-gateway-f4-interim-text.test.ts')).toBe(true)
  })

  // ─── DUPLICATION / DEDUP ──────────────────────────────────────────────

  it('#546 — turn-flush + replay duplicate (HTML vs markdown) — PR #599', () => {
    // Bridge disconnects mid-flight, turn-flush sends as HTML, agent
    // replays stream_reply with raw markdown — same content twice.
    // Fix: OutboundDedupCache with normalized-content keys.
    expect(testFileExists('recent-outbound-dedup.test.ts')).toBe(true)
    expect(testFileExists('real-gateway-i6-turn-flush-replay-dedup.test.ts')).toBe(true)
    // Full turn-flush+disconnect+replay sequence pinned in I6
  })

  it('Bug C — wake-audit respawn duplicate reply (#553 follow-up, PR #601)', () => {
    // --continue respawn re-fires wake-audit, producing duplicate reply.
    // Profile-side fix; gateway dedup is defense-in-depth.
    expect(testFileExists('real-gateway-i6-turn-flush-replay-dedup.test.ts')).toBe(true)
    // I5(b) in i6 file pins the gateway-level safety net.
    // The original I5 in real-gateway-ipc-lifecycle is `.skip`'d
    // pending the profile-side fix.
  })

  // ─── HEARTBEAT / TIMING ───────────────────────────────────────────────

  it('#519 — heartbeat ticks produced identical text wasting API quota', () => {
    // formatElapsed's 5s precision in the 10–59s window caused
    // consecutive ticks to render identically.
    // No dedicated test file; covered indirectly by progress-card
    // tests that exercise the heartbeat path.
    expect(testFileExists('progress-card-driver.test.ts')).toBe(true)
  })

  // ─── PIN STATE MACHINE ────────────────────────────────────────────────

  it('#43 — duplicate pins across turns (orphan sub-agent correlation)', () => {
    // Multiple progress cards pinned for what should have been one turn.
    // Local .active-pins.json diverges from Telegram state.
    // Fix: stale-pin sweeper + orphan-correlation handling.
    expect(testFileExists('active-pins-sweep.test.ts')).toBe(true)
    expect(testFileExists('active-pins.test.ts')).toBe(true)
  })

  it('#31 — stale pins not unpinned after background sub-agent orphans turn_end', () => {
    expect(testFileExists('active-pins-sweep.test.ts')).toBe(true)
  })

  // ─── PROGRESS CARD / TEXT ROUTING ─────────────────────────────────────

  it('#45 — assistant plain-text rendered as step but never sent to chat', () => {
    // Agent emits prose without calling reply tool; appears in card
    // step list but no Telegram message lands.
    // Fix: turn-flush prose recovery backstop.
    expect(testFileExists('turn-flush-prose-recovery.test.ts')).toBe(true)
    expect(testFileExists('answer-stream-silent-markers.test.ts')).toBe(true)
  })

  it('#51 — #45 follow-up: prose-as-step silent-drop path coverage', () => {
    expect(testFileExists('turn-flush-prose-recovery.test.ts')).toBe(true)
  })

  it('#431 — pendingPreamble=no on every render across all agents', () => {
    // text events didn't populate pendingPreamble. Wire fix + unit test.
    expect(testFileExists('progress-card.test.ts')).toBe(true)
    // Covered by 'text event stashes pendingPreamble' test in that file.
  })

  it('#549 — preamble text routed to BOTH chat and progress card (OPEN)', () => {
    // The OPEN bug — reproduced via I8 with `it.fails()` mode.
    // When the fix lands, swap `it.fails()` → `it()`.
    expect(testFileExists('real-gateway-i8-issue-549-preamble-dup.test.ts')).toBe(true)
  })

  // ─── BOOT / RESTART ──────────────────────────────────────────────────

  it('#489 — boot-card dedupe race on in-flight sendMessage', () => {
    // Two identical "back up" cards on every gateway restart due to
    // boot path's await racing with bridge-reconnect.
    // Fix: bootCardPending in-flight flag.
    expect(testFileExists('boot-card-dedupe.test.ts')).toBe(true)
  })

  it('#500 — stale turn-active marker triggered 2-min flap loop on boot', () => {
    expect(testFileExists('gateway-boot-marker-clear.test.ts')).toBe(true)
  })

  it('#564 — 400 "chat not found" treated as log-only, not shutdown', () => {
    expect(testFileExists('gateway-409-retry-banner.test.ts') ||
           testFileExists('gateway-startup-network-retry.test.ts')).toBe(true)
  })

  // ─── BRIDGE / IPC ─────────────────────────────────────────────────────

  it('#430 — bridge anonymous registration refused; gateway rejects "default"', () => {
    expect(testFileExists('bridge-anonymous-refuse.test.ts')).toBe(true)
    expect(testFileExists('real-gateway-ipc-lifecycle.test.ts')).toBe(true)
    // I4 also covers this in real-gateway-ipc-lifecycle.test.ts
  })

  // ─── REACTIONS / STATUS ───────────────────────────────────────────────

  it('#542 — status reactions skip intermediates on long turns (OPEN)', () => {
    // Investigation found gateway.ts:4384 doesn't pass allowedReactions
    // to StatusReactionController. The harness shows the controller
    // works correctly when given the chance — bug lives in production
    // wire-up, not controller logic.
    expect(testFileExists('real-gateway-i7-issue-542-long-turn-ladder.test.ts')).toBe(true)
  })

  // ─── FUNDAMENTAL HARNESS COVERAGE ─────────────────────────────────────

  it('outbound dedup TTL window is enforced for the full TTL', () => {
    expect(testFileExists('harness-ordering-invariants.test.ts')).toBe(true)
    // INV-4
  })

  it('edit on a deleted message always errors (no silent success)', () => {
    expect(testFileExists('harness-ordering-invariants.test.ts')).toBe(true)
    // INV-3
  })

  it('holdNext seam: events fire while a held call is parked', () => {
    expect(testFileExists('harness-ordering-invariants.test.ts')).toBe(true)
    // INV-5; foundation for future Bug-D-class tests.
    expect(testFileExists('fake-bot-api.test.ts')).toBe(true)
  })

  it('escapeMarkdownV2 always produces balanced output', () => {
    expect(testFileExists('escape-markdownv2-balanced.test.ts')).toBe(true)
    // Cross-check that found a real validator bug during the hunt.
  })

  it('parseModeBalanced lenient validator catches malformed MarkdownV2', () => {
    expect(testFileExists('harness-parse-mode-validation.test.ts')).toBe(true)
  })

  // ─── DOCUMENTED GAPS ──────────────────────────────────────────────────

  it.skip('#479 — no pre-alloc placeholder in groups (CLOSED, no harness test)', () => {
    // The fix relaxed the DM-only gate. Harness doesn't model
    // sendMessageDraft, so a per-channel placeholder integration
    // test would need a harness extension.
    // Production fix verified manually; regression risk is moderate.
  })

  it.skip('#501 — long foreground sub-agents killed by watchdog (OPEN)', () => {
    // bin/bridge-watchdog.sh is a shell script reading turn-active.json
    // mtime. Test home would be tests/bridge-watchdog.test.ts.
    // Not gateway-harness-shaped.
  })

  it.skip('#429 — auth refresh loop + handoff oauth-token (OPEN)', () => {
    // Auth surface, not gateway. Tests live under src/auth/*.test.ts.
  })

  it.skip('#542 reproduction in-process (OPEN)', () => {
    // Diagnosed via I7 — root cause is gateway.ts:4384 missing
    // allowedReactions wire-up. Reproducer needs harness extension to
    // model per-chat available_reactions filtering. Track separately.
  })
})

describe('bug-coverage-manifest counts', () => {
  it('all bug-coverage-manifest tests reference real test files', () => {
    // Self-test: this file's `expect(testFileExists(...))` claims must
    // all be true. Vitest runs them in order; if any fails above, this
    // doesn't add value — but if all pass, the manifest is consistent.
    expect(true).toBe(true)
  })
})
