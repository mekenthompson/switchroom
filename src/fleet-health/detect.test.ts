import { describe, it, expect } from "vitest";
import {
  scanAgent,
  parseTurns,
  detectTurnFindings,
  detectGatewayFindings,
  HANG_MS,
  SILENT_NOOP_FLOOR_TS,
  ROUTE_FIELD_SHIP_TS,
} from "./detect.js";

/**
 * Pins the model-free L0 detector port (from the validated `spec_audit_l0.py`):
 * the tuned hang threshold, the `synthetic-` exclusion, and the precise gateway
 * signatures. All fixtures use SYNTHETIC turn ids — never a real Telegram id.
 */

// Synthetic origin_turn_ids: `<synthetic-chat>:_#<seq>`.
const CHAT = "77770001";

function turn(seq: number, over: Record<string, unknown>): string {
  return JSON.stringify({
    ts: 1_782_600_000 + seq,
    agent: "alpha",
    turn_id: `${CHAT}:_#${seq}`,
    status: "complete",
    tools: 5,
    duration_ms: 40_000,
    ...over,
  });
}

describe("parseTurns", () => {
  it("skips malformed lines without throwing", () => {
    const text = [turn(1, {}), "{not json", "", turn(2, {})].join("\n");
    expect(parseTurns(text)).toHaveLength(2);
  });
});

