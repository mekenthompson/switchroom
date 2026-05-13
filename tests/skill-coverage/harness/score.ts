/**
 * Score module — consumes a RunRecord, emits per-skill precision /
 * recall / F1 + a markdown table.
 *
 * v1 definitions:
 *   - TRUE POSITIVE   : probe.targetSkill === S and S ∈ skillsInvoked
 *   - FALSE NEGATIVE  : probe.targetSkill === S and S ∉ skillsInvoked
 *   - FALSE POSITIVE  : probe.targetSkill !== S and S ∈ skillsInvoked
 *
 * `execSuccess` is a stub interface — v1 returns 1 when the target
 * skill fired at all. Wired through so a v2 implementation can plug
 * in artifact / tool-shape verification without changing the schema.
 *
 * `negativeControlFpRate`: fraction of negative-control probes
 * `(targetSkill=null)` where ANY skill fired. High values indicate
 * the agent is over-eager to load skills.
 */

import type { ProbeResult, RunRecord, Scorecard, SkillScorecardRow } from "./types.js";

export interface ScoringOptions {
  /** F1 threshold for the aggregate `skillsBelowF1Threshold` count. */
  f1Threshold?: number;
  /** Exec threshold for the aggregate `skillsBelowExecThreshold` count. */
  execThreshold?: number;
  /**
   * Plug point for v2 — given the events + target, decide whether the
   * skill *actually did its job*. v1 default just returns true.
   */
  execSuccessJudge?: (r: ProbeResult) => boolean;
}

/** Median of a numeric array; 0 on empty. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[m - 1] + s[m]) / 2 : s[m];
}

function f1(precision: number, recall: number): number {
  if (precision + recall === 0) return 0;
  return (2 * precision * recall) / (precision + recall);
}

export function scoreRun(run: RunRecord, opts: ScoringOptions = {}): Scorecard {
  const f1Threshold = opts.f1Threshold ?? 0.9;
  const execThreshold = opts.execThreshold ?? 0.95;
  const judge = opts.execSuccessJudge ?? (() => true);

  // Discover every skill that appears as either a target or as
  // invoked output — gives the row set a stable identity even when
  // a skill never fires.
  const allSkills = new Set<string>();
  for (const r of run.results) {
    if (r.probe.targetSkill) allSkills.add(r.probe.targetSkill);
    for (const s of r.skillsInvoked) allSkills.add(s);
    if (r.probe.expectedOtherSkill) allSkills.add(r.probe.expectedOtherSkill);
  }

  const rows: SkillScorecardRow[] = [];
  for (const skill of allSkills) {
    let tp = 0;
    let fn = 0;
    let fp = 0;
    let sample = 0;
    let execSuccessTimes = 0;
    let execSuccessTotal = 0;
    let negFpHits = 0;
    let negTotal = 0;
    for (const r of run.results) {
      const fired = r.skillsInvoked.includes(skill);
      const target = r.probe.targetSkill === skill;
      if (target) {
        sample++;
        if (fired) {
          tp++;
          execSuccessTotal++;
          if (judge(r)) execSuccessTimes++;
        } else {
          fn++;
        }
      } else if (fired) {
        // skillsInvoked contains this skill but it wasn't the target.
        // That's a false positive *for this skill*. Negative-control
        // probes (targetSkill === null) hit this branch AND also
        // increment negFpHits below — intentional double-accounting:
        // the per-skill `falsePositives` measures "this skill mis-fires"
        // while `negativeControlFpRate` measures "this skill fires on
        // probes meant for no-one". Both are needed.
        fp++;
      }
      // Negative-control accounting — only for probes whose target
      // is null (true negatives), check if THIS skill fired.
      if (r.probe.targetSkill === null) {
        negTotal++;
        if (fired) negFpHits++;
      }
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    rows.push({
      skill,
      sampleSize: sample,
      truePositives: tp,
      falseNegatives: fn,
      falsePositives: fp,
      precision,
      recall,
      f1: f1(precision, recall),
      execSuccess: execSuccessTotal === 0 ? 0 : execSuccessTimes / execSuccessTotal,
      negativeControlFpRate: negTotal === 0 ? 0 : negFpHits / negTotal,
    });
  }

  // Stable ordering: by skill id ascending.
  rows.sort((a, b) => a.skill.localeCompare(b.skill));

  const f1s = rows.filter((r) => r.sampleSize > 0).map((r) => r.f1);
  const skillsBelowF1Threshold = rows.filter(
    (r) => r.sampleSize > 0 && r.f1 < f1Threshold,
  ).length;
  const skillsBelowExecThreshold = rows.filter(
    (r) => r.sampleSize > 0 && r.execSuccess < execThreshold,
  ).length;

  return {
    generatedAt: new Date().toISOString(),
    seed: run.seed,
    totalProbes: run.results.length,
    rows,
    aggregate: {
      medianF1: median(f1s),
      skillsBelowF1Threshold,
      skillsBelowExecThreshold,
      f1Threshold,
      execThreshold,
    },
  };
}

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

export function renderMarkdown(card: Scorecard): string {
  const out: string[] = [];
  out.push(`# Skill coverage scorecard`);
  out.push("");
  out.push(`- generated: ${card.generatedAt}`);
  out.push(`- seed: ${card.seed}`);
  out.push(`- total probes: ${card.totalProbes}`);
  out.push(`- median F1 (among targeted skills): ${fmt(card.aggregate.medianF1)}`);
  out.push(
    `- skills below F1 ${fmt(card.aggregate.f1Threshold)}: **${card.aggregate.skillsBelowF1Threshold}**`,
  );
  out.push(
    `- skills below exec ${fmt(card.aggregate.execThreshold)}: **${card.aggregate.skillsBelowExecThreshold}**`,
  );
  out.push("");
  out.push("| skill | n | TP | FN | FP | precision | recall | F1 | exec | neg-FP |");
  out.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const r of card.rows) {
    out.push(
      `| ${r.skill} | ${r.sampleSize} | ${r.truePositives} | ${r.falseNegatives} | ${r.falsePositives} | ${fmt(r.precision)} | ${fmt(r.recall)} | ${fmt(r.f1)} | ${fmt(r.execSuccess)} | ${fmt(r.negativeControlFpRate)} |`,
    );
  }
  return out.join("\n") + "\n";
}
