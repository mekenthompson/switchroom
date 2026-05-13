/**
 * Runner unit test — uses fake inject + fake observer so no socket
 * or filesystem session-tail is touched.
 */

import { describe, expect, it } from "vitest";
import { runAll, runProbe } from "../harness/runner.js";
import type { SessionEvent } from "../../../telegram-plugin/session-tail.js";
import type { ProbeRecord } from "../corpus/types.js";

function fakeInject() {
  return async () => ({
    injectedAt: "2025-01-01T00:00:00.000Z",
    inboundId: "42",
    written: true,
  });
}

function fakeObserver(events: SessionEvent[]) {
  return () => ({
    start: async () => {},
    waitForTurnEnd: async () => ({ events: events.slice(), timedOut: false, durationMs: 250 }),
    stop: () => {},
  });
}

const skillToolUse = (skill: string): SessionEvent => ({
  kind: "tool_use",
  toolName: "Skill",
  toolUseId: `tu_${skill}`,
  input: { skill },
});

const turnEnd: SessionEvent = { kind: "turn_end", durationMs: 250 };

const baseProbe: ProbeRecord = {
  id: "probe1__________",
  targetSkill: "alpha",
  kind: "paraphrase",
  phrase: "do alpha",
  source: "paraphrase-template",
};

describe("runner", () => {
  it("extracts the invoked skill from tool_use events", async () => {
    const r = await runProbe(baseProbe, {
      agentName: "test-agent",
      agentCwd: "/tmp/fake",
      gatewaySocket: "/tmp/fake.sock",
      _inject: fakeInject(),
      _createObserver: fakeObserver([skillToolUse("alpha"), turnEnd]),
    });
    expect(r.skillsInvoked).toEqual(["alpha"]);
    expect(r.timedOut).toBe(false);
    expect(r.turnDurationMs).toBeGreaterThan(0);
  });

  it("returns empty skillsInvoked when nothing fires", async () => {
    const r = await runProbe(baseProbe, {
      agentName: "test-agent",
      agentCwd: "/tmp/fake",
      gatewaySocket: "/tmp/fake.sock",
      _inject: fakeInject(),
      _createObserver: fakeObserver([turnEnd]),
    });
    expect(r.skillsInvoked).toEqual([]);
  });

  it("treats inject failure as a timed-out probe", async () => {
    const failInject = async () => ({
      injectedAt: "2025-01-01T00:00:00.000Z",
      inboundId: "42",
      written: false,
      error: "boom",
    });
    const r = await runProbe(baseProbe, {
      agentName: "test-agent",
      agentCwd: "/tmp/fake",
      gatewaySocket: "/tmp/fake.sock",
      _inject: failInject,
      _createObserver: fakeObserver([turnEnd]),
    });
    expect(r.timedOut).toBe(true);
    expect(r.skillsInvoked).toEqual([]);
  });

  it("runAll iterates probes sequentially and preserves order", async () => {
    const probes: ProbeRecord[] = [
      { ...baseProbe, id: "p1______________", targetSkill: "alpha", phrase: "do alpha" },
      { ...baseProbe, id: "p2______________", targetSkill: "beta", phrase: "do beta" },
    ];
    const run = await runAll(probes, {
      agentName: "test-agent",
      agentCwd: "/tmp/fake",
      gatewaySocket: "/tmp/fake.sock",
      _inject: fakeInject(),
      _createObserver: fakeObserver([skillToolUse("alpha"), turnEnd]),
    }, 1);
    expect(run.results.length).toBe(2);
    expect(run.results.map((r) => r.probe.id)).toEqual([
      "p1______________",
      "p2______________",
    ]);
  });
});
