/**
 * `switchroom telegram` — operator CLI for phone-first features (#597).
 *
 * Single verb that wraps "vault put + switchroom.yaml edit + reconcile
 * hint" so enabling voice-in / telegraph / webhook is one command, not
 * three files. Builds on the cascade-canonical schema landed in #596.
 *
 * Initial scope: `status` + telegraph enable/disable. Voice-in (vault +
 * api-key) and webhook (vault + secret) land in a follow-up.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync } from "node:fs";
import { getConfig, getConfigPath, withConfigError } from "./helpers.js";
import { resolveAgentConfig } from "../config/merge.js";
import { setTelegramFeature, removeTelegramFeature } from "./telegram-yaml.js";

export function registerTelegramCommand(program: Command): void {
  const tg = program
    .command("telegram")
    .description(
      "Configure phone-first Telegram features (telegraph long-replies, voice-in, webhook ingest) for an agent.",
    );

  registerStatusVerb(tg, program);
  registerEnableVerb(tg, program);
  registerDisableVerb(tg, program);
}

// ─── status ──────────────────────────────────────────────────────────────────

function registerStatusVerb(tg: Command, program: Command): void {
  tg.command("status")
    .description(
      "Show which Telegram features are enabled per agent, derived from the resolved cascade.",
    )
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const rows: StatusRow[] = [];
        for (const [name, raw] of Object.entries(config.agents)) {
          const resolved = resolveAgentConfig(
            config.defaults,
            config.profiles,
            raw,
          );
          const t = resolved.channels?.telegram;
          rows.push({
            agent: name,
            voiceIn: formatVoiceIn(t?.voice_in),
            telegraph: formatTelegraph(t?.telegraph),
            webhooks: formatWebhooks(t?.webhook_sources),
          });
        }
        printStatusTable(rows);
      }),
    );
}

interface StatusRow {
  agent: string;
  voiceIn: string;
  telegraph: string;
  webhooks: string;
}

function formatVoiceIn(v: { enabled?: boolean; provider?: string; language?: string } | undefined): string {
  if (!v?.enabled) return "—";
  const provider = v.provider ?? "openai";
  return v.language ? `✓ ${provider} (${v.language})` : `✓ ${provider}`;
}

function formatTelegraph(t: { enabled?: boolean; threshold?: number } | undefined): string {
  if (!t?.enabled) return "—";
  return `✓ ${t.threshold ?? 3000}`;
}

function formatWebhooks(sources: string[] | undefined): string {
  if (!sources || sources.length === 0) return "—";
  return `✓ ${sources.join(", ")}`;
}

function printStatusTable(rows: StatusRow[]): void {
  if (rows.length === 0) {
    console.log(chalk.yellow("No agents declared in switchroom.yaml."));
    return;
  }
  const headers = { agent: "Agent", voiceIn: "Voice-in", telegraph: "Telegraph", webhooks: "Webhook sources" };
  const widths = {
    agent: Math.max(headers.agent.length, ...rows.map((r) => r.agent.length)),
    voiceIn: Math.max(headers.voiceIn.length, ...rows.map((r) => stripAnsi(r.voiceIn).length)),
    telegraph: Math.max(headers.telegraph.length, ...rows.map((r) => stripAnsi(r.telegraph).length)),
    webhooks: Math.max(headers.webhooks.length, ...rows.map((r) => stripAnsi(r.webhooks).length)),
  };
  const fmt = (r: StatusRow) =>
    `${r.agent.padEnd(widths.agent)}  ${r.voiceIn.padEnd(widths.voiceIn)}  ${r.telegraph.padEnd(widths.telegraph)}  ${r.webhooks.padEnd(widths.webhooks)}`;
  console.log(chalk.bold(fmt({ agent: headers.agent, voiceIn: headers.voiceIn, telegraph: headers.telegraph, webhooks: headers.webhooks })));
  for (const r of rows) console.log(fmt(r));
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── enable ──────────────────────────────────────────────────────────────────

function registerEnableVerb(tg: Command, program: Command): void {
  const enable = tg
    .command("enable")
    .description("Turn on a Telegram feature for an agent.");

  enable
    .command("telegraph")
    .description(
      "Enable Telegraph long-reply publishing. Replies above --threshold chars publish to telegra.ph and the agent sends a single message linking to the Instant View.",
    )
    .requiredOption("--agent <name>", "Agent name (must exist in switchroom.yaml)")
    .option("--threshold <chars>", "Character count above which replies go to Telegraph", "3000")
    .option("--short-name <name>", "Telegraph account short_name (defaults to agent name)")
    .option("--author-name <name>", "Telegraph 'author' shown on the article header")
    .option("--dry-run", "Print the YAML diff without writing")
    .action(
      withConfigError(async (opts: TelegraphEnableOpts) => {
        const threshold = Number(opts.threshold);
        if (!Number.isFinite(threshold) || threshold <= 0) {
          fail(`--threshold must be a positive integer (got ${opts.threshold})`);
        }
        const value: Record<string, unknown> = { enabled: true, threshold };
        if (opts.shortName) value.short_name = opts.shortName;
        if (opts.authorName) value.author_name = opts.authorName;
        await applyYamlEdit(program, opts.agent, "telegraph", value, opts.dryRun ?? false);
      }),
    );
}

interface TelegraphEnableOpts {
  agent: string;
  threshold: string;
  shortName?: string;
  authorName?: string;
  dryRun?: boolean;
}

// ─── disable ─────────────────────────────────────────────────────────────────

function registerDisableVerb(tg: Command, program: Command): void {
  const disable = tg
    .command("disable")
    .description("Turn off a Telegram feature for an agent.");

  disable
    .command("telegraph")
    .description("Disable Telegraph long-reply publishing for the agent.")
    .requiredOption("--agent <name>", "Agent name")
    .option("--dry-run", "Print the YAML diff without writing")
    .action(
      withConfigError(async (opts: { agent: string; dryRun?: boolean }) => {
        await applyYamlRemove(program, opts.agent, "telegraph", opts.dryRun ?? false);
      }),
    );
}

// ─── shared helpers ──────────────────────────────────────────────────────────

async function applyYamlEdit(
  program: Command,
  agent: string,
  feature: "telegraph" | "voice_in" | "webhook_sources",
  value: unknown,
  dryRun: boolean,
): Promise<void> {
  const path = getConfigPath(program);
  const before = readFileSync(path, "utf-8");
  let after: string;
  try {
    after = setTelegramFeature(before, agent, feature, value);
  } catch (err) {
    fail((err as Error).message);
  }
  emitDiffOrWrite(path, before, after, dryRun);
  if (!dryRun) {
    console.log(chalk.green(`✓ Enabled ${feature.replace("_", "-")} for agent '${agent}'`));
    console.log(
      chalk.gray(`  Run 'switchroom agent restart ${agent}' to pick up the change.`),
    );
  }
}

async function applyYamlRemove(
  program: Command,
  agent: string,
  feature: "telegraph" | "voice_in" | "webhook_sources",
  dryRun: boolean,
): Promise<void> {
  const path = getConfigPath(program);
  const before = readFileSync(path, "utf-8");
  const after = removeTelegramFeature(before, agent, feature);
  if (before === after) {
    console.log(
      chalk.yellow(
        `No change — ${feature.replace("_", "-")} is not set for agent '${agent}'.`,
      ),
    );
    return;
  }
  emitDiffOrWrite(path, before, after, dryRun);
  if (!dryRun) {
    console.log(chalk.green(`✓ Disabled ${feature.replace("_", "-")} for agent '${agent}'`));
    console.log(
      chalk.gray(`  Run 'switchroom agent restart ${agent}' to pick up the change.`),
    );
  }
}

function emitDiffOrWrite(path: string, before: string, after: string, dryRun: boolean): void {
  if (dryRun) {
    console.log(chalk.bold(`[dry-run] would edit ${path}`));
    console.log(makeUnifiedDiff(before, after));
    return;
  }
  writeFileSync(path, after, "utf-8");
}

function makeUnifiedDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++; j++;
    } else if (j < b.length && (i >= a.length || a[i] !== b[j])) {
      out.push(chalk.green(`+ ${b[j]}`));
      j++;
    } else {
      out.push(chalk.red(`- ${a[i]}`));
      i++;
    }
  }
  return out.join("\n");
}

function fail(msg: string): never {
  console.error(chalk.red(`Error: ${msg}`));
  process.exit(1);
}
