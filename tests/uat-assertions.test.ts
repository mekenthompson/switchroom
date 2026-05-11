/**
 * Unit tests for `telegram-plugin/uat/assertions.ts:expectMessage`.
 * Covers matcher precedence + sender filter + timeout behaviour. The
 * progress-card / reaction helpers are still stubs and roll in with
 * #866 Phase 2b.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/866
 */

import { describe, expect, it } from "vitest";
import { expectMessage } from "../telegram-plugin/uat/assertions.js";
import type {
  Driver,
  ObservedMessage,
} from "../telegram-plugin/uat/driver.js";

/**
 * Hand-rolled driver stub. The real `observeMessages` returns an
 * `AsyncIterable<ObservedMessage>`; here we yield a fixed buffer then
 * close, simulating a stream of messages arriving from Telegram.
 */
function stubDriver(messages: ObservedMessage[]): Driver {
  const stub = {
    observeMessages(_chatId: number): AsyncIterable<ObservedMessage> {
      let i = 0;
      return {
        [Symbol.asyncIterator](): AsyncIterator<ObservedMessage> {
          return {
            next(): Promise<IteratorResult<ObservedMessage>> {
              if (i < messages.length) {
                return Promise.resolve({ value: messages[i++]!, done: false });
              }
              // After draining, wait forever (until the deadline
              // races us). Real driver streams stay open indefinitely.
              return new Promise(() => {});
            },
            return(): Promise<IteratorResult<ObservedMessage>> {
              return Promise.resolve({ value: undefined as never, done: true });
            },
          };
        },
      };
    },
  };
  return stub as unknown as Driver;
}

function fakeMsg(opts: Partial<ObservedMessage> & { text: string; senderUserId: number }): ObservedMessage {
  return {
    chatId: -100,
    messageId: Math.floor(Math.random() * 1e6),
    text: opts.text,
    senderUserId: opts.senderUserId,
    fromBot: opts.fromBot ?? false,
    date: opts.date ?? new Date(),
    edited: opts.edited ?? false,
    threadId: opts.threadId,
  };
}

const BOT = 555_000_001;
const DRIVER = 8_248_703_757;

describe("expectMessage: matcher precedence", () => {
  it("string match uses substring (not exact) — bots add prose around the keyword", async () => {
    // fails when: string match flips to exact equality — every smoke
    // test breaks because the bot wraps the inbound in a chatty
    // response ("Hi! You said: uat-smoke ...").
    const driver = stubDriver([
      fakeMsg({ text: "Hi! You said: uat-smoke 2026-05-11", senderUserId: BOT }),
    ]);
    const m = await expectMessage(driver, BOT, "uat-smoke", { timeout: 1000 });
    expect(m.text).toContain("uat-smoke");
  });

  it("regex match runs `.test()` against the message text", async () => {
    // fails when: regex match is replaced with `.match()` returning
    // null vs a result — null is truthy in some contexts but falsy
    // here, so the test would flake.
    const driver = stubDriver([
      fakeMsg({ text: "✓ Done — 3 items", senderUserId: BOT }),
    ]);
    const m = await expectMessage(driver, BOT, /^[✓✅]\s+Done/, { timeout: 1000 });
    expect(m.text).toBe("✓ Done — 3 items");
  });

  it("predicate match gets the raw ObservedMessage (for assertions on edited / threadId / senderUserId)", async () => {
    // fails when: the predicate signature is narrowed to a string-only
    // input — scenarios that want to assert on edit-vs-new or thread
    // routing have no escape hatch.
    const driver = stubDriver([
      fakeMsg({ text: "first", senderUserId: BOT, edited: false }),
      fakeMsg({ text: "first (edited)", senderUserId: BOT, edited: true }),
    ]);
    const m = await expectMessage(driver, BOT, (msg) => msg.edited, { timeout: 1000 });
    expect(m.text).toBe("first (edited)");
  });
});

describe("expectMessage: sender filter", () => {
  it("from-bot translates to notUserId(driver) and skips driver echoes", async () => {
    // fails when: the sender filter swaps directions — bot replies
    // get skipped and the test times out waiting for its OWN message
    // back. This is the most common shape of UAT scenario, hence
    // pinning the direction explicitly.
    const driver = stubDriver([
      fakeMsg({ text: "uat-smoke from driver", senderUserId: DRIVER }),
      fakeMsg({ text: "bot reply", senderUserId: BOT }),
    ]);
    const m = await expectMessage(driver, BOT, /./, {
      timeout: 1000,
      senderFilter: { notUserId: DRIVER },
    });
    expect(m.senderUserId).toBe(BOT);
  });

  it("from-driver translates to userId(driver) and matches outbound echoes", async () => {
    // fails when: the userId filter is dropped — scenarios that
    // assert on "the driver's message was actually sent" can't
    // distinguish their send from the bot's quote.
    const driver = stubDriver([
      fakeMsg({ text: "uat-smoke from driver", senderUserId: DRIVER }),
      fakeMsg({ text: "you said: ...", senderUserId: BOT }),
    ]);
    const m = await expectMessage(driver, BOT, /./, {
      timeout: 1000,
      senderFilter: { userId: DRIVER },
    });
    expect(m.senderUserId).toBe(DRIVER);
  });
});

describe("expectMessage: timeout", () => {
  it("throws with a chat-id-bearing error when no match arrives before deadline", async () => {
    // fails when: the error message loses the chat_id — debugging
    // a flaky CI run means reading a stack trace; the chat_id is the
    // signal that lets you check whether the right chat was even
    // being watched.
    const driver = stubDriver([
      fakeMsg({ text: "wrong content", senderUserId: BOT }),
    ]);
    await expect(
      expectMessage(driver, -100, "needle", { timeout: 100 }),
    ).rejects.toThrow(/chat=-100.*100ms/);
  });

  it("does not hang past the timeout even when the stream is silent", async () => {
    // fails when: the inner iter.next() isn't raced against the
    // deadline — a silent stream would hang the entire test runner
    // until the vitest test-timeout (2 min) kicked in, masking the
    // real cause of the failure.
    const driver = stubDriver([]); // empty: iter.next() awaits forever
    const t0 = Date.now();
    await expect(
      expectMessage(driver, -100, /./, { timeout: 80 }),
    ).rejects.toThrow();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
  });
});
