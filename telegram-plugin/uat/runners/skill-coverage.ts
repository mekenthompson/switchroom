#!/usr/bin/env bun
/**
 * Skill-coverage UAT runner — drives a real Telegram user account
 * against a switchroom agent's bot to validate that the right Claude
 * Code skill fires for fuzzy NL phrasings.
 *
 * Sister to `tests/skill-coverage/cli.ts` (the inject_inbound-based
 * runner that hit an agent-uid perms blocker). This one observes
 * everything through Telegram itself, so no host-side JSONL access
 * is required.
 *
 * **Skill detection.** The PreToolUse hook
 * `telegram-plugin/hooks/tool-label-pretool.mjs` writes one JSONL
 * row per tool invocation to
 * `~/.switchroom/agents/<agent>/telegram/tool-labels-<session_id>.jsonl`.
 * Skill rows have `tool_name === "Skill"` and a label of the form
 * `"Running skill <slug>"`. The runner tails every sidecar file
 * that mtime-changes during a probe window and pulls the slugs out.
 *
 * That sidecar dir is bind-mounted into the agent at
 * `$TELEGRAM_STATE_DIR` AND lives at a host-readable path (owned by
 * the agent UID but mode 0775; jsonl rows are 0644 from the hook).
 * No gateway / progress-card dependency.
 *
 * Usage:
 *   bun telegram-plugin/uat/runners/skill-coverage.ts \
 *     --agent test-harness:@your_test_bot \
 *     --skills switchroom-cli,switchroom-status \
 *     --limit-per-skill 2 \
 *     --out tests/skill-coverage/out/skill-coverage
 *
 * Env equivalents (UAT-standard, fail loud):
 *   TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_UAT_DRIVER_SESSION
 *   SKILL_COVERAGE_AGENT="test-harness:@your_test_bot"
 *   SKILL_COVERAGE_SKILLS="a,b,c"             (optional filter)
 *   SKILL_COVERAGE_LIMIT_PER_SKILL=N          (optional)
 *   SKILL_COVERAGE_OUT="..."                  (default tests/skill-coverage/out/skill-coverage)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { Driver, type ObservedMessage } from "../driver.js";
import { loadUatEnv } from "../load-env.js";

loadUatEnv();

// ─── Types — mirror tests/skill-coverage/{corpus,harness}/types.ts ────

export interface Probe {
  id: string;
  targetSkill: string | null;
  /** Adjacent-skill expectation for negative controls. */
  expectedOtherSkill?: string;
  kind: "paraphrase" | "typo" | "slang" | "indirect" | "negative";
  phrase: string;
}

export interface ProbeResult {
  probe: Probe;
  skillsFired: string[];
  replyText: string;
  durationMs: number;
  timedOut: boolean;
  errorMessage?: string;
}

// ─── Skill-label extraction ──────────────────────────────────────────

/**
 * Matches the literal label substring written by the PreToolUse hook
 * `telegram-plugin/hooks/tool-label-pretool.mjs` for a `Skill` tool
 * invocation. Slug regex is restrictive on purpose — skill names are
 * kebab-case ASCII per `skills/<name>/SKILL.md` frontmatter.
 */
const SKILL_LABEL_RE = /running skill\s+([a-z0-9][a-z0-9-]*)/i;

export function extractSkillFromLabel(label: string): string | null {
  const m = SKILL_LABEL_RE.exec(label);
  return m ? m[1]!.toLowerCase() : null;
}

export interface SidecarRow {
  ts: number;
  tool_use_id: string;
  agent_id: string | null;
  label: string;
  tool_name: string;
}

/**
 * Read every `tool-labels-*.jsonl` file in `dir` and return rows
 * with `tool_name === "Skill"` and `ts >= sinceMs`. The sidecar is
 * append-only so partial-line tails are unlikely; we still defensively
 * skip malformed lines.
 */
