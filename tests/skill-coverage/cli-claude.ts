/**
 * `claude -p` driven skill-coverage runner — produces a scorecard
 * without any agent / Telegram / sidecar plumbing.
 *
 * Use this when the agent fleet isn't easily testable (perms, restart
 * required, etc) and you just need to know whether the SKILL.md
 * descriptions fire the right skill on natural-language phrasings.
 *
 * Workspace setup (one time):
 *   mkdir -p /tmp/skill-coverage-workspace/.claude/skills
 *   for s in $(pwd)/skills/*\/; do
 *     ln -sf "$s" "/tmp/skill-coverage-workspace/.claude/skills/$(basename "$s")"
 *   done
 *
 * Usage:
 *   bun tests/skill-coverage/cli-claude.ts --workspace=/tmp/skill-coverage-workspace
 *   bun tests/skill-coverage/cli-claude.ts --skills=switchroom-cli,docx --limit-per-skill=2
 */

import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { injectClaudeCli } from "./harness/inject-claude-cli.js";
import { scoreRun, renderMarkdown } from "./harness/score.js";
import type { ProbeRecord } from "./corpus/types.js";
import type { ProbeResult, RunRecord } from "./harness/types.js";

interface Cli {
  workspace: string;
  skillFilter: string[] | null;
  limitPerSkill: number | null;
  model: string;
  maxTurns: number;
  perProbeTimeoutMs: number;
  outBase: string;
  seed: number;
}

function fail(msg: string): never {
  process.stderr.write(`[skill-coverage-claude] ${msg}\n`);
  process.exit(2);
}

function parse(argv: readonly string[]): Cli {
  let workspace = process.env.SKILL_COVERAGE_WORKSPACE
    ?? "/tmp/skill-coverage-workspace";
  let skillFilter: string[] | null = null;
  let limitPerSkill: number | null = null;
  let model = process.env.SKILL_COVERAGE_MODEL ?? "claude-haiku-4-5-20251001";
  let maxTurns = 2;
  let perProbeTimeoutMs = 90_000;
  let outBase = resolve(process.cwd(), "tests/skill-coverage/out/skill-coverage-claude");
  let seed = 1;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (!v) fail(`${tok}: missing value`);
      return v;
    };
    const eqIdx = tok.indexOf("=");
    const k = eqIdx === -1 ? tok : tok.slice(0, eqIdx);
    const inlineV = eqIdx === -1 ? null : tok.slice(eqIdx + 1);
    const get = (): string => inlineV ?? next();
    switch (k) {
      case "--workspace": workspace = resolve(get()); break;
      case "--skills": skillFilter = get().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--limit-per-skill": limitPerSkill = Number.parseInt(get(), 10); break;
      case "--model": model = get(); break;
      case "--max-turns": maxTurns = Number.parseInt(get(), 10); break;
      case "--per-probe-timeout-ms": perProbeTimeoutMs = Number.parseInt(get(), 10); break;
      case "--out": outBase = resolve(get()); break;
      case "--seed": seed = Number.parseInt(get(), 10); break;
      case "--help":
      case "-h":
        process.stdout.write(`skill-coverage claude-cli runner
Flags: --workspace --skills A,B --limit-per-skill N --model X --max-turns N --per-probe-timeout-ms N --out PATH --seed N
`);
        process.exit(0);
        break;
      default:
        if (k.startsWith("--")) fail(`unknown flag: ${k}`);
    }
  }
  return { workspace, skillFilter, limitPerSkill, model, maxTurns, perProbeTimeoutMs, outBase, seed };
}

function loadCorpus(dir: string, filter: string[] | null): ProbeRecord[] {
  const out: ProbeRecord[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    const skill = f.replace(/\.jsonl$/, "");
    if (filter && !filter.includes(skill)) continue;
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
  const cli = parse(process.argv.slice(2));
  if (!existsSync(join(cli.workspace, ".claude", "skills"))) {
    fail(
      `workspace ${cli.workspace} has no .claude/skills/ dir — see header for setup.`,
    );
  }
  const corpusDir = resolve(process.cwd(), "tests/skill-coverage/corpus");
  if (!existsSync(corpusDir)) fail(`corpus dir not found: ${corpusDir}`);
  const probesAll = loadCorpus(corpusDir, cli.skillFilter);
  const probes = trimPerSkill(probesAll, cli.limitPerSkill);
  process.stderr.write(
    `[skill-coverage-claude] ${probes.length} probes (from ${probesAll.length} in corpus); model=${cli.model}\n`,
  );

  const startedAt = new Date().toISOString();
  const results: ProbeResult[] = [];
  let i = 0;
  for (const probe of probes) {
    i++;
    const outcome = await injectClaudeCli({
      cwd: cli.workspace,
      prompt: probe.phrase,
      model: cli.model,
      maxTurns: cli.maxTurns,
      timeoutMs: cli.perProbeTimeoutMs,
    });
    const r: ProbeResult = {
      probe,
      skillsInvoked: outcome.skillsInvoked,
      turnDurationMs: outcome.durationMs,
      timedOut: !outcome.ok && outcome.skillsInvoked.length === 0,
      agentName: "claude-cli",
      error: outcome.ok ? undefined : (outcome.rawErrLines ?? []).join(" | "),
    };
    results.push(r);
    const status = r.skillsInvoked.length
      ? r.skillsInvoked.join(",")
      : r.timedOut
        ? "TIMEOUT"
        : "<no-skill>";
    process.stderr.write(
      `[skill-coverage-claude] (${i}/${probes.length}) ${probe.kind} target=${probe.targetSkill ?? "<neg>"} → ${status} (${r.turnDurationMs}ms)\n`,
    );
  }

  const run: RunRecord = {
    startedAt,
    finishedAt: new Date().toISOString(),
    seed: cli.seed,
    agentName: "claude-cli",
    results,
  };
  const card = scoreRun(run);
  mkdirSync(dirname(cli.outBase), { recursive: true });
  writeFileSync(`${cli.outBase}.run.json`, JSON.stringify(run, null, 2));
  writeFileSync(`${cli.outBase}.scorecard.json`, JSON.stringify(card, null, 2));
  writeFileSync(`${cli.outBase}.scorecard.md`, renderMarkdown(card));
  process.stderr.write(
    `[skill-coverage-claude] wrote ${cli.outBase}.{run.json,scorecard.json,scorecard.md}\n`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[skill-coverage-claude] FATAL: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
