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
 * Phase 2 wires real mtcute lifecycle: `MemoryStorage` so no SQLite
 * is touched, `importSession` to load the bearer string, real
 * `connect`/`disconnect`, real `sendText` (with forum-topic routing),
 * and `observeMessages` backed by `onNewMessage`/`onEditMessage`.
 *
 * Security: never log session strings, never log message bodies that
 * might contain auth codes (see `auth-code-redact.ts` for the
 * production pattern).
 */

import { MemoryStorage, TelegramClient } from "@mtcute/node";
import type { Message } from "@mtcute/node";

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
  /**
   * Forum topic id. For supergroups with topics enabled this is the
   * `message_thread_id` from the Bot API. mtcute maps it to the
   * `replyTo` parameter on send — the topic's "top message id" is
   * what the server expects.
   */
  messageThreadId?: number;
  /** Reply-quote a specific earlier message id. */
  replyTo?: number;
}

export interface ObservedMessage {
  chatId: number;
  messageId: number;
  threadId?: number;
  text: string;
  /**
   * Sender's user_id (or channel_id, for posts in a channel). Used by
   * `expectMessage` to filter `from: "bot"` vs `from: "driver"`.
   */
  senderUserId: number;
  fromBot: boolean;
  date: Date;
  /** `true` when this observation is an edit of an earlier message. */
  edited: boolean;
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
    // MemoryStorage keeps all session state in memory — the session
    // string we hold in `opts.session` is the only durable source of
    // truth. This sidesteps SQLite entirely (native bindings, file
    // locking, ephemeral STATE_DIR cleanup) and makes per-scenario
    // teardown a no-op for the driver's storage layer.
    this.client = new TelegramClient({
      apiId: this.opts.apiId,
      apiHash: this.opts.apiHash,
      storage: new MemoryStorage(),
    });

