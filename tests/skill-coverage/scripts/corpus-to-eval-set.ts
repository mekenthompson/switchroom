#!/usr/bin/env bun
/**
 * Convert tests/skill-coverage/corpus/<skill>.jsonl into the eval-set
 * format expected by skills/skill-creator/scripts/run_eval.py.
 *
 * Source rows: {id, targetSkill, kind, phrase, expectedOtherSkill?}
 * Output (JSON array): [{query, should_trigger}]
 *
 * Mapping rules:
 *   - probe.targetSkill === <skill>          → should_trigger: true
 *   - probe.targetSkill === null AND kind=="negative" → should_trigger: false
 *   - probe.targetSkill !== <skill> (positive for a sibling) → should_trigger: false
 *
 * Usage:
 *   bun tests/skill-coverage/scripts/corpus-to-eval-set.ts <skill> > /tmp/<skill>-evalset.json
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const skill = process.argv[2];
if (!skill) {
  process.stderr.write("usage: corpus-to-eval-set.ts <skill>\n");
  process.exit(2);
}

const corpusDir = resolve(process.cwd(), "tests/skill-coverage/corpus");
const out: Array<{ query: string; should_trigger: boolean }> = [];
const seen = new Set<string>();

for (const f of readdirSync(corpusDir).filter((f) => f.endsWith(".jsonl"))) {
  for (const line of readFileSync(join(corpusDir, f), "utf-8").split("\n")) {
    if (!line.trim()) continue;
    let p: { targetSkill: string | null; phrase: string };
    try {
      p = JSON.parse(line);
    } catch {
      continue;
    }
    if (!p.phrase) continue;
    if (seen.has(p.phrase)) continue;
    seen.add(p.phrase);
    out.push({ query: p.phrase, should_trigger: p.targetSkill === skill });
  }
}

// Stratify: rough balance — keep all positives + sample at most 2× positives from negatives.
const positives = out.filter((r) => r.should_trigger);
const negatives = out.filter((r) => !r.should_trigger);
const cap = Math.max(20, positives.length * 2);
const negSample = negatives.slice(0, cap);
const combined = [...positives, ...negSample];

process.stdout.write(JSON.stringify(combined, null, 2));
