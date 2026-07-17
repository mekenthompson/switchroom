/**
 * Live-wire probe — Telegram's no-space `#` HEADING PROMOTION rule, and the
 * line-start guard's escape of it.
 *
 * ## Why this exists
 *
 * The #3252 line-start guard originally SKIPPED the `#` case on the
 * CommonMark analogy that `#`+non-space is not an ATX heading and therefore
 * renders literally. A real incident (gateway history.db message_id 19159:
 * `- #3293: …` rendered as a giant H1 on the operator's phone) disproved
 * that. A one-off live probe on 2026-07-17 pinned the actual rule — see
 * `telegram-plugin/render/guard-linestart-note.md` for the full transcript.
 * This scenario makes that probe REPEATABLE: it re-asserts, against Telegram
 * production, both halves of the contract the guard's `#` arm rests on:
 *
 *   (a) PROMOTION — a glued `#` at line start / list-item-content start is
 *       promoted to a `{type:"heading"}` block (if Telegram ever stops doing
 *       this, the guard becomes unnecessary escaping and this fails loudly);
 *   (b) ESCAPE — the guard's output for those same bodies parses WITHOUT any
 *       heading block, and the reader-visible text keeps the literal `#`
 *       (the backslash is consumed server-side).
 *
 * ## Mechanism (deliberately NOT the driver harness)
 *
 * Unlike the jtbd scenarios this probe needs no agent turn and no mtcute
 * driver: `sendRichMessage` RETURNS the server-parsed `rich_message.blocks`
 * tree on the send response, which IS Telegram's own parse. So the probe
 * only needs a bot token and a chat the bot can post to. Each probe message
 * is deleted immediately after its response is captured.
 *
 * ## Self-skip
 *
 * Needs `TELEGRAM_UAT_PROBE_BOT_TOKEN` (any bot token, e.g. the test
 * harness bot's) and `TELEGRAM_UAT_PROBE_CHAT_ID` (a chat that bot can post
 * to). Absent either, it self-skips green like every scenario in this dir —
 * the `uat/**` tree is excluded from gating CI anyway.
 */

import { describe, it, expect } from "vitest";
import { Bot } from "grammy";
import { guardAccidentalBlockConstructs } from "../../render/line-start-guard.js";
import { loadUatEnv } from "../load-env.js";

loadUatEnv();

const TOKEN = process.env.TELEGRAM_UAT_PROBE_BOT_TOKEN ?? "";
const CHAT_ID = Number.parseInt(process.env.TELEGRAM_UAT_PROBE_CHAT_ID ?? "", 10);
const HAS_CREDS = TOKEN.length > 0 && Number.isFinite(CHAT_ID);

/** Recursively collect every `type` tag in a rich block tree. */
function blockTypes(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) blockTypes(n, acc);
  } else if (node && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (typeof rec.type === "string") acc.push(rec.type);
    for (const v of Object.values(rec)) blockTypes(v, acc);
  }
  return acc;
}

/** Recursively concatenate every string `text` field in a rich block tree. */
function blockText(node: unknown, acc: string[] = []): string {
  if (Array.isArray(node)) {
    for (const n of node) blockText(n, acc);
  } else if (node && typeof node === "object") {
    const rec = node as Record<string, unknown>;
    if (typeof rec.text === "string") acc.push(rec.text);
    for (const v of Object.values(rec)) blockText(v, acc);
  }
  return acc.join("");
}

/** The glued-hash bodies live-proved (2026-07-17) to heading-promote. */
const PROMOTING_BODIES: ReadonlyArray<[name: string, body: string]> = [
  ["bare line `#`+digit", "#3293 foo"],
  ["bullet content `#`+digit (the recorded incident shape)", "- #3293: foo"],
  ["bare line `#`+letter", "#word probe"],
  ["multi-hash glued", "##3293 foo"],
  ["ordered-item content", "1. #3293: foo"],
];

describe.skipIf(!HAS_CREDS)("live probe — no-space `#` heading promotion + guard escape", () => {
  // Lazy: `new Bot("")` throws, and describe bodies run even when skipped.
  let bot: Bot | undefined;

  async function parseOnWire(body: string): Promise<{ types: string[]; text: string }> {
    bot ??= new Bot(TOKEN);
    const msg = await bot.api.sendRichMessage(CHAT_ID, { markdown: body });
    // allow-raw-bot-api: UAT probe cleanup, best-effort delete in a test-only file (no gateway retry policy in scope)
    await bot.api.deleteMessage(CHAT_ID, msg.message_id).catch(() => {});
    const blocks = (msg as { rich_message?: { blocks?: unknown } }).rich_message?.blocks;
    return { types: blockTypes(blocks), text: blockText(blocks) };
  }

  for (const [name, body] of PROMOTING_BODIES) {
    it(
      `UNGUARDED ${name} is heading-promoted; the guard's escape renders it literal`,
      { timeout: 30_000 },
      async () => {
        // (a) The raw body IS promoted — the premise the guard exists for.
        const raw = await parseOnWire(body);
        expect(raw.types, `raw body ${JSON.stringify(body)} parsed as ${raw.types.join(",")}`).toContain(
          "heading",
        );

        // (b) The guarded body is NOT promoted, and the reader sees the
        //     original prose byte-for-byte (backslash consumed).
        const guarded = guardAccidentalBlockConstructs(body);
        expect(guarded).not.toBe(body); // the guard must actually fire
        const escaped = await parseOnWire(guarded);
        expect(escaped.types, `guarded body ${JSON.stringify(guarded)} still has a heading`).not.toContain(
          "heading",
        );
        expect(escaped.text).toContain("#");
        expect(escaped.text).not.toContain("\\");
      },
    );
  }

  it("an intended `# Real heading` passes the guard untouched and renders as a heading", { timeout: 30_000 }, async () => {
    const body = "# Real heading";
    expect(guardAccidentalBlockConstructs(body)).toBe(body);
    const parsed = await parseOnWire(body);
    expect(parsed.types).toContain("heading");
  });
});