    // `force: true` because MemoryStorage is always empty at construct
    // time — without force, mtcute treats the (non-existent) prior
    // session as authoritative and silently ignores ours.
    await this.client.importSession(this.opts.session, true);
    await this.client.connect();
    // `connect()` opens the transport but does NOT start the updates
    // dispatch loop — that's `start()`'s job. For a returning session
    // (no interactive login) we have to call `startUpdatesLoop()`
    // ourselves, otherwise `onNewMessage` / `onEditMessage` never
    // fire and `observeMessages` silently waits forever. Symptom:
    // `expectMessage` timing out even though the bot's reply has
    // arrived in the chat (visible in Telegram).
    await this.client.startUpdatesLoop();
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
    // mtcute's CommonSendParams.replyTo doubles as the forum-topic
    // target — passing the topic's top-message id routes the new
    // message into that topic. Explicit `opts.replyTo` (quote-reply)
    // takes precedence if both are set; this matches Bot API
    // behaviour where `reply_to_message_id` overrides
    // `message_thread_id`.
    const replyTo = opts?.replyTo ?? opts?.messageThreadId;
    const sent = await c.sendText(chatId, text, replyTo ? { replyTo } : undefined);
    return { messageId: sent.id };
  }

  /**
   * Return the driver's own Telegram user_id. Cached after first call.
   */
  async getMyUserId(): Promise<number> {
    const c = this.requireClient();
    const me = await c.getMe();
    return me.id;
  }

  /**
   * Resolve a bot username (with or without `@`) to its user_id. The
   * resulting id doubles as the chat_id for DMing the bot from the
   * driver — Telegram DMs use the peer's user_id as the chat_id.
   */
  async resolveBotUserId(username: string): Promise<number> {
    const c = this.requireClient();
    const handle = username.startsWith("@") ? username : `@${username}`;
    const peer = await c.resolvePeer(handle);
    // For a bot/user the resolved peer is `inputPeerUser` carrying the
    // numeric `userId` we need.
    const u = peer as { userId?: number; channelId?: number };
    if (typeof u.userId === "number") return u.userId;
    throw new Error(
      `Driver.resolveBotUserId: '${handle}' did not resolve to a user (got ${JSON.stringify(peer)})`,
    );
  }

  /**
   * Subscribe to new + edited messages in `chatId` (optionally
   * filtered to a forum topic). Returns an async iterable so scenarios
   * can `for await` until a predicate matches. Each yielded value
   * carries an `edited` flag so the scenario can distinguish initial
   * sends from progress-card edits.
   *
   * Backfill: mtcute's emitters fire only for live updates, not
   * history. Scenarios that need to observe a message sent before
   * the observer started should poll `getHistory` directly (Phase 3
   * helper). The smoke test sends *after* `observeMessages` starts,
   * so no backfill needed.
   */
  observeMessages(
    chatId: number,
    opts?: { threadId?: number },
  ): AsyncIterable<ObservedMessage> {
    const c = this.requireClient();
    const targetThread = opts?.threadId;
    const queue: ObservedMessage[] = [];
    const waiters: Array<(m: IteratorResult<ObservedMessage>) => void> = [];
    let closed = false;

    const dispatch = (m: ObservedMessage): void => {
      const w = waiters.shift();
      if (w) w({ value: m, done: false });
      else queue.push(m);
    };

    const onNew = (msg: Message): void => {
      const observed = toObserved(msg, false);
      if (observed.chatId !== chatId) return;
      if (targetThread !== undefined && observed.threadId !== targetThread) return;
      dispatch(observed);
    };
    const onEdit = (msg: Message): void => {
      const observed = toObserved(msg, true);
      if (observed.chatId !== chatId) return;
      if (targetThread !== undefined && observed.threadId !== targetThread) return;
      dispatch(observed);
    };

    c.onNewMessage.add(onNew);
    c.onEditMessage.add(onEdit);

    const close = (): void => {
      if (closed) return;
      closed = true;
      c.onNewMessage.remove(onNew);
      c.onEditMessage.remove(onEdit);
      while (waiters.length > 0) {
        waiters.shift()?.({ value: undefined as never, done: true });
      }
    };

    return {
      [Symbol.asyncIterator](): AsyncIterator<ObservedMessage> {
        return {
          next(): Promise<IteratorResult<ObservedMessage>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
          return(): Promise<IteratorResult<ObservedMessage>> {
            close();
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };
  }

  /**
   * Subscribe to message-reaction add/remove ops in `chatId` (and
   * optionally on a specific `messageId`).
   *
   * Implementation notes:
   *
   * - mtcute parses `updateBotMessageReaction` for bot accounts; for
   *   USER accounts (the driver) we have to handle the raw
   *   `updateMessageReactions` ourselves via `onRawUpdate`. The TL
   *   carries the full new reaction set, not a delta — we diff
   *   against the prior set we've cached for the same `msgId` to
   *   emit add (`+`) / remove (`-`) ops.
   *
   * - For 1:1 DMs the update's `peer` is `peerUser` carrying the
   *   OTHER party's user_id (the bot). Filtering by
   *   `peer.userId === chatId` matches the driver-side convention
   *   where `chatId === botUserId`.
   *
   * - Reactions are emitted only when they CHANGE. The initial
   *   reaction-add fires as `op: "+"`; a follow-up
   *   `setMessageReaction` that REPLACES the prior emoji emits `-`
   *   for the old + `+` for the new.
   *
   * - Custom emojis (`reactionCustomEmoji`) are skipped — scenarios
   *   that need them aren't in scope and parsing them would require
   *   resolving the document id to an alias.
   */
  observeReactions(
    chatId: number,
    opts?: { messageId?: number },
  ): AsyncIterable<ObservedReaction> {
    const c = this.requireClient();
    const targetMsgId = opts?.messageId;
    const queue: ObservedReaction[] = [];
    const waiters: Array<(m: IteratorResult<ObservedReaction>) => void> = [];
    let closed = false;
    const prior = new Map<number, Set<string>>();

    const dispatch = (r: ObservedReaction): void => {
      const w = waiters.shift();
      if (w) w({ value: r, done: false });
      else queue.push(r);
    };

    const onRaw = (info: { update: unknown }): void => {
      const u = info.update as {
        _: string;
        peer?: { _: string; userId?: number };
        msgId?: number;
        reactions?: {
          results?: Array<{
            reaction: { _: string; emoticon?: string };
          }>;
        };
      };
      if (u._ !== "updateMessageReactions") return;
      if (u.peer?._ !== "peerUser") return;
      if (u.peer.userId !== chatId) return;
      const msgId = u.msgId;
      if (typeof msgId !== "number") return;
      if (targetMsgId !== undefined && msgId !== targetMsgId) return;

      const now = new Set<string>();
      for (const rc of u.reactions?.results ?? []) {
        if (
          rc.reaction?._ === "reactionEmoji" &&
          typeof rc.reaction.emoticon === "string"
        ) {
          now.add(rc.reaction.emoticon);
        }
      }
      const before = prior.get(msgId) ?? new Set<string>();
      const date = new Date();
      for (const e of now) {
        if (!before.has(e)) {
          dispatch({ chatId, messageId: msgId, emoji: e, op: "+", date });
        }
      }
      for (const e of before) {
        if (!now.has(e)) {
          dispatch({ chatId, messageId: msgId, emoji: e, op: "-", date });
        }
      }
      prior.set(msgId, now);
    };

    c.onRawUpdate.add(onRaw);

    const close = (): void => {
      if (closed) return;
      closed = true;
      c.onRawUpdate.remove(onRaw);
      while (waiters.length > 0) {
        waiters.shift()?.({ value: undefined as never, done: true });
      }
    };

    return {
      [Symbol.asyncIterator](): AsyncIterator<ObservedReaction> {
        return {
          next(): Promise<IteratorResult<ObservedReaction>> {
            if (queue.length > 0) {
              return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise((resolve) => waiters.push(resolve));
          },
          return(): Promise<IteratorResult<ObservedReaction>> {
            close();
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };
  }

  // -------- Deferred to #866 / Phase 2c --------

  /**
   * TODO(#866): subscribe to pin/unpin events on `chatId`/topic.
   * Used for progress-card-lifecycle assertions.
   */
  observePins(
    _chatId: number,
    _opts?: { threadId?: number },
  ): AsyncIterable<ObservedPin> {
    throw new Error("Driver.observePins not implemented (#866)");
  }

  /**
   * TODO(#866): send a voice note. Needed for `voice-inbound.test.ts`.
   */
  async sendVoice(
    _chatId: number,
    _oggPath: string,
    _opts?: SendTextOptions,
  ): Promise<{ messageId: number }> {
    throw new Error("Driver.sendVoice not implemented (#866)");
  }

  private requireClient(): TelegramClient {
    if (!this.client) {
      throw new Error("Driver not connected — call connect() first");
    }
    return this.client;
  }
}

function toObserved(msg: Message, edited: boolean): ObservedMessage {
  return {
    chatId: msg.chat.id,
    messageId: msg.id,
    threadId: msg.replyToMessage?.threadId ?? undefined,
    text: msg.text ?? "",
    senderUserId: msg.sender.id,
    fromBot: msg.sender.type === "user" && msg.sender.isBot === true,
    date: msg.date,
    edited,
  };
}