export function readSkillRowsSince(
  dir: string,
  sinceMs: number,
  readdir: (p: string) => string[],
  readFile: (p: string) => string,
): SidecarRow[] {
  const out: SidecarRow[] = [];
  let entries: string[] = [];
  try {
    entries = readdir(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.startsWith("tool-labels-") || !e.endsWith(".jsonl")) continue;
    let content: string;
    try {
      content = readFile(`${dir}/${e}`);
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let row: SidecarRow;
      try {
        row = JSON.parse(line) as SidecarRow;
      } catch {
        continue;
      }
      if (typeof row.ts !== "number" || row.ts < sinceMs) continue;
      if (row.tool_name !== "Skill") continue;
      out.push(row);
    }
  }
  return out;
}

// ─── CLI parsing ─────────────────────────────────────────────────────

interface CliConfig {
  agentName: string;
  botUsername: string;
  skillFilter: string[] | null;
  limitPerSkill: number | null;
  /** Per-probe reply timeout, ms. Default 90s. */
  replyTimeoutMs: number;
  /** Inter-probe settle, ms. Default 6s to keep us under Telegram's rate cap. */
  settleMs: number;
  /** Sidecar-drain window after reply is seen, ms. The hook writes
   *  asynchronously; a small post-reply hold avoids missing the last
   *  Skill row of a turn. Default 3s. */
  sidecarDrainMs: number;
  /** Path to the agent's TELEGRAM_STATE_DIR on the host — where
   *  `tool-labels-<session>.jsonl` files live. Defaults to
   *  `~/.switchroom/agents/<name>/telegram/`. */
  agentStateDir: string;
  outBase: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const DEFAULT_CORPUS_DIR = join(REPO_ROOT, "tests/skill-coverage/corpus");
const DEFAULT_OUT_BASE = join(REPO_ROOT, "tests/skill-coverage/out/skill-coverage");

function fail(msg: string): never {
  process.stderr.write(`[skill-coverage-uat] ${msg}\n`);
  process.exit(2);
}

function parseCli(argv: readonly string[]): CliConfig {
  let agentSpec = process.env.SKILL_COVERAGE_AGENT ?? "";
  let skillFilter = process.env.SKILL_COVERAGE_SKILLS
    ? process.env.SKILL_COVERAGE_SKILLS.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  let limitPerSkill = process.env.SKILL_COVERAGE_LIMIT_PER_SKILL
    ? Number.parseInt(process.env.SKILL_COVERAGE_LIMIT_PER_SKILL, 10)
    : null;
  let replyTimeoutMs = Number.parseInt(process.env.SKILL_COVERAGE_REPLY_TIMEOUT_MS ?? "90000", 10);
  let settleMs = Number.parseInt(process.env.SKILL_COVERAGE_SETTLE_MS ?? "6000", 10);
  let sidecarDrainMs = Number.parseInt(process.env.SKILL_COVERAGE_SIDECAR_DRAIN_MS ?? "3000", 10);
  let agentStateDir = process.env.SKILL_COVERAGE_AGENT_STATE_DIR ?? "";
  let outBase = process.env.SKILL_COVERAGE_OUT ?? DEFAULT_OUT_BASE;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (!v) fail(`${tok}: missing value`);
      return v;
    };
    switch (tok) {
      case "--agent":
        agentSpec = next();
        break;
      case "--skills":
        skillFilter = next().split(",").map((s) => s.trim()).filter(Boolean);
        break;
      case "--limit-per-skill":
        limitPerSkill = Number.parseInt(next(), 10);
        break;
      case "--reply-timeout-ms":
        replyTimeoutMs = Number.parseInt(next(), 10);
        break;
      case "--settle-ms":
        settleMs = Number.parseInt(next(), 10);
        break;
      case "--sidecar-drain-ms":
        sidecarDrainMs = Number.parseInt(next(), 10);
        break;
      case "--agent-state-dir":
        agentStateDir = next();
        break;
      case "--out":
        outBase = resolve(next());
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      default:
        if (tok.startsWith("--")) fail(`unknown flag: ${tok}`);
    }
  }

  if (!agentSpec) {
    fail(
      "no agent target. Pass --agent <name>:@<bot-username> or set SKILL_COVERAGE_AGENT.",
    );
  }
  const [agentName, botUsername] = agentSpec.split(":").map((s) => s.trim());
  if (!agentName || !botUsername || !botUsername.startsWith("@")) {
    fail(`--agent expects "<name>:@<bot-username>"; got "${agentSpec}"`);
  }

  const resolvedAgentStateDir = agentStateDir
    ? resolve(agentStateDir)
    : join(homedir(), ".switchroom", "agents", agentName!, "telegram");

  return {
    agentName: agentName!,
    botUsername: botUsername!,
    skillFilter,
    limitPerSkill,
    replyTimeoutMs,
    settleMs,
    sidecarDrainMs,
    agentStateDir: resolvedAgentStateDir,
    outBase,
  };
}

