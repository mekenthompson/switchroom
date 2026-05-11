/**
 * Unit tests for `telegram-plugin/uat/assertions.ts:expectMessage`.
 * Covers matcher precedence + sender filter + timeout behaviour. The
 * progress-card / reaction helpers are still stubs and roll in with
 * #866 Phase 2b.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/866
 */

import { describe, expect, it } from "vitest";
import {
  expectMessage,
  expectPinnedCard,
  expectReaction,
  waitForCardPhase,
  type PinnedCardSnapshot,
} from "../telegram-plugin/uat/assertions.js";
import type {
  Driver,
  ObservedMessage,
  ObservedPin,
  ObservedReaction,
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

function stubReactionDriver(reactions: ObservedReaction[]): Driver {
  return {
    observeReactions(_chatId: number, _opts?: { messageId?: number }): AsyncIterable<ObservedReaction> {
      let i = 0;
      return {
        [Symbol.asyncIterator](): AsyncIterator<ObservedReaction> {
          return {
            next(): Promise<IteratorResult<ObservedReaction>> {
              if (i < reactions.length) {
                return Promise.resolve({ value: reactions[i++]!, done: false });
              }
              return new Promise(() => {});
            },
            return(): Promise<IteratorResult<ObservedReaction>> {
              return Promise.resolve({ value: undefined as never, done: true });
            },
          };
        },
      };
    },
  } as unknown as Driver;
}

function rx(emoji: string, op: "+" | "-"): ObservedReaction {
  return { chatId: 100, messageId: 5, emoji, op, date: new Date() };
}

describe("expectReaction: sequence matching", () => {
  it("matches an in-order add sequence", async () => {
    // fails when: the cursor-advance logic is dropped — observing
    // [+👀, +🤔, +🔥, +👍] would only advance once and the helper
    // would time out claiming we saw 1/4. This is the foundational
    // shape: each emoji in `sequence` must appear in order.
    const trail = await expectReaction(
      stubReactionDriver([rx("👀", "+"), rx("🤔", "+"), rx("🔥", "+"), rx("👍", "+")]),
      100,
      5,
      ["👀", "🤔", "🔥", "👍"],
      { timeout: 1000 },
    );
    expect(trail).toHaveLength(4);
    expect(trail.every((t) => t.op === "+")).toBe(true);
  });

  it("tolerates intermediate -remove ops (gateway's setMessageReaction REPLACES)", async () => {
    // fails when: the matcher accidentally counts `-` ops toward the
    // sequence — the gateway emits `-old +new` on every replace, so
    // for a fast-turn 👀→👍 trail we see [+👀, +👍, -👀]; if `-👀`
    // counted, the cursor would mis-advance and the sequence would
    // be considered already-complete.
    const trail = await expectReaction(
      stubReactionDriver([rx("👀", "+"), rx("👍", "+"), rx("👀", "-")]),
      100,
      5,
      ["👀", "👍"],
      { timeout: 1000 },
    );
    expect(trail.filter((t) => t.op === "+").map((t) => t.emoji)).toEqual(["👀", "👍"]);
  });

  it("tolerates intermediate other-emoji adds (extra reactions don't break the match)", async () => {
    // fails when: scenarios that share the chat with concurrent
    // activity (a human reacting to the same message, future
    // multi-driver tests) flake because the unrelated reaction
    // collides with the sequence cursor.
    const trail = await expectReaction(
      stubReactionDriver([rx("👀", "+"), rx("💩", "+"), rx("👍", "+")]),
      100,
      5,
      ["👀", "👍"],
      { timeout: 1000 },
    );
    expect(trail).toHaveLength(3);
  });

  it("times out with a useful error mentioning the missing emoji + observed trail", async () => {
    // fails when: the timeout error loses the trail summary — a CI
    // flake report would say "missing 👍" without any indication
    // that the bot DID set 👀 and 🤔 first, which would change the
    // debugging direction from "gateway broken" to "fast-turn
    // suppression collapsing 🔥 and 👍".
    await expect(
      expectReaction(
        stubReactionDriver([rx("👀", "+"), rx("🤔", "+")]),
        100,
        5,
        ["👀", "🤔", "🔥", "👍"],
        { timeout: 80 },
      ),
    ).rejects.toThrow(/2\/4.*missing.*"🔥".*"👍".*\+👀.*\+🤔/s);
  });

  it("rejects an empty sequence", async () => {
    // fails when: the empty-guard is dropped — a scenario that
    // accidentally passes [] would silently "succeed" without
    // observing anything, lulling the author into false confidence.
    await expect(
      expectReaction(stubReactionDriver([]), 100, 5, [], { timeout: 100 }),
    ).rejects.toThrow(/non-empty/);
  });

  it("doesn't hang past the deadline on a silent stream", async () => {
    // fails when: the inner iter.next() isn't raced against the
    // deadline — silent reaction stream would hang the test runner
    // until vitest's per-test timeout fires.
    const t0 = Date.now();
    await expect(
      expectReaction(
        stubReactionDriver([]),
        100, 5, ["👀"], { timeout: 80 },
      ),
    ).rejects.toThrow();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------- Pinned-card scenarios ----------

interface PinCardStubBehaviour {
  pins?: ObservedPin[];
  edits?: ObservedMessage[];
  fetchById?: (id: number) => ObservedMessage | null;
}

function stubPinDriver(b: PinCardStubBehaviour): Driver {
  return {
    observePins(_chatId: number): AsyncIterable<ObservedPin> {
      const items = b.pins ?? [];
      let i = 0;
      return {
        [Symbol.asyncIterator](): AsyncIterator<ObservedPin> {
          return {
            next(): Promise<IteratorResult<ObservedPin>> {
              if (i < items.length) {
                return Promise.resolve({ value: items[i++]!, done: false });
              }
              return new Promise(() => {});
            },
            return(): Promise<IteratorResult<ObservedPin>> {
              return Promise.resolve({ value: undefined as never, done: true });
            },
          };
        },
      };
    },
    observeMessages(_chatId: number): AsyncIterable<ObservedMessage> {
      const items = b.edits ?? [];
      let i = 0;
      return {
        [Symbol.asyncIterator](): AsyncIterator<ObservedMessage> {
          return {
            next(): Promise<IteratorResult<ObservedMessage>> {
              if (i < items.length) {
                return Promise.resolve({ value: items[i++]!, done: false });
              }
              return new Promise(() => {});
            },
            return(): Promise<IteratorResult<ObservedMessage>> {
              return Promise.resolve({ value: undefined as never, done: true });
            },
          };
        },
      };
    },
    getMessage(_chatId: number, messageId: number): Promise<ObservedMessage | null> {
      const fetched = b.fetchById?.(messageId) ?? null;
      return Promise.resolve(fetched);
    },
  } as unknown as Driver;
}

function pin(messageId: number, pinned: boolean): ObservedPin {
  return { chatId: 100, messageId, pinned, date: new Date() };
}

function fakeEdit(messageId: number, text: string): ObservedMessage {
  return {
    chatId: 100,
    messageId,
    text,
    senderUserId: 555,
    fromBot: true,
    date: new Date(),
    edited: true,
  };
}

function fetchedMsg(messageId: number, text: string): ObservedMessage {
  return {
    chatId: 100,
    messageId,
    text,
    senderUserId: 555,
    fromBot: true,
    date: new Date(),
    edited: false,
  };
}

describe("expectPinnedCard", () => {
  it("returns a snapshot with parsed phase on first pinned event", async () => {
    // fails when: the snapshot loses the chatId — waitForCardPhase
    // needs it to subscribe to observeMessages, and dropping it
    // would force callers to pass it again at every transition,
    // re-introducing the kind of binding bug we just fixed with the
    // sendDM closure capture.
    const driver = stubPinDriver({
      pins: [pin(42, true)],
      fetchById: () => fetchedMsg(42, "⏳ Starting…"),
    });
    const snap = await expectPinnedCard(driver, 100, { timeout: 1000 });
    expect(snap.chatId).toBe(100);
    expect(snap.messageId).toBe(42);
    expect(snap.phase).toBe("boot");
    expect(snap.text).toContain("Starting");
  });

  it("skips unpin events and keeps waiting for the next pin", async () => {
    // fails when: unpin events are treated as matches — the gateway
    // does pin → unpin → re-pin during reflow; matching on the first
    // unpin would surface a stale card text.
    const driver = stubPinDriver({
      pins: [pin(99, false), pin(42, true)],
      fetchById: () => fetchedMsg(42, "🤖 Working…"),
    });
    const snap = await expectPinnedCard(driver, 100, { timeout: 1000 });
    expect(snap.messageId).toBe(42);
    expect(snap.phase).toBe("working");
  });

  it("keeps polling when getMessage returns null (race against delete)", async () => {
    // fails when: a refactor treats null-result as a fatal error
    // and aborts — a pin event then a quick edit-delete-edit cycle
    // would crash the scenario instead of recovering on the next
    // pin/edit.
    let calls = 0;
    const driver = stubPinDriver({
      pins: [pin(42, true), pin(43, true)],
      fetchById: (id) => {
        calls++;
        return id === 43 ? fetchedMsg(43, "✅ Done") : null;
      },
    });
    const snap = await expectPinnedCard(driver, 100, { timeout: 1000 });
    expect(snap.messageId).toBe(43);
    expect(calls).toBe(2);
  });

  it("times out with a chat-id-bearing error when no pin arrives", async () => {
    // fails when: the error message loses the chat_id, making CI
    // flake reports ambiguous between "card never pinned" and "wrong
    // chat being watched".
    const driver = stubPinDriver({ pins: [] });
    await expect(
      expectPinnedCard(driver, 100, { timeout: 80 }),
    ).rejects.toThrow(/chat=100.*80ms/);
  });
});

describe("waitForCardPhase", () => {
  function snap(phase: PinnedCardSnapshot["phase"], text: string): PinnedCardSnapshot {
    return { chatId: 100, messageId: 42, text, phase };
  }

  it("resolves immediately when the input snapshot is already at the target phase", async () => {
    // fails when: the fast-path early-return is removed — a scenario
    // that observes the very first card-render at "done" (fast turn
    // with delay_ms small) would re-subscribe to observeMessages and
    // wait forever for an edit that never comes.
    const driver = stubPinDriver({ edits: [] });
    const result = await waitForCardPhase(driver, snap("done", "✅ Done"), "done", { timeout: 100 });
    expect(result.phase).toBe("done");
  });

  it("matches the FIRST edit that detects the target phase", async () => {
    // fails when: the matcher accumulates instead of short-circuits
    // — long-running scenarios would skip the early "done" edit and
    // race a later turn's "working" edit, returning the wrong card.
    const driver = stubPinDriver({
      edits: [
        fakeEdit(42, "🤖 Working on item 1…"),
        fakeEdit(42, "🤖 Working on item 2…"),
        fakeEdit(42, "✅ Done — 2 items"),
      ],
    });
    const result = await waitForCardPhase(driver, snap("boot", "⏳ Starting"), "done", { timeout: 1000 });
    expect(result.phase).toBe("done");
    expect(result.text).toContain("Done");
  });

  it("ignores edits to other messages in the chat (multi-card chats)", async () => {
    // fails when: the messageId filter is dropped — a chat with two
    // concurrent agents would interleave their card edits and the
    // helper would resolve on the wrong agent's "done".
    const driver = stubPinDriver({
      edits: [
        fakeEdit(99, "✅ Done — different card"),
        fakeEdit(42, "✅ Done — our card"),
      ],
    });
    const result = await waitForCardPhase(driver, snap("working", "🤖"), "done", { timeout: 1000 });
    expect(result.messageId).toBe(42);
    expect(result.text).toContain("our card");
  });

  it("times out with a message-id-bearing error when phase never lands", async () => {
    // fails when: the error message loses the message_id, making
    // a stuck-card report ambiguous about which card is misbehaving.
    const driver = stubPinDriver({
      edits: [fakeEdit(42, "🤖 Working forever…")],
    });
    await expect(
      waitForCardPhase(driver, snap("working", "🤖"), "done", { timeout: 80 }),
    ).rejects.toThrow(/card 42.*phase="done".*80ms/);
  });
});

describe("detectPhase (via expectPinnedCard)", () => {
  it("classifies ✅ → done, ❌ → error, 🤖 → working, ⏳ → boot", async () => {
    // fails when: the phase regexes drift away from the production
    // markers — would cause every UAT scenario that asserts a phase
    // to either fail with "unknown" or grab the wrong phase.
    const cases: Array<{ text: string; phase: string }> = [
      { text: "✅ Done — 3 items", phase: "done" },
      { text: "❌ Failed: timeout", phase: "error" },
      { text: "🤖 Working on tool call…", phase: "working" },
      { text: "⏳ Starting up…", phase: "boot" },
      { text: "completely off-script text", phase: "unknown" },
    ];
    for (const { text, phase } of cases) {
      const driver = stubPinDriver({
        pins: [pin(1, true)],
        fetchById: () => fetchedMsg(1, text),
      });
      const result = await expectPinnedCard(driver, 100, { timeout: 200 });
      expect(result.phase).toBe(phase);
    }
  });
});
