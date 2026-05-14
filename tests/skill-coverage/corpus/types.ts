/**
 * Shared corpus types for the probabilistic skill-coverage harness.
 *
 * A `ProbeRecord` is a single natural-language utterance the harness
 * will inject at a running agent. The `targetSkill` is the skill the
 * authors expect to fire (or `null` for a negative control); the
 * runner records which skills actually fired and the score module
 * computes precision / recall / F1 per skill.
 */

export type ProbeKind =
  | "paraphrase"
  | "typo"
  | "slang"
  | "indirect"
  | "negative";

export interface ProbeRecord {
  /** Stable hash(skill+kind+phrase+seed) — deterministic across runs. */
  id: string;
  /**
   * Skill the corpus author expects to fire. `null` means this is a
   * negative control: no skill should fire (or at least, the target
   * should not).
   */
  targetSkill: string | null;
  kind: ProbeKind;
  phrase: string;
  /**
   * Optional: when this probe is a *negative for `targetSkill`* but
   * the corpus author thinks a DIFFERENT skill might legitimately
   * fire (cross-skill confusion test), record that skill here so the
   * scorer can spot bleed.
   */
  expectedOtherSkill?: string;
  /**
   * For audit/debug only — which corpus rule synthesised the phrase.
   */
  source: "paraphrase-template" | "typo-rule" | "slang-template" | "indirect-template" | "negative-from-adjacent" | "seed-yaml";
}

export interface SkillFixture {
  id: string;
  category: string;
  in_default_pool: boolean;
  user_invocable: boolean;
  description: string;
  trigger_phrases: string[];
  negatives: string[];
  adjacent_skills: string[];
  /**
   * Optional short clause prepended to generated rule-based probes
   * (paraphrase / typo / slang / indirect) to disambiguate the
   * skill's domain — e.g. `"Using the Buildkite CLI, "`. Author-curated
   * seed-yaml probes and negative controls are NOT prefixed (negatives
   * test cross-skill confusion; the prefix would defeat the test).
   */
  context_prefix?: string;
}

export interface SkillsFixtureFile {
  $comment?: string;
  skills: SkillFixture[];
}
