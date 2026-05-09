/**
 * mtcute-backed Telegram user-account driver for the UAT harness.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/865
 *
 * The driver is a Telegram **user account** (not a bot) because bots
 * cannot read other bots' messages even with privacy mode disabled
 * and admin rights — see Telegram Bots FAQ. The driver sends fixture
 * inbounds and observes everything the test bot emits.
 *
 * Phase 1: typed wrapper around mtcute with `connect` / `disconnect` /
 * `sendText` implemented. `sendVoice`, `observeMessages`,
 * `observeReactions`, `observePins` are stubs with TODO markers — they
 * land in Phase 2 alongside the scenario catalog.
 *
 * Security: never log session strings, never log message bodies that
 * might contain auth codes (see `auth-code-redact.ts` for the
 * production pattern).
 */

import { TelegramClient } from "@mtcute/node";

export interface DriverOptions {
  /** Telegram developer credential — `api_id` from my.telegram.org. */
  apiId: number;
  /** Telegram developer credential — `api_hash` from my.telegram.org. */
  apiHash: string;
  /**
   * Session string previously minted by `bun run uat:login` and
   * stored in vault under `telegram-uat-driver-session`. Bearer-
   * equivalent — never log.
   */
  session: string;
}

export interface SendTextOptions {
  /** Forum topic id, when targeting a topic in a supergroup. */
  messageThreadId?: number;
  /** Reply-quote a specific earlier message id. */
  replyTo?: number;
}

export interface ObservedMessage {
  chatId: number;
  messageId: number;
  threadId?: number;
  text: string;
  /** raw HTML if the message was sent with `parse_mode: HTML`. */
  html?: string;
  fromBot: boolean;
  date: Date;
}

export interface ObservedReaction {
  chatId: number;
  messageId: number;
  emoji: string;
  /** Reaction add (`+`) vs remove (`-`). */
  op: "+" | "-";
  date: Date;
}

export interface ObservedPin {
  chatId: number;
  messageId: number;
  pinned: boolean;
  date: Date;
}

/**
 * Thin wrapper. Concrete mtcute use is intentionally narrow so the
 * scenarios don't get tangled up in raw MTProto types.
 */
export class Driver {
  private client: TelegramClient | null = null;

  constructor(private readonly opts: DriverOptions) {}

  async connect(): Promise<void> {
    // mtcute v0.27 takes session via the `storage` option. For a
    // string-session driver we'll use `@mtcute/core/utils.js`'s
    // string-session-storage in Phase 2; Phase 1 just records the
    // shape so the harness compiles.
    // TODO(#865): wire StringSessionStorage from @mtcute/core/utils
    // and feed `this.opts.session` through it.
    this.client = new TelegramClient({
      apiId: this.opts.apiId,
      apiHash: this.opts.apiHash,
    });
    void this.opts.session;
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    await this.client.destroy();
    this.client = null;
  }

  async sendText(
    chatId: number,
    text: string,
    opts?: SendTextOptions,
  ): Promise<{ messageId: number }> {
    const c = this.requireClient();
    // mtcute exposes `sendText(peer, text, params)`. Forum topic
    // targeting is via `params.replyTo` carrying a topic ref in
    // newer mtcute; precise shape verified in Phase 2.
    const sent = await c.sendText(chatId, text, {
      replyTo: opts?.replyTo,
    } as Parameters<TelegramClient["sendText"]>[2]);
    void opts?.messageThreadId; // TODO(#865): topic routing in Phase 2
    return { messageId: sent.id };
  }

  // -------- Phase 2 stubs --------

  /**
   * TODO(#865): send a voice note as the driver user. Needed for the
   * `voice-inbound.test.ts` scenario. mtcute's `sendVoice` takes an
   * OGG/Opus buffer or a path; we'll stage fixtures under
   * `uat/fixtures/voice/`.
   */
  async sendVoice(
    _chatId: number,
    _oggPath: string,
    _opts?: SendTextOptions,
  ): Promise<{ messageId: number }> {
    throw new Error("Driver.sendVoice not implemented (Phase 2)");
  }

  /**
   * TODO(#865): subscribe to new + edited messages in `chatId`/topic.
   * Returns an async iterable so scenarios can `for await` until a
   * predicate matches. Should backfill via `getHistory(limit:50)` to
   * catch messages that arrived between connect and observe-start.
   */
  observeMessages(
    _chatId: number,
    _opts?: { threadId?: number },
  ): AsyncIterable<ObservedMessage> {
    throw new Error("Driver.observeMessages not implemented (Phase 2)");
  }

  /**
   * TODO(#865): subscribe to message-reaction updates. Note: mtcute
   * delivers `updateMessageReactions` as a delta (full set after the
   * change); the driver should compute add/remove ops vs the prior
   * snapshot so scenarios can assert on the 👀→🤔→🔥→👍 sequence.
   */
  observeReactions(
    _chatId: number,
    _opts?: { messageId?: number },
  ): AsyncIterable<ObservedReaction> {
    throw new Error("Driver.observeReactions not implemented (Phase 2)");
  }

  /**
   * TODO(#865): subscribe to pin/unpin events on `chatId`/topic.
   * Used for progress-card-lifecycle assertions.
   */
  observePins(
    _chatId: number,
    _opts?: { threadId?: number },
  ): AsyncIterable<ObservedPin> {
    throw new Error("Driver.observePins not implemented (Phase 2)");
  }

  private requireClient(): TelegramClient {
    if (!this.client) {
      throw new Error("Driver not connected — call connect() first");
    }
    return this.client;
  }
}