describe("detectTurnFindings", () => {
  it("flags a silent no-op (complete, zero tools, real turn)", () => {
    // Fixture base ts (1_782_600_000 ≈ 2026-06-27) is BELOW the default
    // SILENT_NOOP_FLOOR_TS (2026-07-13), so pass floor:0 to assert the detector
    // LOGIC independent of the calendar window. `route:'none'` isolates the
    // silent-noop path from the PR "turn-honesty" route age-out (a genuine
    // silence: nothing reached the user).
    const turns = parseTurns(turn(10, { tools: 0, route: "none" }));
    const f = detectTurnFindings("alpha", turns, { silentNoopFloorTs: 0 });
    expect(f.map((x) => x.signal)).toContain("silent-no-op-candidate");
  });

  it("windows OUT a silent no-op whose ts is below the floor (Fix 2)", () => {
    // Same complete/zero-tool route:'none' turn, but under the default floor its
    // 2026-06-27 ts is pre-fix backlog → it must NOT be flagged. (route:'none'
    // so the ONLY thing suppressing it is the silent-noop floor, not the route
    // age-out.)
    const turns = parseTurns(turn(10, { tools: 0, route: "none" }));
    const f = detectTurnFindings("alpha", turns);
    expect(f.map((x) => x.signal)).not.toContain("silent-no-op-candidate");
  });

  it("flags a silent no-op whose ts is AT/ABOVE the default floor (Fix 2)", () => {
    // A post-fix route:'none' turn (ts at the 2026-07-13 floor) is still a real
    // signal — the windowing must not swallow go-forward silent no-ops.
    const turns = parseTurns(
      turn(10, { tools: 0, route: "none", ts: SILENT_NOOP_FLOOR_TS + 100 }),
    );
    const f = detectTurnFindings("alpha", turns);
    expect(f.map((x) => x.signal)).toContain("silent-no-op-candidate");
  });

  it("does NOT flag a synthetic zero-tool turn as a silent no-op", () => {
    const turns = parseTurns(
      JSON.stringify({
        turn_id: `${CHAT}:_#synthetic-boot`,
        status: "complete",
        tools: 0,
        duration_ms: 1000,
      }),
    );
    const f = detectTurnFindings("alpha", turns);
    expect(f.map((x) => x.signal)).not.toContain("silent-no-op-candidate");
  });

  it("flags a killed/incomplete turn", () => {
    const turns = parseTurns(turn(11, { status: "killed", tools: 3 }));
    const f = detectTurnFindings("alpha", turns);
    expect(f.map((x) => x.signal)).toContain("killed-incomplete-turn");
  });

  it("does not flag no_reply as incomplete", () => {
    const turns = parseTurns(turn(12, { status: "no_reply", tools: 1 }));
    const f = detectTurnFindings("alpha", turns);
    expect(f.map((x) => x.signal)).not.toContain("killed-incomplete-turn");
  });

  it("flags send_failed as its own signal, NOT the killed catch-all (Fix 2)", () => {
    // gateway PR B writes status=send_failed when a turn-flush answer failed to
    // reach the user. It must surface as `send-failed-delivery` (a delivery
    // failure), not be miscategorised as `killed-incomplete-turn` (killed
    // mid-run) — which would corrupt that signal's meaning.
    const turns = parseTurns(turn(15, { status: "send_failed", tools: 0 }));
    const signals = detectTurnFindings("alpha", turns).map((x) => x.signal);
    expect(signals).toContain("send-failed-delivery");
    expect(signals).not.toContain("killed-incomplete-turn");
    // and a send_failed turn with tools:0 must NOT be a silent-no-op (it is an
    // honest delivery failure, not a benign complete-zero-tools turn).
    expect(signals).not.toContain("silent-no-op-candidate");
  });

  // PR "turn-honesty" — the delivery ROUTE splits the once-monolithic
  // silent-no-op finding. These assert the OUTCOME per route and would FAIL on
  // pre-PR code (which flagged EVERY complete+tools:0 row as sev-3 silent-no-op
  // regardless of route, and had no `flush-recovered-turn` signal at all).
  it("route 'flush' → flush-recovered-turn, NOT a silent no-op (turn-honesty)", () => {
    // A complete/tools:0 turn the backstop DELIVERED. The user got the answer —
    // it must be the informational flush-recovered signal, never the sev-3 alarm.
    const turns = parseTurns(turn(20, { tools: 0, route: "flush" }));
    const signals = detectTurnFindings("alpha", turns, {
      silentNoopFloorTs: 0,
    }).map((x) => x.signal);
    expect(signals).toContain("flush-recovered-turn");
    expect(signals).not.toContain("silent-no-op-candidate");
  });

  it("route 'none' → keeps the sev-3 silent-no-op alarm (turn-honesty)", () => {
    // A complete row where NOTHING reached the user is a broken delivery
    // invariant — it must still escalate as a silent no-op.
    const turns = parseTurns(turn(21, { tools: 0, route: "none" }));
    const signals = detectTurnFindings("alpha", turns, {
      silentNoopFloorTs: 0,
    }).map((x) => x.signal);
    expect(signals).toContain("silent-no-op-candidate");
    expect(signals).not.toContain("flush-recovered-turn");
  });

  it("route 'reply' / 'stream' → NO finding (agent delivered its own answer)", () => {
    for (const route of ["reply", "stream"] as const) {
      const turns = parseTurns(turn(22, { tools: 0, route }));
      const signals = detectTurnFindings("alpha", turns, {
        silentNoopFloorTs: 0,
      }).map((x) => x.signal);
      expect(signals).not.toContain("silent-no-op-candidate");
      expect(signals).not.toContain("flush-recovered-turn");
    }
  });

  it("route ABSENT + ts BELOW the ship floor → aged out, no sev-3 (turn-honesty)", () => {
    // Legacy pre-route backlog: complete/tools:0, no `route`, ts above the
    // silent-noop floor but below the route-field ship epoch. It must NOT fire
    // sev-3 (that is the 131-turn backlog the PR stops from firing forever).
    const turns = parseTurns(
      turn(23, { tools: 0, ts: ROUTE_FIELD_SHIP_TS - 100 }),
    );
    const signals = detectTurnFindings("alpha", turns, {
      silentNoopFloorTs: 0,
    }).map((x) => x.signal);
    expect(signals).not.toContain("silent-no-op-candidate");
    expect(signals).not.toContain("flush-recovered-turn");
  });

  it("route ABSENT + ts AT/ABOVE the ship floor → sev-3 (anomalous post-ship row)", () => {
    // After the route field ships every real row carries a route; a route-less
    // complete/tools:0 row dated after the ship epoch is itself anomalous and
    // must escalate.
    const turns = parseTurns(
      turn(24, { tools: 0, ts: ROUTE_FIELD_SHIP_TS + 100 }),
    );
    const signals = detectTurnFindings("alpha", turns, {
      silentNoopFloorTs: 0,
    }).map((x) => x.signal);
    expect(signals).toContain("silent-no-op-candidate");
  });

  it("drops a row whose `agent` field disagrees with the scanned agent (turn-honesty)", () => {
    // The `chartestagent` fixture rows written into a LIVE turns.jsonl must NOT
    // be attributed to the agent whose directory is being scanned.
    const turns = parseTurns(
      turn(25, { tools: 0, route: "none", agent: "chartestagent" }),
    );
    const findings = detectTurnFindings("alpha", turns, {
      silentNoopFloorTs: 0,
    });
    expect(findings).toHaveLength(0);
  });

  it("keeps a row with a MATCHING `agent` field (guard is a mismatch drop only)", () => {
    const turns = parseTurns(
      turn(26, { tools: 0, route: "none", agent: "alpha" }),
    );
    const signals = detectTurnFindings("alpha", turns, {
      silentNoopFloorTs: 0,
    }).map((x) => x.signal);
    expect(signals).toContain("silent-no-op-candidate");
  });

  it("flags a hang only when long AND stalled (few tools)", () => {
    const stalled = parseTurns(turn(13, { duration_ms: HANG_MS + 1, tools: 1 }));
    const productive = parseTurns(turn(14, { duration_ms: HANG_MS + 1, tools: 9 }));
    expect(detectTurnFindings("alpha", stalled).map((x) => x.signal)).toContain(
      "hang-long-stalled",
    );
    expect(
      detectTurnFindings("alpha", productive).map((x) => x.signal),
    ).not.toContain("hang-long-stalled");
  });
});

