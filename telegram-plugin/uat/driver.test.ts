/**
 * Unit tests for the UAT mtcute driver wrapper.
 *
 * These mock `@mtcute/node`; no real network or session string is
 * required. The real-Telegram side lives in `uat/scenarios/`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Driver as DriverType, ObservedMessage } from "./driver.js";

// Lightweight Emitter mirror — mtcute uses @fuman/utils `Emitter`,
// but the driver only touches `add`/`remove` so an in-process mock
// suffices.
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
}

const mockClient = {
  importSession: vi.fn(async () => undefined),
  connect: vi.fn(async () => undefined),
  destroy: vi.fn(async () => undefined),
  sendText: vi.fn(async () => ({ id: 999 })),
  onNewMessage: new MockEmitter<unknown>(),
  onEditMessage: new MockEmitter<unknown>(),
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
  Driver = (await import("./driver.js")).Driver;
});

afterEach(() => {
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

    // Import must come before connect or mtcute will dial the
    // primary DC with no auth key.
    const importOrder = mockClient.importSession.mock.invocationCallOrder[0];
    const connectOrder = mockClient.connect.mock.invocationCallOrder[0];
    expect(importOrder).toBeLessThan(connectOrder!);
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
    // This mirrors Bot API behaviour where `reply_to_message_id`
    // overrides `message_thread_id`.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();

    await driver.sendText(-100, "quote", { messageThreadId: 10, replyTo: 555 });
    expect(mockClient.sendText).toHaveBeenCalledWith(-100, "quote", {
      replyTo: 555,
    });
  });

  it("omits the params object when no thread or reply target is given", async () => {
    // fails when: a refactor always passes `{ replyTo: undefined }`,
    // which some mtcute versions treat as "no thread" but others
    // (esp. older patch versions in this repo's lockfile band) reject
    // with VALIDATE_ERROR. Cleanest is to pass undefined as the
    // params, not an object with an undefined field.
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
    // fails when: filtering moves to a post-yield consumer (e.g. the
    // scenario does its own filter). Server-side topics generate
    // ~50-100 incidental messages/run from join/leave/system events;
    // pushing the filter into the iterator keeps scenarios reading
    // only what they asked for and prevents queue blow-up.
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
    // lifecycle test relies on observing edits to a pinned card
    // message to confirm the working→done phase transition. Without
    // edit-as-observation, the test would have to poll the card
    // message by id, missing the precise edit timing.
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

  it("removes listeners when the iterator is returned, so closed scenarios don't leak handlers", async () => {
    // fails when: cleanup is dropped — handlers accumulate across
    // scenarios and the same `Message` ends up dispatched to every
    // historical observer. The smoke test passes; the second
    // scenario in a session sees ghost matches and flakes.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await driver.connect();
    const iter = driver.observeMessages(-100)[Symbol.asyncIterator]();

    // Internal: MockEmitter exposes `listeners` via its Set — we
    // can't inspect it directly, so emit before/after return and
    // check that no value gets queued post-close.
    await iter.return?.();
    mockClient.onNewMessage.emit(fakeMessage({ chatId: -100, id: 99, text: "post-close" }));

    const after = await iter.next();
    expect(after.done).toBe(true);
  });
});

describe("Driver lifecycle", () => {
  it("disconnect is safe to call without connect()", async () => {
    // fails when: a refactor removes the `if (!this.client) return`
    // guard — scenarios that throw during connect leave a corrupted
    // `Driver` instance, and tearDown's idempotent disconnect would
    // then throw, masking the original failure.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await expect(driver.disconnect()).resolves.toBeUndefined();
    expect(mockClient.destroy).not.toHaveBeenCalled();
  });

  it("sendText before connect() throws a clear error", async () => {
    // fails when: the requireClient guard is dropped — sendText would
    // dereference a null client and throw a TypeError that doesn't
    // point at the missing connect() call.
    const driver = new Driver({ apiId: 1, apiHash: "h", session: "S" });
    await expect(driver.sendText(-100, "x")).rejects.toThrow(/call connect/);
  });
});
