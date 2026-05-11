/**
 * Unit tests for the UAT mtcute driver wrapper.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/865
 *
 * These mock `@mtcute/node`; no real network or session string is
 * required. The real-Telegram side lives in
 * `telegram-plugin/uat/scenarios/`.
 *
 * Why this file lives at repo-root `tests/` rather than next to
 * `telegram-plugin/uat/driver.ts`: the buildkite pipeline runs
 * `bun test` from `telegram-plugin/`, and bun's vitest-compat shim
 * doesn't cover `vi.mock` / `vi.resetModules`. Moving the tests
 * outside `telegram-plugin/` keeps vitest discovery intact while
 * sidestepping bun's discovery.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Driver as DriverType,
  ObservedMessage,
} from "../telegram-plugin/uat/driver.js";

class MockEmitter<T> {
  private listeners = new Set<(v: T) => void>();
  add(fn: (v: T) => void): void {
    this.listeners.add(fn);
  }
  remove(fn: (v: T) => void): void {
    this.listeners.delete(fn);
  }
  emit(v: T): void {
    for (const fn of this.listeners) fn(v);
  }
  get size(): number {
    return this.listeners.size;
  }
}

const mockClient = {
  importSession: vi.fn(async () => undefined),
  connect: vi.fn(async () => undefined),
  startUpdatesLoop: vi.fn(async () => undefined),
  destroy: vi.fn(async () => undefined),
  sendText: vi.fn(async () => ({ id: 999 })),
  onNewMessage: new MockEmitter<unknown>(),
  onEditMessage: new MockEmitter<unknown>(),
  onRawUpdate: new MockEmitter<unknown>(),
};

const TelegramClientCtor = vi.fn().mockImplementation(() => mockClient);

vi.mock("@mtcute/node", () => ({
  MemoryStorage: class {},
  TelegramClient: TelegramClientCtor,
}));

let Driver: typeof DriverType;

beforeEach(async () => {
  vi.clearAllMocks();
  mockClient.onNewMessage = new MockEmitter<unknown>();
  mockClient.onEditMessage = new MockEmitter<unknown>();
  mockClient.onRawUpdate = new MockEmitter<unknown>();
  Driver = (await import("../telegram-plugin/uat/driver.js")).Driver;
});

afterEach(() => {
  // Drop the dynamic-import cache so each test sees a fresh module
  // graph. Without this, a future refactor that moves state to
  // module scope would silently leak across tests.
  vi.resetModules();
});

describe("Driver.connect", () => {
  it("creates an mtcute client with MemoryStorage, imports session with force=true, then connects", async () => {
    // fails when: a future refactor drops `force: true` on
    // importSession — mtcute treats the missing-prior-session as
    // authoritative and silently ignores ours, leaving the client
    // unauthenticated. The smoke scenario would then hang on the
    // first send instead of failing fast at connect.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();

    expect(TelegramClientCtor).toHaveBeenCalledTimes(1);
    const ctorArgs = TelegramClientCtor.mock.calls[0]?.[0] as {
      storage: object;
      apiId: number;
      apiHash: string;
    };
    expect(ctorArgs.apiId).toBe(1);
    expect(ctorArgs.apiHash).toBe("h");
    expect(ctorArgs.storage).toBeDefined();
    expect(ctorArgs.storage.constructor.name).toBe("MemoryStorage");

    expect(mockClient.importSession).toHaveBeenCalledWith("S", true);
    expect(mockClient.connect).toHaveBeenCalledTimes(1);

    const importOrder = mockClient.importSession.mock.invocationCallOrder[0];
    const connectOrder = mockClient.connect.mock.invocationCallOrder[0];
    expect(importOrder).toBeLessThan(connectOrder!);
  });

  it("calls startUpdatesLoop after connect so onNewMessage / onEditMessage fire for live updates", async () => {
    // fails when: someone "simplifies" the connect chain by dropping
    // the startUpdatesLoop call — `client.connect()` alone opens the
    // transport but DOES NOT start dispatching incoming updates to
    // the parsed emitters. Symptom is silent: messages arrive in
    // Telegram (visible in the chat) but `observeMessages` never
    // yields them, and `expectMessage` waits the full timeout. Took
    // a debug session against a real bot reply to find the first
    // time; this test exists so the second time is a unit-test
    // failure on the PR, not a 90-second timeout in CI.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    expect(mockClient.startUpdatesLoop).toHaveBeenCalledTimes(1);
    const connectOrder = mockClient.connect.mock.invocationCallOrder[0];
    const loopOrder = mockClient.startUpdatesLoop.mock.invocationCallOrder[0];
    // Loop must start AFTER connect — calling startUpdatesLoop before
    // there's a transport throws.
    expect(connectOrder).toBeLessThan(loopOrder!);
  });
});

describe("Driver.sendText", () => {
  it("forwards messageThreadId via replyTo so messages route into the right forum topic", async () => {
    // fails when: a refactor drops the messageThreadId→replyTo
    // mapping — mtcute then sends to the supergroup's "general" topic
    // and the UAT scenario observes its message in the wrong topic,
    // typically presenting as `expectMessage` timing out because
    // the per-topic observer filter rejects it.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();

    await driver.sendText(-1001234567890, "hi", { messageThreadId: 42 });
    expect(mockClient.sendText).toHaveBeenCalledWith(
      -1001234567890,
      "hi",
      { replyTo: 42 },
    );
  });

  it("explicit replyTo (quote-reply) takes precedence over messageThreadId", async () => {
    // fails when: the precedence is flipped — quoting a specific
    // message would silently route to the wrong topic instead.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();

    await driver.sendText(-100, "quote", { messageThreadId: 10, replyTo: 555 });
    expect(mockClient.sendText).toHaveBeenCalledWith(-100, "quote", {
      replyTo: 555,
    });
  });

  it("omits the params object when no thread or reply target is given", async () => {
    // fails when: a refactor always passes `{ replyTo: undefined }`,
    // which some mtcute versions reject with VALIDATE_ERROR. Cleanest
    // is to pass undefined as the params entirely.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();

    await driver.sendText(-100, "bare");
    expect(mockClient.sendText).toHaveBeenCalledWith(-100, "bare", undefined);
  });
});

describe("Driver.observeMessages", () => {
  function fakeMessage(opts: {
    chatId: number;
    id: number;
    text: string;
    threadId?: number;
    fromBot?: boolean;
  }): unknown {
    return {
      id: opts.id,
      text: opts.text,
      date: new Date(),
      chat: { id: opts.chatId },
      sender: { type: "user", isBot: opts.fromBot === true },
      replyToMessage: opts.threadId !== undefined
        ? { threadId: opts.threadId }
        : undefined,
    };
  }

  it("yields onNewMessage events filtered by chatId and threadId", async () => {
    // fails when: filtering moves to a post-yield consumer. Topics
    // generate ~50-100 incidental system events per run; pushing the
    // filter into the iterator keeps scenarios reading only what they
    // asked for and prevents queue blow-up.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeMessages(-100, { threadId: 7 })[Symbol.asyncIterator]();

    mockClient.onNewMessage.emit(fakeMessage({ chatId: -999, id: 1, text: "wrong chat" }));
    mockClient.onNewMessage.emit(fakeMessage({ chatId: -100, id: 2, text: "wrong thread", threadId: 8 }));
    mockClient.onNewMessage.emit(fakeMessage({ chatId: -100, id: 3, text: "match", threadId: 7 }));

    const first = await iter.next();
    expect(first.done).toBe(false);
    const m = first.value as ObservedMessage;
    expect(m.messageId).toBe(3);
    expect(m.text).toBe("match");
    expect(m.threadId).toBe(7);
    expect(m.edited).toBe(false);

    await iter.return?.();
  });

  it("emits onEditMessage as observations with edited=true", async () => {
    // fails when: edit tracking is dropped — the progress-card
    // lifecycle scenario relies on observing edits to a pinned card
    // to confirm the working→done phase transition.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeMessages(-100)[Symbol.asyncIterator]();

    mockClient.onEditMessage.emit(fakeMessage({ chatId: -100, id: 5, text: "edited" }));
    const first = await iter.next();
    const m = first.value as ObservedMessage;
    expect(m.messageId).toBe(5);
    expect(m.edited).toBe(true);

    await iter.return?.();
  });

  it("removes listeners on iterator return so closed scenarios don't leak handlers", async () => {
    // fails when: cleanup is dropped — listener Set grows across
    // scenarios and the same Message ends up dispatched to every
    // historical observer. Second scenario in a session sees ghost
    // matches and flakes.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    expect(mockClient.onNewMessage.size).toBe(0);

    const iter = driver.observeMessages(-100)[Symbol.asyncIterator]();
    expect(mockClient.onNewMessage.size).toBe(1);
    expect(mockClient.onEditMessage.size).toBe(1);

    await iter.return?.();
    expect(mockClient.onNewMessage.size).toBe(0);
    expect(mockClient.onEditMessage.size).toBe(0);

    const after = await iter.next();
    expect(after.done).toBe(true);
  });
});

describe("Driver.observeReactions", () => {
  // Helper — build a raw `updateMessageReactions` shape.
  function rxUpdate(opts: {
    peerUserId: number;
    msgId: number;
    emojis: string[];
  }): { update: unknown } {
    return {
      update: {
        _: "updateMessageReactions",
        peer: { _: "peerUser", userId: opts.peerUserId },
        msgId: opts.msgId,
        reactions: {
          results: opts.emojis.map((e) => ({
            reaction: { _: "reactionEmoji", emoticon: e },
          })),
        },
      },
    };
  }

  it("emits a `+emoji` op on first reaction", async () => {
    // fails when: the prior-set diff logic loses its initial empty
    // baseline — first reaction wouldn't be classified as "new" and
    // expectReaction would time out on the very first emoji.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeReactions(8288144562, { messageId: 67050 })[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit(rxUpdate({
      peerUserId: 8288144562,
      msgId: 67050,
      emojis: ["👀"],
    }));
    const first = await iter.next();
    expect(first.done).toBe(false);
    const r = first.value as { emoji: string; op: string };
    expect(r.emoji).toBe("👀");
    expect(r.op).toBe("+");
    await iter.return?.();
  });

  it("computes -old +new when setMessageReaction replaces the prior emoji", async () => {
    // fails when: the diff direction inverts (would emit -new instead
    // of -old) or the prior set isn't updated, producing duplicate
    // emissions on the next call. Pins the gateway's actual
    // call pattern: setMessageReaction REPLACES, doesn't add.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeReactions(8288144562, { messageId: 67050 })[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit(rxUpdate({
      peerUserId: 8288144562, msgId: 67050, emojis: ["👀"],
    }));
    mockClient.onRawUpdate.emit(rxUpdate({
      peerUserId: 8288144562, msgId: 67050, emojis: ["👍"],
    }));
    // Order: +👀, then on the replace event +👍 + -👀 (order of those
    // last two doesn't matter, but both must come through).
    const ops: Array<{ emoji: string; op: string }> = [];
    for (let i = 0; i < 3; i++) {
      const n = await iter.next();
      if (n.done) break;
      const v = n.value as { emoji: string; op: string };
      ops.push({ emoji: v.emoji, op: v.op });
    }
    expect(ops).toEqual(expect.arrayContaining([
      { emoji: "👀", op: "+" },
      { emoji: "👍", op: "+" },
      { emoji: "👀", op: "-" },
    ]));
    await iter.return?.();
  });

  it("filters out updates for the wrong chat or message", async () => {
    // fails when: the chat/msg filter widens — scenarios would see
    // reactions from every chat the driver is part of, flooding the
    // queue and likely matching unrelated emoji shapes by accident.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeReactions(8288144562, { messageId: 67050 })[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit(rxUpdate({ peerUserId: 99, msgId: 67050, emojis: ["💩"] }));
    mockClient.onRawUpdate.emit(rxUpdate({ peerUserId: 8288144562, msgId: 1, emojis: ["💩"] }));
    mockClient.onRawUpdate.emit(rxUpdate({ peerUserId: 8288144562, msgId: 67050, emojis: ["👀"] }));
    const first = await iter.next();
    const r = first.value as { emoji: string };
    expect(r.emoji).toBe("👀");
    await iter.return?.();
  });

  it("skips custom-emoji reactions (out of scope for Phase 2b)", async () => {
    // fails when: someone adds support for `reactionCustomEmoji`
    // without resolving the document_id to an alias. Custom emojis
    // would leak through as opaque "documentId=..." strings and break
    // expectReaction's exact-match.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeReactions(8288144562, { messageId: 67050 })[Symbol.asyncIterator]();
    mockClient.onRawUpdate.emit({
      update: {
        _: "updateMessageReactions",
        peer: { _: "peerUser", userId: 8288144562 },
        msgId: 67050,
        reactions: {
          results: [
            { reaction: { _: "reactionCustomEmoji", documentId: { high: 0, low: 1 } } },
            { reaction: { _: "reactionEmoji", emoticon: "👀" } },
          ],
        },
      },
    });
    const first = await iter.next();
    const r = first.value as { emoji: string };
    expect(r.emoji).toBe("👀"); // custom emoji silently skipped
    await iter.return?.();
  });

  it("removes its onRawUpdate listener on iterator return", async () => {
    // fails when: cleanup is dropped — `onRawUpdate` listeners
    // accumulate across scenarios. Unlike `onNewMessage`, the raw
    // update fires for EVERY Telegram event the driver receives
    // (typing, presence, etc.), so a leaked listener is much
    // louder than for the message observer.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    expect(mockClient.onRawUpdate.size).toBe(0);
    const iter = driver.observeReactions(8288144562)[Symbol.asyncIterator]();
    expect(mockClient.onRawUpdate.size).toBe(1);
    await iter.return?.();
    expect(mockClient.onRawUpdate.size).toBe(0);
  });
});

describe("Driver lifecycle", () => {
  it("disconnect is safe to call without connect()", async () => {
    // fails when: a refactor removes the `if (!this.client) return`
    // guard — scenarios that throw during connect leave a corrupted
    // Driver, and tearDown's idempotent disconnect would then throw,
    // masking the original failure.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await expect(driver.disconnect()).resolves.toBeUndefined();
    expect(mockClient.destroy).not.toHaveBeenCalled();
  });

  it("sendText before connect() throws a clear error pointing at connect()", async () => {
    // fails when: the requireClient guard is dropped — sendText would
    // dereference a null client and throw a TypeError that doesn't
    // point at the missing connect() call, leaving the operator
    // wondering what's wrong.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await expect(driver.sendText(-100, "x")).rejects.toThrow(/call connect/);
  });
});