describe("detectGatewayFindings", () => {
  const log = [
    `2026-07-02T21:03:00Z gateway: represent duplicate-send tid=${CHAT}:_#42`,
    `2026-07-02T21:04:00Z gateway: tg-post method=getUpdates status=err timeout`,
    `2026-07-02T21:05:00Z gateway: tg-post method=sendRichMessage tid=${CHAT}:_#43 status=err`,
    `2026-07-02T21:06:00Z gateway: obligation escalation tid=${CHAT}:_#44`,
  ].join("\n");

  it("counts represent-duplicate and reply-delivery-failure, ignores getUpdates blip", () => {
    const { gw_hits } = detectGatewayFindings("alpha", log);
    expect(gw_hits["duplicate-delivery-represent"]).toBe(1);
    expect(gw_hits["reply-delivery-failure"]).toBe(1);
    expect(gw_hits["represent-escalation"]).toBe(1);
  });

  it("extracts turn_id + ts into the finding", () => {
    const { findings } = detectGatewayFindings("alpha", log);
    const dup = findings.find((f) => f.signal === "duplicate-delivery-represent");
    expect(dup?.turn_id).toBe(`${CHAT}:_#42`);
    expect(dup?.ts).toBe("2026-07-02T21:03:00Z");
  });
});

describe("scanAgent escalation decision", () => {
  it("escalates on a duplicate-send hit", () => {
    const res = scanAgent(
      "alpha",
      turn(1, {}),
      "gateway: represent duplicate-send tid=x",
    );
    expect(res.escalate).toBe(true);
  });

  it("does NOT escalate on a represent-escalation alone", () => {
    const res = scanAgent("alpha", turn(1, {}), "gateway: obligation escalation");
    expect(res.escalate).toBe(false);
  });

  it("stays clean on a healthy agent", () => {
    const res = scanAgent("alpha", turn(1, {}) + "\n" + turn(2, {}), "");
    expect(res.escalate).toBe(false);
    expect(res.findings).toHaveLength(0);
  });

  it("does NOT escalate a flush-recovered turn (informational, turn-honesty)", () => {
    // A flush-delivered complete/tools:0 turn produces one flush-recovered
    // finding and zero silent-no-op findings, and MUST NOT escalate — the user
    // got the answer; it is a latency trend, not an alarm.
    const res = scanAgent("alpha", turn(30, { tools: 0, route: "flush" }), "", {
      silentNoopFloorTs: 0,
    });
    expect(res.findings.map((f) => f.signal)).toEqual(["flush-recovered-turn"]);
    expect(res.escalate).toBe(false);
  });

  it("escalates a route:'none' complete/tools:0 turn (broken invariant)", () => {
    const res = scanAgent("alpha", turn(31, { tools: 0, route: "none" }), "", {
      silentNoopFloorTs: 0,
    });
    expect(res.findings.map((f) => f.signal)).toContain("silent-no-op-candidate");
    expect(res.escalate).toBe(true);
  });
});
