/**
 * Score-module math tests. Canned ProbeResult inputs → expected F1
 * for hand-computed cases.
 */

import { describe, expect, it } from "vitest";
import type { ProbeRecord } from "../corpus/types.js";
import { median, renderMarkdown, scoreRun } from "../harness/score.js";
import type { ProbeResult, RunRecord } from "../harness/types.js";

function probe(target: string | null, phrase: string, kind: ProbeRecord["kind"] = "paraphrase"): ProbeRecord {
  return {
    id: phrase.slice(0, 16).padEnd(16, "_"),
    targetSkill: target,
    kind,
    phrase,
    source: "paraphrase-template",
  };
}

function result(target: string | null, invoked: string[]): ProbeResult {
  return {
    probe: probe(target, `phrase-${target}-${invoked.join(",")}`),
    skillsInvoked: invoked,
    turnDurationMs: 100,
    timedOut: false,
    injectedAt: "2025-01-01T00:00:00Z",
    agentName: "test-agent",
  };
}

function run(results: ProbeResult[]): RunRecord {
  return {
    startedAt: "2025-01-01T00:00:00Z",
    finishedAt: "2025-01-01T00:00:01Z",
    seed: 1,
    agentName: "test-agent",
    results,
  };
}

describe("score module", () => {
  it("computes median correctly", () => {
    expect(median([])).toBe(0);
    expect(median([1])).toBe(1);
    expect(median([1, 2, 3])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("perfect recall and precision yields F1 = 1.0", () => {
    const r = run([
      result("alpha", ["alpha"]),
      result("alpha", ["alpha"]),
      result("alpha", ["alpha"]),
    ]);
    const card = scoreRun(r);
    const alpha = card.rows.find((x) => x.skill === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.precision).toBe(1);
    expect(alpha!.recall).toBe(1);
    expect(alpha!.f1).toBe(1);
  });

  it("computes F1 for a mixed positive/negative case", () => {
    // 4 alpha probes; 3 fire alpha (TP), 1 fires nothing (FN).
    // 2 beta probes target beta but fire alpha → alpha gets 2 FP.
    // P_alpha = TP / (TP + FP) = 3/5 = 0.6
    // R_alpha = TP / (TP + FN) = 3/4 = 0.75
    // F1     = 2 * 0.6 * 0.75 / 1.35 ≈ 0.6667
    const r = run([
      result("alpha", ["alpha"]),
      result("alpha", ["alpha"]),
      result("alpha", ["alpha"]),
      result("alpha", []),
      result("beta", ["alpha"]),
      result("beta", ["alpha"]),
    ]);
    const card = scoreRun(r);
    const alpha = card.rows.find((x) => x.skill === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.truePositives).toBe(3);
    expect(alpha!.falseNegatives).toBe(1);
    expect(alpha!.falsePositives).toBe(2);
    expect(alpha!.precision).toBeCloseTo(0.6, 5);
    expect(alpha!.recall).toBeCloseTo(0.75, 5);
    expect(alpha!.f1).toBeCloseTo(0.6667, 3);
  });

  it("computes negative-control FP rate per skill", () => {
    // 3 negative probes, 1 fires alpha → alpha neg-FP = 1/3.
    const r = run([
      result(null, []),
      result(null, ["alpha"]),
      result(null, []),
      result("beta", ["beta"]),
    ]);
    const card = scoreRun(r);
    const alpha = card.rows.find((x) => x.skill === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.negativeControlFpRate).toBeCloseTo(1 / 3, 5);
    const beta = card.rows.find((x) => x.skill === "beta");
    expect(beta!.negativeControlFpRate).toBe(0);
  });

  it("counts skills below F1 threshold in aggregate", () => {
    const r = run([
      // alpha: perfect F1
      result("alpha", ["alpha"]),
      result("alpha", ["alpha"]),
      // beta: 0 recall (1 FN)
      result("beta", []),
    ]);
    const card = scoreRun(r, { f1Threshold: 0.9 });
    expect(card.aggregate.skillsBelowF1Threshold).toBe(1);
    expect(card.aggregate.medianF1).toBeGreaterThan(0);
  });

  it("renderMarkdown produces a non-empty table", () => {
    const r = run([result("alpha", ["alpha"]), result("beta", [])]);
    const md = renderMarkdown(scoreRun(r));
    expect(md).toContain("| skill |");
    expect(md).toContain("alpha");
    expect(md).toContain("beta");
  });

  it("execSuccess judge plug works", () => {
    let calls = 0;
    const judge = (): boolean => {
      calls++;
      return false; // every exec marked unsuccessful
    };
    const r = run([result("alpha", ["alpha"]), result("alpha", ["alpha"])]);
    const card = scoreRun(r, { execSuccessJudge: judge });
    const alpha = card.rows.find((x) => x.skill === "alpha");
    expect(calls).toBe(2);
    expect(alpha!.execSuccess).toBe(0);
  });
});
