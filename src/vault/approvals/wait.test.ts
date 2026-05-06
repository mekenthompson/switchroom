/**
 * Tests for {@link waitForApproval} (RFC C follow-up).
 *
 * The broker IPC layer is stubbed via the `_request` / `_lookup` / `_sleep`
 * test seams on {@link WaitForApprovalOpts}. No real timers, no sockets — all
 * sequencing is driven by hand-coded fakes so the suite finishes in a few ms
 * regardless of the production poll cadence (default 2s → 30s).
 */

import { describe, it, expect, vi } from "vitest";
import { waitForApproval } from "./wait.js";
import type {
  ApprovalLookupResult,
  ApprovalRequestResult,
} from "./client.js";
import type { ApprovalDecisionMeta } from "../broker/protocol.js";

function fakeDecision(
  partial: Partial<ApprovalDecisionMeta> = {},
): ApprovalDecisionMeta {
  return {
    id: "dec_1",
    agent_unit: "klanker",
    scope: "drive.read",
    action: "list",
    decision: "allow_once",
    granted_at: 1_700_000_000_000,
    granted_by_user_id: 42,
    ttl_expires_at: null,
    last_used_at: null,
    revoked_at: null,
    revoke_reason: null,
    ...partial,
  };
}

const baseOpts = {
  agent_unit: "klanker",
  scope: "drive.read",
  action: "list",
  approver_set: ["user:42"],
};

describe("waitForApproval", () => {
  it("happy path: pending → granted on second poll", async () => {
    const lookups: ApprovalLookupResult[] = [
      { state: "pending", decision: null },
      { state: "granted", decision: fakeDecision() },
    ];
    const sleepSpy = vi.fn(async () => {});
    const result = await waitForApproval({
      ...baseOpts,
      _request: async () =>
        ({
          state: "pending",
          request_id: "abc12345",
          expires_at: 9_999_999_999,
        }) satisfies ApprovalRequestResult,
      _lookup: async () => lookups.shift() ?? null,
      _sleep: sleepSpy,
    });
    expect(result).toEqual({
      kind: "decided",
      state: "granted",
      decision: fakeDecision(),
      request_id: "abc12345",
    });
    expect(sleepSpy).toHaveBeenCalled();
  });

  it("backoff intervals grow geometrically and cap at max_poll_ms", async () => {
    const calls: number[] = [];
    let polls = 0;
    const result = await waitForApproval({
      ...baseOpts,
      initial_poll_ms: 100,
      max_poll_ms: 500,
      backoff: 2,
      timeout_ms: 60_000,
      _request: async () => ({
        state: "pending",
        request_id: "rid",
        expires_at: 0,
      }),
      _lookup: async () => {
        polls += 1;
        if (polls < 6) return { state: "pending", decision: null };
        return { state: "granted", decision: fakeDecision() };
      },
      _sleep: async (ms) => {
        calls.push(ms);
      },
    });
    expect(result.kind).toBe("decided");
    // Sequence with backoff=2, cap=500: 100, 200, 400, 500, 500, 500.
    expect(calls.slice(0, 6)).toEqual([100, 200, 400, 500, 500, 500]);
  });

  it("timeout: returns { kind: 'timeout' } once timeout_ms elapses", async () => {
    let now = 0;
    const dateSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const result = await waitForApproval({
        ...baseOpts,
        timeout_ms: 1_000,
        initial_poll_ms: 250,
        backoff: 1,
        _request: async () => ({
          state: "pending",
          request_id: "rid",
          expires_at: 0,
        }),
        _lookup: async () => ({ state: "pending", decision: null }),
        _sleep: async (ms) => {
          now += ms;
        },
      });
      expect(result).toEqual({ kind: "timeout", request_id: "rid" });
    } finally {
      dateSpy.mockRestore();
    }
  });

  it("abort: returns { kind: 'aborted' } cleanly mid-wait", async () => {
    const ac = new AbortController();
    const result = await waitForApproval({
      ...baseOpts,
      signal: ac.signal,
      _request: async () => ({
        state: "pending",
        request_id: "rid",
        expires_at: 0,
      }),
      _lookup: async () => ({ state: "pending", decision: null }),
      _sleep: async () => {
        // Simulate an abort firing while "sleeping".
        ac.abort();
        throw new DOMException("Aborted", "AbortError");
      },
    });
    expect(result).toEqual({ kind: "aborted", request_id: "rid" });
  });

  it("abort before request: returns aborted without calling broker", async () => {
    const ac = new AbortController();
    ac.abort();
    const requestSpy = vi.fn();
    const result = await waitForApproval({
      ...baseOpts,
      signal: ac.signal,
      _request: requestSpy,
      _lookup: async () => null,
      _sleep: async () => {},
    });
    expect(result).toEqual({ kind: "aborted" });
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it("rate-limited up front: returns rate_limited without polling", async () => {
    const lookupSpy = vi.fn();
    const result = await waitForApproval({
      ...baseOpts,
      _request: async () => ({ state: "rate_limited", retry_after_ms: 1_500 }),
      _lookup: lookupSpy,
      _sleep: async () => {},
    });
    expect(result).toEqual({ kind: "rate_limited", retry_after_ms: 1_500 });
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it("drift_revoked mid-wait: surfaces drift_revoked", async () => {
    const lookups: ApprovalLookupResult[] = [
      { state: "pending", decision: null },
      { state: "drift_revoked", decision: null },
    ];
    const result = await waitForApproval({
      ...baseOpts,
      _request: async () => ({
        state: "pending",
        request_id: "rid",
        expires_at: 0,
      }),
      _lookup: async () => lookups.shift() ?? null,
      _sleep: async () => {},
    });
    expect(result).toEqual({ kind: "drift_revoked", request_id: "rid" });
  });

  it("expired (nonce TTL exceeded): surfaces expired", async () => {
    const result = await waitForApproval({
      ...baseOpts,
      _request: async () => ({
        state: "pending",
        request_id: "rid",
        expires_at: 0,
      }),
      _lookup: async () => ({ state: "expired", decision: null }),
      _sleep: async () => {},
    });
    expect(result).toEqual({ kind: "expired", request_id: "rid" });
  });

  it("denied: surfaces denied with the decision row", async () => {
    const denyDecision = fakeDecision({ id: "dec_2", decision: "deny" });
    const result = await waitForApproval({
      ...baseOpts,
      _request: async () => ({
        state: "pending",
        request_id: "rid",
        expires_at: 0,
      }),
      _lookup: async () => ({ state: "denied", decision: denyDecision }),
      _sleep: async () => {},
    });
    expect(result).toEqual({
      kind: "decided",
      state: "denied",
      decision: denyDecision,
      request_id: "rid",
    });
  });

  it("broker unreachable on request: returns error", async () => {
    const result = await waitForApproval({
      ...baseOpts,
      _request: async () => null,
      _lookup: async () => null,
      _sleep: async () => {},
    });
    expect(result).toEqual({ kind: "error", reason: "broker_unreachable" });
  });

  it("transient null lookups keep polling until decision", async () => {
    const lookups: (ApprovalLookupResult | null)[] = [
      null,
      null,
      { state: "granted", decision: fakeDecision() },
    ];
    const result = await waitForApproval({
      ...baseOpts,
      _request: async () => ({
        state: "pending",
        request_id: "rid",
        expires_at: 0,
      }),
      _lookup: async () => lookups.shift() ?? null,
      _sleep: async () => {},
    });
    expect(result.kind).toBe("decided");
  });
});