function printHelp(): void {
  process.stdout.write(`skill-coverage UAT runner

Required env (fail loud if missing):
  TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_UAT_DRIVER_SESSION

Flags:
  --agent NAME:@BOT         Agent + bot to target. Required.
  --skills A,B,C            Filter to these skills only.
  --limit-per-skill N       Cap probes per skill.
  --reply-timeout-ms N      Per-probe budget. Default 90000.
  --settle-ms N             Inter-probe settle. Default 6000.
  --sidecar-drain-ms N      Post-reply hold for the last hook write. Default 3000.
  --agent-state-dir PATH    Override sidecar location. Default ~/.switchroom/agents/<name>/telegram.
  --out PATH                Output base path. Default tests/skill-coverage/out/skill-coverage.
`);
}

// ─── Corpus loading ──────────────────────────────────────────────────

function loadCorpus(dir: string, skillFilter: string[] | null): Probe[] {
  if (!existsSync(dir)) {
    fail(`corpus dir not found: ${dir} — run \`bun tests/skill-coverage/corpus/generate-corpus.ts --seed=1\` first.`);
  }
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const out: Probe[] = [];
  for (const f of files) {
    const skill = f.replace(/\.jsonl$/, "");
    if (skillFilter && !skillFilter.includes(skill)) continue;
    const content = readFileSync(join(dir, f), "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Probe);
      } catch {
        // skip malformed lines
      }
    }
  }
  return out;
}

function trimPerSkill(probes: Probe[], limit: number | null): Probe[] {
  if (limit == null) return probes;
  const counts = new Map<string, number>();
  const out: Probe[] = [];
  for (const p of probes) {
    const k = p.targetSkill ?? "<neg>";
    const c = counts.get(k) ?? 0;
    if (c >= limit) continue;
    counts.set(k, c + 1);
    out.push(p);
  }
  return out;
}

// ─── Send + observe a single probe ───────────────────────────────────

async function pullOneWithTimeout(
  it: AsyncIterator<ObservedMessage>,
  ms: number,
): Promise<ObservedMessage | "timeout"> {
  return new Promise((resolveFn) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveFn("timeout");
    }, ms);
    it.next().then((r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (r.done === true) resolveFn("timeout");
      else resolveFn(r.value);
    }).catch(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveFn("timeout");
    });
  });
}

