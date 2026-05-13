/**
 * Runtime types for the harness — what runner.ts produces and what
 * score.ts consumes.
 */

import type { SessionEvent } from "../../../telegram-plugin/session-tail.js";
import type { ProbeRecord } from "../corpus/types.js";

export interface ProbeResult {
  probe: ProbeRecord;
  /** Skill names extracted from `tool_use` events where toolName === "Skill". */
  skillsInvoked: string[];
  turnDurationMs: number;
  timedOut: boolean;
  /** Optional — kept only when debugMode is on; useful for forensic diffs. */
  rawEvents?: SessionEvent[];
  /** ISO timestamp at which the inject happened. */
  injectedAt: string;
  /** Population label — agent name so multi-agent runs can be split. */
  agentName: string;
}

export interface RunRecord {
  startedAt: string;
  finishedAt: string;
  seed: number;
  agentName: string;
  results: ProbeResult[];
}

export interface SkillScorecardRow {
  skill: string;
  sampleSize: number;
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
  precision: number;
  recall: number;
  f1: number;
  /**
   * v1 stub — counts as 1 when the target skill fired at least once.
   * Wired so the v2 "did the skill actually finish its job" check can
   * slot in without changing the schema.
   */
  execSuccess: number;
  /** Negative-control probes where ANY skill fired (false positives on negatives). */
  negativeControlFpRate: number;
}

export interface Scorecard {
  generatedAt: string;
  seed: number;
  totalProbes: number;
  rows: SkillScorecardRow[];
  aggregate: {
    medianF1: number;
    skillsBelowF1Threshold: number;
    skillsBelowExecThreshold: number;
    f1Threshold: number;
    execThreshold: number;
  };
}
