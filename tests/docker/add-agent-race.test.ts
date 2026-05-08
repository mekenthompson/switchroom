/**
 * Phase 1b race test — broker-level injection model (per dispatch Q2).
 *
 * The brief's race scenario is "newbie agent comes online while the
 * fleet is processing concurrent inbound messages; verify zero drops
 * and no container RestartCount drift". For Phase 1b we exercise the
 * deterministic core that the gateway sits on top of: the scheduler's
 * dispatch fan-out + audit-write path under sustained load. The
 * gateway-level Telegram-wire-protocol race lives at the v1.0 release
 * E2E gate, where real bot tokens are available.
 *
 * Threshold constants per the dispatch:
 *   - 90s window, 2s interval → 45 messages
 *   - 0 dropped messages tolerated
 *   - "first reply" within 60s wall-clock from add-agent invocation
 *
 * Test execution time: shortened from 90s to ~9s (45 messages, 200ms
 * interval) so the test fits a normal CI budget. The thresholds the
 * test asserts are unchanged. The 90s wall-clock variant is gated
 * behind SWITCHROOM_RACE_LONG=1 for manual operator runs.
 */

import { describe, it, expect } from "vitest";
import {
  dispatchEntry,
  type ExecRunner,
  type SchedulerEntry,
} from "../../src/scheduler/dispatch.js";
import { InMemoryAuditSink } from "../../src/scheduler/audit.js";

const LONG_MODE = process.env.SWITCHROOM_RACE_LONG === "1";
const TOTAL_MESSAGES = 45;
const INTERVAL_MS = LONG_MODE ? 2_000 : 200;
const FIRST_REPLY_BUDGET_MS = 60_000;

function makeEntry(i: number, agent: string): SchedulerEntry {
  return {
    agent,
    scheduleIndex: 0,
    cron: "* * * * *",
    prompt: `msg-${i}`,
    promptKey: `key-${i.toString(16).padStart(8, "0")}`,
  };
}

describe("phase1b add-agent race (broker-level injection model)", () => {
  it(
    "dispatches 45 messages with 0 drops and first reply within 60s",
    async () => {
      const audit = new InMemoryAuditSink();
      // Stub runner: deterministic 50-150ms latency, never fails. Models
      // a healthy `docker exec` round-trip without needing a live daemon.
      const runner: ExecRunner = (_args, stdin) =>
        new Promise((resolve) => {
          const latency = 50 + Math.floor(Math.random() * 100);
          setTimeout(
            () => resolve({ exitCode: 0, output: `ack:${stdin}` }),
            latency,
          );
        });

      const startedAt = Date.now();
      const inFlight: Promise<unknown>[] = [];
      let firstNewbieReplyAt: number | null = null;

      // Mid-stream, simulate "newbie agent comes online" by switching the
      // target agent name from "alpha" to "newbie" at message 20. This
      // matches the brief's 'first reply within 60s from add-agent'
      // threshold — we measure newbie's first dispatch finish.
      let newbieDispatchedAt: number | null = null;

      for (let i = 0; i < TOTAL_MESSAGES; i++) {
        const agent = i < 20 ? "alpha" : "newbie";
        if (agent === "newbie" && newbieDispatchedAt === null) {
          newbieDispatchedAt = Date.now();
        }
        const p = dispatchEntry(makeEntry(i, agent), runner).then((r) => {
          audit.recordFire(r);
          if (r.agent === "newbie" && firstNewbieReplyAt === null) {
            firstNewbieReplyAt = Date.now();
          }
          return r;
        });
        inFlight.push(p);
        if (i < TOTAL_MESSAGES - 1) {
          await new Promise((res) => setTimeout(res, INTERVAL_MS));
        }
      }

      const results = await Promise.all(inFlight);
      const finishedAt = Date.now();

      // Assertion 1: zero drops — every dispatch produced an audit row.
      expect(audit.fires).toHaveLength(TOTAL_MESSAGES);
      expect(results).toHaveLength(TOTAL_MESSAGES);

      // Assertion 2: every result was a clean exit. A "drop" in the
      // brief's sense includes errored-out dispatches.
      const errored = results.filter((r) => r.exitCode !== 0);
      expect(errored).toHaveLength(0);

      // Assertion 3: prompt keys all distinct (ordering preserved, no
      // collisions through the audit sink).
      const keys = new Set(audit.fires.map((f) => f.promptKey));
      expect(keys.size).toBe(TOTAL_MESSAGES);

      // Assertion 4: newbie's first reply landed within the 60s budget
      // measured from when newbie was introduced.
      expect(newbieDispatchedAt).not.toBeNull();
      expect(firstNewbieReplyAt).not.toBeNull();
      const firstReplyLatency = firstNewbieReplyAt! - newbieDispatchedAt!;
      expect(firstReplyLatency).toBeGreaterThanOrEqual(0);
      expect(firstReplyLatency).toBeLessThan(FIRST_REPLY_BUDGET_MS);

      // Diagnostic — surfaced in vitest output for trend tracking.
      const totalDuration = finishedAt - startedAt;
      const dropCount = TOTAL_MESSAGES - audit.fires.length;
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          test: "add-agent-race",
          total_messages: TOTAL_MESSAGES,
          drops: dropCount,
          duration_ms: totalDuration,
          first_reply_latency_ms: firstReplyLatency,
          long_mode: LONG_MODE,
        }),
      );
    },
    LONG_MODE ? 120_000 : 30_000,
  );
});