async function runProbe(
  driver: Driver,
  botUserId: number,
  driverUserId: number,
  probe: Probe,
  cfg: CliConfig,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const stream = driver.observeMessages(botUserId)[Symbol.asyncIterator]();
  const replyTexts = new Map<number, string>();
  let sentMessageId: number;

  try {
    const sent = await driver.sendText(botUserId, probe.phrase);
    sentMessageId = sent.messageId;
  } catch (err) {
    try {
      await stream.return?.(undefined);
    } catch {
      /* ignore */
    }
    return {
      probe,
      skillsFired: [],
      replyText: "",
      durationMs: Date.now() - startedAt,
      timedOut: false,
      errorMessage: `send failed: ${(err as Error).message}`,
    };
  }

  // Bot reply is the turn-completion signal — we stop reading the
  // stream once it lands. The sidecar-drain hold below absorbs any
  // late hook writes after the visible reply.
  const deadline = startedAt + cfg.replyTimeoutMs;
  let firstReplyAt = 0;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      const slice = await pullOneWithTimeout(stream, Math.min(remaining, 2000));
      if (slice === "timeout") {
        if (firstReplyAt) break;
        continue;
      }
      if (slice.senderUserId === driverUserId) continue;
      if (slice.messageId <= sentMessageId) continue;
      const t = (slice.text ?? "").trim();
      if (!t) continue;
      replyTexts.set(slice.messageId, t);
      if (!firstReplyAt) firstReplyAt = Date.now();
      // First non-empty reply is enough — extra edits don't change
      // which Skill labels landed in the sidecar.
      break;
    }
  } finally {
    try {
      await stream.return?.(undefined);
    } catch {
      /* ignore */
    }
  }

  if (!firstReplyAt) {
    return {
      probe,
      skillsFired: [],
      replyText: "",
      durationMs: Date.now() - startedAt,
      timedOut: true,
    };
  }

  // Drain window: hook writes are async to the assistant message
  // landing. A small post-reply hold catches the last row.
  await new Promise((res) => setTimeout(res, cfg.sidecarDrainMs));

  const rows = readSkillRowsSince(
    cfg.agentStateDir,
    startedAt,
    (p) => readdirSync(p),
    (p) => readFileSync(p, "utf-8"),
  );
  const skills = new Set<string>();
  for (const r of rows) {
    const slug = extractSkillFromLabel(r.label);
    if (slug) skills.add(slug);
  }

  const replyText = [...replyTexts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => t)
    .join("\n---\n");
  return {
    probe,
    skillsFired: [...skills],
    replyText,
    durationMs: Date.now() - startedAt,
    timedOut: false,
  };
}

// ─── Scoring ─────────────────────────────────────────────────────────

interface SkillRow {
  skill: string;
  sampleSize: number;
  truePositives: number;
  falseNegatives: number;
  falsePositives: number;
  precision: number;
  recall: number;
  f1: number;
  /** True when targetSkill fired at least once on positive probes. */
  execSuccess: number;
  negativeControlFpRate: number;
}

interface Scorecard {
  generatedAt: string;
  agentName: string;
  totalProbes: number;
  rows: SkillRow[];
  aggregate: {
    medianF1: number;
    skillsBelowF1Threshold: number;
    skillsBelowExecThreshold: number;
    f1Threshold: number;
    execThreshold: number;
  };
}

