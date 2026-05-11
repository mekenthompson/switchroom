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

  // -------- Deferred to #866 / Phase 2b --------

  /**
   * TODO(#866): subscribe to message-reaction updates. mtcute delivers
   * `updateMessageReactions` via the raw update stream; the driver
   * should compute add/remove ops vs the prior snapshot so scenarios
   * can assert on the 👀→🤔→🔥→👍 sequence. Held out of #865 because
   * mtcute's user-account reaction parsing has rougher edges than
   * `onNewMessage` and benefits from a dedicated PR + test.
   */
  observeReactions(
    _chatId: number,
    _opts?: { messageId?: number },
  ): AsyncIterable<ObservedReaction> {
    throw new Error("Driver.observeReactions not implemented (#866)");
  }

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
    fromBot: msg.sender.type === "user" && msg.sender.isBot === true,
    date: msg.date,
    edited,
  };
}
