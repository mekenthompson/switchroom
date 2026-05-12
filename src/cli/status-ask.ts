/**
 * `switchroom status-ask report` — measure the primary lagging KPI
 * from `docs/status-ask-cause-classes.md`.
 *
 * Reads `runtime-metrics.jsonl` files emitted by the gateway's
 * `runtime-metrics.ts` (see #1124) and produces a digest:
 *
 *   - Total `inbound_status_query` fires in the window
 *   - Rate per 1000 turns (target: < 5)
 *   - Per-day and per-agent breakdowns
 *   - Adjacent KPIs (outbound-silence p95, silence-poke success, fallback rate)
 *   - Top N recent fires with their silence trail — the events in
 *     the same chat that preceded the user typing "status?"
 *
 * Single-purpose. Read-only. No PostHog query — this works against
 * the local JSONL trail that #1124 ships alongside the PostHog
 * uploads, so an operator can run it without API keys.
 */

import type { Command } from "commander";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  parseJsonl,
  computeReport,
  renderMarkdown,
  parseDuration,
  type RawEvent,
} from "../status-ask/report.js";
import { loadConfig, resolveAgentsDir } from "../config/loader.js";

interface ReportOptions {
  path?: string;
  since: string;
  agent?: string;
  format: "markdown" | "json";
  fires: string;
}

export function registerStatusAskCommand(program: Command): void {
  const statusAsk = program
    .command("status-ask")
    .description(
      "Measurement tooling for the inbound_status_query KPI (status-ask rate → zero goal)",
    );

  statusAsk
    .command("report")
    .description(
      "Print a digest of inbound_status_query events from local runtime-metrics.jsonl files",
    )
    .option(
      "--path <file>",
      "Path to a single runtime-metrics.jsonl file (overrides auto-discovery)",
    )
    .option(
      "--since <duration>",
      "Window — e.g. '24h', '7d', '30d', or 'all'",
      "7d",
    )
    .option("--agent <name>", "Filter to a single agent")
    .option(
      "--format <fmt>",
      "Output format — 'markdown' (default) or 'json'",
      "markdown",
    )
    .option(
      "--fires <n>",
      "Number of recent fires to render with silence trails (0 to hide)",
      "10",
    )
    .action((opts: ReportOptions) => {
      runReport(opts);
    });
}

function runReport(opts: ReportOptions): void {
  if (opts.format !== "markdown" && opts.format !== "json") {
    process.stderr.write(
      `status-ask report: --format must be 'markdown' or 'json'\n`,
    );
    process.exit(2);
  }
  const firesLimit = Number.parseInt(opts.fires, 10);
  if (!Number.isFinite(firesLimit) || firesLimit < 0) {
    process.stderr.write(
      `status-ask report: --fires must be a non-negative integer\n`,
    );
    process.exit(2);
  }

  let windowMs: number | null;
  try {
    windowMs = parseDuration(opts.since);
  } catch (err) {
    process.stderr.write(
      `status-ask report: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
  const endMs = Date.now();
  // For "all", start at the Unix epoch — gives Date.toISOString() something
  // sane to render rather than blowing up on Number.MIN_SAFE_INTEGER.
  const startMs = windowMs == null ? 0 : endMs - windowMs;

  const sources = resolveSources(opts.path);
  if (sources.length === 0) {
    process.stderr.write(
      `status-ask report: no runtime-metrics.jsonl files found. ` +
        `Pass --path explicitly, or check that the gateway has emitted ` +
        `events (SWITCHROOM_RUNTIME_METRICS_JSONL_DISABLED unset) and that ` +
        `~/.switchroom/agents/<name>/runtime-metrics.jsonl exists.\n`,
    );
    process.exit(1);
  }

  const allEvents: RawEvent[] = [];
  const parseErrors: { source: string; line: number; reason: string }[] = [];
  for (const src of sources) {
    let content: string;
    try {
      content = readFileSync(src.path, "utf-8");
    } catch (err) {
      process.stderr.write(
        `status-ask report: cannot read ${src.path}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      continue;
    }
    const { events, errors } = parseJsonl(content);
    // Stamp the source's agent name onto any event that doesn't carry
    // one — events emitted by the gateway already include agent via
    // analytics-posthog's auto-stamp, but the JSONL writer at
    // runtime-metrics.ts does NOT (it just persists the event shape).
    // Without this, the report's by-agent breakdown is empty for
    // local trails.
    for (const e of events) {
      if (src.agent != null && (e.agent === undefined || e.agent === null)) {
        e.agent = src.agent;
      }
      allEvents.push(e);
    }
    for (const e of errors) {
      parseErrors.push({ source: src.path, line: e.line, reason: e.reason });
    }
  }

  if (parseErrors.length > 0) {
    const cap = 10;
    process.stderr.write(
      `status-ask report: ${parseErrors.length} malformed JSONL line(s) skipped:\n`,
    );
    for (const err of parseErrors.slice(0, cap)) {
      process.stderr.write(`  ${err.source}:${err.line} — ${err.reason}\n`);
    }
    if (parseErrors.length > cap) {
      process.stderr.write(`  ... and ${parseErrors.length - cap} more\n`);
    }
  }

  const report = computeReport({
    events: allEvents,
    window: { startMs, endMs },
    agent: opts.agent,
    firesLimit,
  });

  if (opts.format === "json") {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(renderMarkdown(report) + "\n");
  }
}

interface Source {
  path: string;
  /** Inferred from the parent dir name when auto-discovering. */
  agent: string | null;
}

/**
 * Resolve the JSONL files to read.
 *
 *   - If `--path` is set, read just that file. Agent stamp comes from
 *     the parent dir name if the path looks like
 *     `.../agents/<name>/runtime-metrics.jsonl`, else null.
 *   - Otherwise, load switchroom.yaml, enumerate every agent, and
 *     read `<agents_dir>/<name>/runtime-metrics.jsonl` if it exists.
 *
 * Returns an empty array if nothing's available — the CLI surfaces a
 * helpful error.
 */
function resolveSources(explicitPath: string | undefined): Source[] {
  if (explicitPath != null && explicitPath.trim() !== "") {
    const trimmed = explicitPath.trim();
    if (!existsSync(trimmed)) {
      process.stderr.write(`status-ask report: ${trimmed}: file not found\n`);
      process.exit(1);
    }
    return [
      { path: trimmed, agent: inferAgentFromPath(trimmed) },
    ];
  }

  // Auto-discover via switchroom.yaml.
  let agentsDir: string;
  try {
    const config = loadConfig();
    agentsDir = resolveAgentsDir(config);
  } catch {
    // No config — fall back to the standard home-relative path.
    agentsDir = join(homedir(), ".switchroom", "agents");
  }
  if (!existsSync(agentsDir)) return [];

  const sources: Source[] = [];
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }
  for (const name of entries) {
    const path = join(agentsDir, name, "runtime-metrics.jsonl");
    if (existsSync(path)) {
      sources.push({ path, agent: name });
    }
  }
  return sources;
}

function inferAgentFromPath(p: string): string | null {
  // .../<agentsDir>/<name>/runtime-metrics.jsonl
  const parts = p.split("/");
  const fname = parts[parts.length - 1];
  if (fname !== "runtime-metrics.jsonl") return null;
  const parent = parts[parts.length - 2];
  if (parent == null || parent === "") return null;
  // Skip generic dir names that won't be agent names.
  if (parent === "agent" || parent === "agents") return null;
  return parent;
}