function score(results: ProbeResult[], agentName: string): Scorecard {
  const skills = new Set<string>();
  for (const r of results) {
    if (r.probe.targetSkill) skills.add(r.probe.targetSkill);
    for (const s of r.skillsFired) skills.add(s);
  }
  const rows: SkillRow[] = [];
  const F1_THRESHOLD = 0.9;
  const EXEC_THRESHOLD = 0.95;
  for (const s of [...skills].sort()) {
    let tp = 0, fn = 0, fp = 0;
    let sample = 0;
    let execTotal = 0, execHits = 0;
    let negTotal = 0, negFp = 0;
    for (const r of results) {
      const isTarget = r.probe.targetSkill === s;
      const fired = r.skillsFired.includes(s);
      if (isTarget) {
        sample++;
        if (fired) {
          tp++;
          execTotal++;
          execHits++;
        } else {
          fn++;
        }
      } else if (fired) {
        fp++;
      }
      if (r.probe.targetSkill === null) {
        negTotal++;
        if (fired) negFp++;
      }
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    rows.push({
      skill: s,
      sampleSize: sample,
      truePositives: tp,
      falseNegatives: fn,
      falsePositives: fp,
      precision: round3(precision),
      recall: round3(recall),
      f1: round3(f1),
      execSuccess: execTotal === 0 ? 0 : round3(execHits / execTotal),
      negativeControlFpRate: negTotal === 0 ? 0 : round3(negFp / negTotal),
    });
  }
  const f1s = rows.map((r) => r.f1).sort((a, b) => a - b);
  const medianF1 = f1s.length === 0 ? 0 : f1s[Math.floor(f1s.length / 2)]!;
  return {
    generatedAt: new Date().toISOString(),
    agentName,
    totalProbes: results.length,
    rows,
    aggregate: {
      medianF1: round3(medianF1),
      skillsBelowF1Threshold: rows.filter((r) => r.f1 < F1_THRESHOLD).length,
      skillsBelowExecThreshold: rows.filter((r) => r.execSuccess < EXEC_THRESHOLD).length,
      f1Threshold: F1_THRESHOLD,
      execThreshold: EXEC_THRESHOLD,
    },
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function renderMarkdown(card: Scorecard): string {
  const lines: string[] = [];
  lines.push(`# Skill-coverage scorecard`);
  lines.push("");
  lines.push(`- Generated: ${card.generatedAt}`);
  lines.push(`- Agent: \`${card.agentName}\``);
  lines.push(`- Probes: ${card.totalProbes}`);
  lines.push(`- Median F1: ${card.aggregate.medianF1}`);
  lines.push(`- Below F1 ≥ ${card.aggregate.f1Threshold}: ${card.aggregate.skillsBelowF1Threshold}`);
  lines.push(`- Below execSuccess ≥ ${card.aggregate.execThreshold}: ${card.aggregate.skillsBelowExecThreshold}`);
  lines.push("");
  lines.push(`| Skill | n | TP | FN | FP | Precision | Recall | F1 | Exec | NegFP |`);
  lines.push(`|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|`);
  for (const r of card.rows) {
    lines.push(
      `| \`${r.skill}\` | ${r.sampleSize} | ${r.truePositives} | ${r.falseNegatives} | ${r.falsePositives} | ${r.precision} | ${r.recall} | ${r.f1} | ${r.execSuccess} | ${r.negativeControlFpRate} |`,
    );
  }
  return lines.join("\n") + "\n";
}

// ─── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = parseCli(process.argv.slice(2));
  for (const v of ["TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_UAT_DRIVER_SESSION"]) {
    if (!process.env[v]) fail(`missing required env: ${v}`);
  }

  const corpusDir = DEFAULT_CORPUS_DIR;
  const probesAll = loadCorpus(corpusDir, cfg.skillFilter);
  const probes = trimPerSkill(probesAll, cfg.limitPerSkill);
  process.stderr.write(
    `[skill-coverage-uat] loaded ${probes.length} probes (from ${probesAll.length} in corpus)\n`,
  );

  const driver = new Driver({
    apiId: Number.parseInt(process.env.TELEGRAM_API_ID!, 10),
    apiHash: process.env.TELEGRAM_API_HASH!,
    session: process.env.TELEGRAM_UAT_DRIVER_SESSION!,
  });
  await driver.connect();
  process.stderr.write(`[skill-coverage-uat] connected as driver user\n`);

  try {
    const driverUserId = await driver.getMyUserId();
    const botUserId = await driver.resolveBotUserId(cfg.botUsername);
    process.stderr.write(
      `[skill-coverage-uat] target ${cfg.agentName} via ${cfg.botUsername} (uid=${botUserId})\n`,
    );

    const results: ProbeResult[] = [];
    let i = 0;
    for (const p of probes) {
      i++;
      const r = await runProbe(driver, botUserId, driverUserId, p, cfg);
      results.push(r);
      const status = r.timedOut ? "TIMEOUT" : r.skillsFired.length ? r.skillsFired.join(",") : "<no-skill>";
      process.stderr.write(
        `[skill-coverage-uat] (${i}/${probes.length}) ${p.kind} target=${p.targetSkill ?? "<neg>"} → ${status} (${r.durationMs}ms)\n`,
      );
      if (i < probes.length) {
        await new Promise((res) => setTimeout(res, cfg.settleMs));
      }
    }

    const card = score(results, cfg.agentName);
    mkdirSync(dirname(cfg.outBase), { recursive: true });
    writeFileSync(`${cfg.outBase}.run.json`, JSON.stringify({ cfg: { ...cfg }, results }, null, 2));
    writeFileSync(`${cfg.outBase}.scorecard.json`, JSON.stringify(card, null, 2));
    writeFileSync(`${cfg.outBase}.scorecard.md`, renderMarkdown(card));
    process.stderr.write(
      `[skill-coverage-uat] wrote ${cfg.outBase}.{run.json,scorecard.json,scorecard.md}\n`,
    );
  } finally {
    await driver.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[skill-coverage-uat] FATAL: ${(err as Error).stack ?? err}\n`);
    process.exit(1);
  });
}
