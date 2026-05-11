/**
 * Eventual-assertion helpers for UAT scenarios.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/866
 *
 * Real Telegram is eventually consistent across the bot API, MTProto,
 * and CDN edges. Every assertion in a UAT scenario is a `waitFor`-
 * shape: poll a predicate until it goes truthy or a deadline trips.
 * Avoid `setTimeout(..., N); expect(...)` patterns at all cost.
 */

import type { Driver, ObservedMessage, ObservedReaction } from "./driver.js";

export interface PollOptions {
  /** Hard deadline; the predicate must resolve truthy before this. */
  timeout: number;
  /** Poll cadence in ms. Default 250ms. */
  interval?: number;
}

/**
 * Poll `predicate` every `interval` ms until it returns a truthy
 * value, then resolve with that value. Reject when `timeout` ms
 * elapse without success.
 *
 * The predicate may throw — exceptions are caught and treated as a
 * "not yet" signal until the deadline. The last-seen exception is
 * attached to the timeout error so flakes are debuggable.
 */
export async function pollUntil<T>(
  predicate: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  opts: PollOptions,
): Promise<T> {
  const interval = opts.interval ?? 250;
  const deadline = Date.now() + opts.timeout;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result as T;
    } catch (err) {
      lastError = err;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(interval, remaining));
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`pollUntil: deadline exceeded after ${opts.timeout}ms${detail}`);
}

/**
 * Sugar over `pollUntil` for the boolean-predicate case where the
 * caller wants a clear assertion message.
 */
export async function expectEventually(
  predicate: () => Promise<boolean> | boolean,
  opts: PollOptions,
  msg: string,
): Promise<void> {
  await pollUntil(async () => {
    const ok = await predicate();
    return ok || undefined;
  }, opts).catch((err) => {
    throw new Error(`expectEventually(${msg}): ${(err as Error).message}`);
  });
}

// ---------- Phase 2a (DM smoke) ----------

export interface ExpectMessageOptions extends PollOptions {
  threadId?: number;
  /**
   * Filter the observed stream by sender. `userId` matches exact
   * senders; `notUserId` excludes a specific sender (used by the
   * harness to translate `from: "bot"` into "anyone but the driver").
   */
  senderFilter?: { userId: number } | { notUserId: number };
}

/**
 * Wait for the next message in `chatId` (optionally a forum topic)
 * matching `match` — a substring, regex, or predicate over the raw
 * `ObservedMessage`. Returns the matched message.
 *
 * The implementation iterates the live `driver.observeMessages`
 * stream, so messages sent *before* the call started are not
 * considered; backfill is a Phase 2b helper.
 */
export async function expectMessage(
  driver: Driver,
  chatId: number,
  match: string | RegExp | ((m: ObservedMessage) => boolean),
  opts: ExpectMessageOptions,
): Promise<ObservedMessage> {
  const predicate = compileMatcher(match);
  const senderOk = compileSenderFilter(opts.senderFilter);
  const iter = driver.observeMessages(chatId, opts.threadId !== undefined ? { threadId: opts.threadId } : undefined)[Symbol.asyncIterator]();
  const deadline = Date.now() + opts.timeout;

  try {
    while (Date.now() < deadline) {
      // Race the next observation against the remaining timeout so
      // we don't hang forever if no messages arrive.
      const remaining = deadline - Date.now();
      const next = await raceTimeout(iter.next(), remaining);
      if (next === "timeout") break;
      if (next.done === true) break;
      const msg = next.value;
      if (!senderOk(msg)) continue;
      if (predicate(msg)) return msg;
    }
  } finally {
    await iter.return?.();
  }
  throw new Error(
    `expectMessage: no matching message in chat=${chatId} within ${opts.timeout}ms`,
  );
}

function compileMatcher(
  match: string | RegExp | ((m: ObservedMessage) => boolean),
): (m: ObservedMessage) => boolean {
  if (typeof match === "string") return (m) => m.text.includes(match);
  if (match instanceof RegExp) return (m) => match.test(m.text);
  return match;
}

