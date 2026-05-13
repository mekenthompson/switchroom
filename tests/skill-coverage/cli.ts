/**
 * CLI entrypoint:
 *   bun run tests/skill-coverage/cli.ts <agent-name> \
 *     [--skills=a,b] [--limit-per-skill=N] [--seed=N] \
 *     [--gateway-socket=/path/to/gateway.sock] \
 *     [--agent-cwd=/path/to/agent/cwd] \
 *     [--out=/path/to/scorecard-base]
 *
 * Writes:
 *   <out>.run.json     — RunRecord
 *   <out>.scorecard.json
 *   <out>.scorecard.md
 *
 * DOES NOT execute against a real agent automatically — the actual
 * end-to-end probe firing is gated behind --go to keep this script
 * safe to import / dry-run.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateCorpus, writeCorpusFiles } from "./corpus/generate-corpus.js";
import { loadCorpus, runAll } from "./harness/runner.js";
import { renderMarkdown, scoreRun } from "./harness/score.js";
import type { ProbeRecord } from "./corpus/types.js";

interface CliArgs {
  agentName: string | null;
  skills: string[] | null;
  limitPerSkill: number | null;
  seed: number;
  gatewaySocket: string | null;
  agentCwd: string | null;
  outBase: string;
  go: boolean;
  regenCorpus: boolean;
}

function parse(argv: string[]): CliArgs {
  const out: CliArgs = {
    agentName: null,
    skills: null,
    limitPerSkill: null,
    seed: 1,
    gatewaySocket: null,
    agentCwd: null,
    outBase: resolve(process.cwd(), "tests/skill-coverage/out/skill-coverage"),
    go: false,
    regenCorpus: false,
  };
  for (const a of argv) {
    if (!a.startsWith("--")) {
      if (!out.agentName) out.agentName = a;
      continue;
    }
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    switch (k) {
      case "skills": out.skills = (v ?? "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "limit-per-skill": out.limitPerSkill = v ? Number(v) : null; break;
      case "seed": out.seed = v ? Number(v) : 1; break;
      case "gateway-socket": out.gatewaySocket = v ?? null; break;
      case "agent-cwd": out.agentCwd = v ?? null; break;
      case "out": out.outBase = v ? resolve(v) : out.outBase; break;
      case "go": out.go = true; break;
      case "regen-corpus": out.regenCorpus = true; break;
    }
  }
  return out;
}

function trimPerSkill(probes: ProbeRecord[], limit: number | null): ProbeRecord[] {
  if (limit == null) return probes;
  const counts = new Map<string, number>();
  const out: ProbeRecord[] = [];
  for (const p of probes) {
    const k = p.targetSkill ?? "<neg>";
    const c = counts.get(k) ?? 0;
    if (c >= limit) continue;
    counts.set(k, c + 1);
    out.push(p);
  }
  return out;
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  // eslint-disable-next-line no-console
  const log = (msg: string): void => console.error(`[skill-coverage] ${msg}`);

  if (args.regenCorpus) {
    const result = generateCorpus({ seed: args.seed, onlySkills: args.skills });
    const written = writeCorpusFiles(result);
    log(`regenerated corpus: ${written.length} files`);
  }

  if (!args.go) {
    log("dry run (no --go) — corpus available; skipping inject/observe loop");
    log("re-run with --go to execute against the live agent");
    return;
  }

  if (!args.agentName) throw new Error("agent name is required as first positional arg");
  if (!args.agentCwd) {
    throw new Error("--agent-cwd is required (path the agent's claude process runs in)");
  }

  const corpusDir = resolve(process.cwd(), "tests/skill-coverage/corpus");
  const probesAll = loadCorpus(corpusDir, args.skills ?? undefined);
  const probes = trimPerSkill(probesAll, args.limitPerSkill);
  log(`loaded ${probes.length} probes (from ${probesAll.length} in corpus)`);

  const run = await runAll(probes, {
    agentName: args.agentName,
    gatewaySocket: args.gatewaySocket ?? undefined,
    agentCwd: args.agentCwd,
    log,
  }, args.seed);

  const card = scoreRun(run);

  mkdirSync(dirname(args.outBase), { recursive: true });
  writeFileSync(`${args.outBase}.run.json`, JSON.stringify(run, null, 2));
  writeFileSync(`${args.outBase}.scorecard.json`, JSON.stringify(card, null, 2));
  writeFileSync(`${args.outBase}.scorecard.md`, renderMarkdown(card));
  log(`wrote ${args.outBase}.{run.json,scorecard.json,scorecard.md}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
