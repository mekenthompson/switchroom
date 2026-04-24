/**
 * Boot-sweep filter for `sweepBotAuthoredPins`.
 *
 * At first boot the gateway enumerates every chat ID in `access.allowFrom`
 * and calls `getChat()` to discover pinned messages. Telegram's Bot API
 * returns `400 chat not found` for user DM chat IDs (positive integers)
 * when the user has never previously sent a message to the bot — the bot
 * has no "chat" record for them yet.
 *
 * Group/supergroup IDs are negative and don't have this restriction — the
 * bot can call `getChat` on any group it's a member of.
 *
 * This helper gates which IDs the boot sweep should attempt to probe.
 * Skipping positive IDs eliminates the `chat not found` noise on startup
 * and defers the per-user sweep until the user actually messages the bot.
 */

/**
 * Returns `true` if the given chat ID should be included in the boot
 * pin sweep, `false` if it should be skipped.
 *
 * Rules:
 * - Negative IDs  → group/supergroup → always sweep (bot is a member).
 * - Positive IDs  → user DM         → skip (user may never have DMed).
 * - Zero or non-numeric → malformed → skip (defensive).
 */
export function shouldSweepChatAtBoot(chatId: string): boolean {
  const n = Number(chatId);
  if (!Number.isFinite(n) || n === 0 || !Number.isInteger(n)) return false;
  // Negative IDs are groups/supergroups — safe to sweep.
  return n < 0;
}
