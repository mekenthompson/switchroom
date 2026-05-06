/**
 * Tests for cron chat_id routing — bug where scaffold/reconcile call sites
 * passed `telegramConfig.forum_chat_id` as the cron chatId, ignoring the
 * agent's userId for `dm_only` agents and routing scheduled output to the
 * forum supergroup instead of the user's DM.
 *
 * The contract enforced here mirrors the `cronChatId = userId ?? forum_chat_id`
 * fallback used at both call sites in scaffold.ts.
 */

import { describe, expect, it } from "vitest";
import { buildCronScript } from "./scaffold.js";

const AGENT_DIR = "/home/test/.switchroom/agents/sample";
const PROMPT = "Send a morning briefing.";
const MODEL = "claude-sonnet-4-6";
const FORUM_CHAT_ID = "-1001234567890";
const USER_DM_ID = "12345";

function resolveCronChatId(userId: string | undefined, forumChatId: string): string {
  // Mirror of the rule used by scaffoldAgent + reconcileAgent.
  return userId ?? forumChatId;
}

describe("cron chat_id routing (dm_only fallback)", () => {
  it("when userId is present, cron script targets the user's DM, not the forum", () => {
    const cronChatId = resolveCronChatId(USER_DM_ID, FORUM_CHAT_ID);
    expect(cronChatId).toBe(USER_DM_ID);
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, cronChatId, USER_DM_ID);
    expect(script).toContain(`chat_id="${USER_DM_ID}"`);
    expect(script).not.toContain(`chat_id="${FORUM_CHAT_ID}"`);
  });

  it("when userId is undefined, cron script falls back to the forum chat_id", () => {
    const cronChatId = resolveCronChatId(undefined, FORUM_CHAT_ID);
    expect(cronChatId).toBe(FORUM_CHAT_ID);
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, cronChatId, undefined);
    expect(script).toContain(`chat_id="${FORUM_CHAT_ID}"`);
  });
});
