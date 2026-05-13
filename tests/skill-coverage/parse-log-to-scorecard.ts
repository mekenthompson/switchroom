#!/usr/bin/env bun
/**
 * Read the streaming log emitted by `cli-claude.ts` and emit a
 * scorecard from results so far. Lets you check in a baseline
 * mid-run without waiting for the full corpus.
 *
 * Usage:
 *   bun tests/skill-coverage/parse-log-to-scorecard.ts /tmp/skill-coverage-run.log
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { scoreRun, renderMarkdown } from "./harness/score.js";
import type { ProbeRecord } from "./corpus/types.js";
import type { ProbeResult, RunRecord } from "./harness/types.js";

const LINE_RE =
  /^\[skill-coverage-claude\] \((\d+)\/(\d+)\) (paraphrase|typo|slang|indirect|negative) target=([^\s]+) → (.+?) \((\d+)ms\)$/;

function loadCorpus(dir: string): ProbeRecord[] {
  const out: ProbeRecord[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as ProbeRecord);
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function buildProbeKey(p: ProbeRecord): string {
  return `${p.kind}|${p.targetSkill ?? "<neg>"}|${p.phrase.length}`;
}

function main(): void {
  const logPath = process.argv[2];
  const outBase = process.argv[3] ?? resolve(process.cwd(), "tests/skill-coverage/out/skill-coverage-claude");
  if (!logPath) {
    process.stderr.write("usage: parse-log-to-scorecard.ts <logfile> [outBase]\n");
    process.exit(2);
  }
  const log = readFileSync(logPath, "utf-8");
  const corpusDir = resolve(process.cwd(), "tests/skill-coverage/corpus");
  const corpus = loadCorpus(corpusDir);

  // We don't know which CORPUS probes were used by the runner without
  // re-running with the same seed + limit. But for the partial
  // scorecard we can synthesize ProbeRecord-shaped values from the
  // log alone: kind + targetSkill are captured per line, phrase isn't.
  // The scorer only needs probe.targetSkill + skillsInvoked.
  const results: ProbeResult[] = [];
  for (const line of log.split("\n")) {
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const [, _i, _n, kind, targetStr, status, msStr] = m;
    const targetSkill = targetStr === "<neg>" ? null : targetStr!;
    const skillsInvoked =
      status === "<no-skill>" || status === "TIMEOUT" ? [] : status!.split(",");
    const probe: ProbeRecord = {
      id: `partial-${results.length}`,
      kind: kind as ProbeRecord["kind"],
      targetSkill,
      phrase: "",
    };
    results.push({
      probe,
      skillsInvoked,
      turnDurationMs: Number.parseInt(msStr!, 10),
      timedOut: status === "TIMEOUT",
      agentName: "claude-cli",
    });
  }
  if (results.length === 0) {
    process.stderr.write("[parse-log] no probe rows in log; aborting\n");
    process.exit(1);
  }
  const run: RunRecord = {
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    seed: 1,
    agentName: "claude-cli",
    results,
  };
  const card = scoreRun(run);
  mkdirSync(dirname(outBase), { recursive: true });
  writeFileSync(`${outBase}.partial.run.json`, JSON.stringify(run, null, 2));
  writeFileSync(`${outBase}.partial.scorecard.json`, JSON.stringify(card, null, 2));
  writeFileSync(`${outBase}.partial.scorecard.md`, renderMarkdown(card));
  void corpus;
  process.stderr.write(
    `[parse-log] wrote ${outBase}.partial.{run.json,scorecard.json,scorecard.md} from ${results.length} probes\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
