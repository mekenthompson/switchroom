/**
 * Pin the contract: the boot card silences its Telegram notification
 * (passes `disable_notification: true` to `sendMessage`) iff the
 * restart marker's `reason` text starts with `"operator:"`.
 *
 * Background: every agent in the fleet posts a boot card after a
 * `switchroom update`. Without this gate the operator gets N push
 * notifications for one planned redeploy — once-per-agent on every
 * routine update. User-initiated restarts (`/restart` from chat,
 * `cli: switchroom restart`) and unplanned events (crash, fresh) still
 * notify because the user asked for them or needs to know something
 * went wrong.
 *
 * The toggle is keyed on the reason TEXT (`opts.restartReasonDetail`),
 * not the RestartReason enum, because the enum collapses all
 * marker-bearing restarts into `'graceful'` — losing the operator-vs-
 * user distinction. The reason text is the source of truth for who
 * triggered the restart.
 */

import { describe, it, expect } from 'vitest'
import { startBootCard } from '../gateway/boot-card.js'
import type { BotApiForBootCard } from '../gateway/boot-card.js'

/** Capture sendMessage opts for assertion. editMessageText is a no-op. */
function makeCapturingBot(): {
  bot: BotApiForBootCard
  sends: Array<{ chatId: string; text: string; opts: Record<string, unknown> }>
} {
  const sends: Array<{ chatId: string; text: string; opts: Record<string, unknown> }> = []
  const bot: BotApiForBootCard = {
    sendMessage: async (chatId, text, opts) => {
      sends.push({ chatId, text, opts: opts ?? {} })
      return { message_id: 42 }
    },
    editMessageText: async () => ({}),
  }
  return { bot, sends }
}

/** Common opts — only the reason-detail varies per test. */
function mkOpts(overrides: { restartReasonDetail?: string; restartReason?: 'planned' | 'graceful' | 'crash' | 'fresh' } = {}) {
  return {
    agentName: 'TestAgent',
    agentSlug: 'test-agent',
    version: 'v0.0.0-test',
    agentDir: '/tmp/test-agent',
    gatewayInfo: { pid: 1, startedAtMs: Date.now() },
    restartReason: overrides.restartReason ?? 'graceful' as const,
    restartReasonDetail: overrides.restartReasonDetail,
    // Disable the live loop + probes — we only want the initial sendMessage.
    agentLiveWindowMs: 0,
    settleWindowMs: 1_000_000,
  }
}

describe('boot card — silent-on-operator-reason', () => {
  it('passes disable_notification: true when restartReasonDetail starts with "operator:"', async () => {
    const { bot, sends } = makeCapturingBot()
    await startBootCard('chat1', undefined, bot, mkOpts({ restartReasonDetail: 'operator: switchroom update' }))
    expect(sends).toHaveLength(1)
    expect(sends[0]!.opts.disable_notification).toBe(true)
  })

  it('omits disable_notification when restartReasonDetail starts with "user:"', async () => {
    const { bot, sends } = makeCapturingBot()
    await startBootCard('chat1', undefined, bot, mkOpts({ restartReasonDetail: 'user: /restart from chat' }))
    expect(sends).toHaveLength(1)
    expect(sends[0]!.opts.disable_notification).toBeUndefined()
  })

  it('omits disable_notification when restartReasonDetail starts with "cli:"', async () => {
    const { bot, sends } = makeCapturingBot()
    await startBootCard('chat1', undefined, bot, mkOpts({ restartReasonDetail: 'cli: switchroom restart' }))
    expect(sends).toHaveLength(1)
    expect(sends[0]!.opts.disable_notification).toBeUndefined()
  })

  it('omits disable_notification when restartReasonDetail is undefined (crash / fresh path)', async () => {
    const { bot, sends } = makeCapturingBot()
    await startBootCard('chat1', undefined, bot, mkOpts({ restartReason: 'crash' }))
    expect(sends).toHaveLength(1)
    expect(sends[0]!.opts.disable_notification).toBeUndefined()
  })

  it('omits disable_notification when restartReasonDetail is empty string', async () => {
    const { bot, sends } = makeCapturingBot()
    await startBootCard('chat1', undefined, bot, mkOpts({ restartReasonDetail: '' }))
    expect(sends).toHaveLength(1)
    expect(sends[0]!.opts.disable_notification).toBeUndefined()
  })

  it('matches the "operator:" prefix exactly — "operator-ish" should NOT silence', async () => {
    // Defence against future operator-side reasons that don't actually
    // want silent — confirms we're matching the prefix-with-colon shape,
    // not a fuzzy contains.
    const { bot, sends } = makeCapturingBot()
    await startBootCard('chat1', undefined, bot, mkOpts({ restartReasonDetail: 'operator-ish: rolled over' }))
    expect(sends).toHaveLength(1)
    // 'operator-ish:' does NOT start with 'operator:' so still notifies.
    expect(sends[0]!.opts.disable_notification).toBeUndefined()
  })
})