function compileSenderFilter(
  f: ExpectMessageOptions["senderFilter"],
): (m: ObservedMessage) => boolean {
  if (!f) return () => true;
  if ("userId" in f) return (m) => m.senderUserId === f.userId;
  return (m) => m.senderUserId !== f.notUserId;
}

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  if (ms <= 0) return Promise.resolve("timeout");
  return new Promise<T | "timeout">((resolve) => {
    const t = setTimeout(() => resolve("timeout"), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch(() => {
      clearTimeout(t);
      resolve("timeout");
    });
  });
}

// ---------- Phase 2b stubs (deferred to follow-up PR) ----------

/**
 * Wait for a reaction `sequence` on `messageId` in `chatId`. Each
 * emoji must appear (as an add `+` op) in the order given;
 * intermediate add/remove ops for other emojis are tolerated.
 *
 * Returns the full observed trail (every add/remove seen up to and
 * including the final match) so scenarios can do follow-up
 * assertions on the order or count.
 *
 * Production note: the gateway calls `setMessageReaction` which
 * REPLACES the prior emoji (not adds-in-addition-to). So an
 * 👀 → 🤔 transition emits `-👀` and `+🤔` in the same observation
 * window. This helper only watches the `+` ops, so the
 * gateway-replace pattern reads as a clean sequence.
 *
 * Fast-turn note: turns shorter than the gateway's
 * `progress-card initialDelayMs` may collapse intermediate
 * reactions — you might only see 👀 and 👍. The sequence-match
 * tolerates this: every emoji in `sequence` must appear in order,
 * but we don't require it to be the ONLY emojis added.
 */
export async function expectReaction(
  driver: Driver,
  chatId: number,
  messageId: number,
  sequence: string[],
  opts: PollOptions,
): Promise<ObservedReaction[]> {
  if (sequence.length === 0) {
    throw new Error("expectReaction: sequence must be non-empty");
  }
  const trail: ObservedReaction[] = [];
  const iter = driver.observeReactions(chatId, { messageId })[Symbol.asyncIterator]();
  const deadline = Date.now() + opts.timeout;
  let cursor = 0;
  try {
    while (Date.now() < deadline && cursor < sequence.length) {
      const remaining = deadline - Date.now();
      const next = await raceTimeout(iter.next(), remaining);
      if (next === "timeout") break;
      if (next.done === true) break;
      const r = next.value;
      trail.push(r);
      if (r.op === "+" && r.emoji === sequence[cursor]) {
        cursor++;
      }
    }
  } finally {
    await iter.return?.();
  }
  if (cursor < sequence.length) {
    throw new Error(
      `expectReaction: saw ${cursor}/${sequence.length} expected emoji ` +
        `(missing ${sequence.slice(cursor).map((e) => JSON.stringify(e)).join(", ")}) ` +
        `on chat=${chatId} msg=${messageId} within ${opts.timeout}ms ` +
        `(observed ops: ${trail.map((t) => `${t.op}${t.emoji}`).join(" ")})`,
    );
  }
  return trail;
}

export interface PinnedCardSnapshot {
  messageId: number;
  text: string;
  html?: string;
  /** Production phase markers: `boot` | `working` | `done` | `error`. */
  phase: string;
}

/**
 * TODO(#866): wait for a pinned message to appear in
 * `chatId`/topic (the progress card). Resolves with a snapshot of
 * its current text/phase.
 */
export async function expectPinnedCard(
  _driver: Driver,
  _chatId: number,
  _opts: PollOptions & { threadId?: number },
): Promise<PinnedCardSnapshot> {
  throw new Error("expectPinnedCard not implemented (Phase 2)");
}

/**
 * TODO(#866): wait for the pinned progress card to transition to
 * `phase`. The harness must read live edits, not just the snapshot
 * captured by `expectPinnedCard`.
 */
export async function waitForCardPhase(
  _driver: Driver,
  _card: PinnedCardSnapshot,
  _phase: "boot" | "working" | "done" | "error",
  _opts: PollOptions,
): Promise<PinnedCardSnapshot> {
  throw new Error("waitForCardPhase not implemented (Phase 2)");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
