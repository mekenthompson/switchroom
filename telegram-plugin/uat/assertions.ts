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

// ---------- Phase 2 stubs ----------

/**
 * TODO(#866): wait for the bot to send a message in `chatId`/topic
 * matching `match` (substring, regex, or predicate over the raw
 * `ObservedMessage`). Returns the matched message.
 */
export async function expectMessage(
  _driver: Driver,
  _chatId: number,
  _match: string | RegExp | ((m: ObservedMessage) => boolean),
  _opts: PollOptions & { threadId?: number; from?: "bot" | "user" },
): Promise<ObservedMessage> {
  throw new Error("expectMessage not implemented (Phase 2)");
}

/**
 * TODO(#866): wait for a reaction sequence on `messageId`. Each
 * emoji in `sequence` must appear (add op) in order; intermediate
 * other reactions are tolerated. Returns the full observed reaction
 * trail.
 */
export async function expectReaction(
  _driver: Driver,
  _chatId: number,
  _messageId: number,
  _sequence: string[],
  _opts: PollOptions,
): Promise<ObservedReaction[]> {
  throw new Error("expectReaction not implemented (Phase 2)");
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
