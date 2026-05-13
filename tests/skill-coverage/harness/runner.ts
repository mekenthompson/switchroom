/**
 * Probe-runner main loop.
 *
 *   for each probe:
 *     attach session-tail
 *     inject_inbound the phrase
 *     wait for turn_end (or timeout)
 *     extract skills invoked
 *     record result
 *
 * The loop is sequential by design — running probes in parallel
 * against the same agent would tangle session-tail (the agent only
 * has one active session JSONL at a time). Multi-agent fan-out is
 * possible later: one runner per agent, each binding its own
 * gateway socket.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProbeRecord } from "../corpus/types.js";
import { injectInbound, type InjectOptions } from "./inject.js";
import {
  createTurnObserver,
  extractSkillsInvoked,
  type ObserveTurnOptions,
} from "./observe.js";
import type { ProbeResult, RunRecord } from "./types.js";

export interface RunnerOptions {
  agentName: string;
  /** Gateway socket path; default `${TELEGRAM_STATE_DIR}/gateway.sock` if set. */
  gatewaySocket?: string;
  /** Agent cwd — fed to session-tail. */
  agentCwd: string;
  /** Override CLAUDE_CONFIG_DIR. */
  claudeHome?: string;
  /** Per-probe timeout. Default 120s. */
  turnTimeoutMs?: number;
  /** Keep raw events in the ProbeResult for debug. Default false. */
  debugRawEvents?: boolean;
  /** Optional logger. */
  log?: (msg: string) => void;
  /** Test seam — replace inject. */
  _inject?: typeof injectInbound;
  /** Test seam — replace observer factory. */
  _createObserver?: typeof createTurnObserver;
}

/** Load a probe JSONL file. */
export function loadProbesJsonl(path: string): ProbeRecord[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ProbeRecord);
}

/** Load every `<skill>.jsonl` file under `corpusDir`. */
export function loadCorpus(corpusDir: string, onlySkills?: string[]): ProbeRecord[] {
  if (!existsSync(corpusDir)) return [];
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const entries = readdirSync(corpusDir);
  const probes: ProbeRecord[] = [];
  for (const e of entries) {
    if (!e.endsWith(".jsonl")) continue;
    const skill = e.slice(0, -".jsonl".length);
    if (onlySkills && onlySkills.length > 0 && !onlySkills.includes(skill)) continue;
    probes.push(...loadProbesJsonl(join(corpusDir, e)));
  }
  return probes;
}

export async function runProbe(
  probe: ProbeRecord,
  opts: RunnerOptions,
): Promise<ProbeResult> {
  const gatewaySocket =
    opts.gatewaySocket ??
    (process.env.SWITCHROOM_GATEWAY_SOCKET ||
      (process.env.TELEGRAM_STATE_DIR
        ? join(process.env.TELEGRAM_STATE_DIR, "gateway.sock")
        : ""));
  if (!gatewaySocket) {
    throw new Error(
      "runner: gateway socket not configured — set --gateway-socket or SWITCHROOM_GATEWAY_SOCKET",
    );
  }

  const observerFactory = opts._createObserver ?? createTurnObserver;
  const injectFn = opts._inject ?? injectInbound;

  const observer = observerFactory({
    cwd: opts.agentCwd,
    claudeHome: opts.claudeHome,
    timeoutMs: opts.turnTimeoutMs ?? 120_000,
    log: opts.log,
  } satisfies ObserveTurnOptions);

  try {
    await observer.start();
    const injectOpts: InjectOptions = {
      socketPath: gatewaySocket,
      agentName: opts.agentName,
      text: probe.phrase,
    };
    const injectOutcome = await injectFn(injectOpts);
    if (!injectOutcome.written) {
      observer.stop();
      return {
        probe,
        skillsInvoked: [],
        turnDurationMs: 0,
        timedOut: true,
        injectedAt: injectOutcome.injectedAt,
        agentName: opts.agentName,
      };
    }
    const turn = await observer.waitForTurnEnd();
    observer.stop();
    return {
      probe,
      skillsInvoked: extractSkillsInvoked(turn.events),
      turnDurationMs: turn.durationMs,
      timedOut: turn.timedOut,
      rawEvents: opts.debugRawEvents ? turn.events : undefined,
      injectedAt: injectOutcome.injectedAt,
      agentName: opts.agentName,
    };
  } catch (err) {
    observer.stop();
    return {
      probe,
      skillsInvoked: [],
      turnDurationMs: 0,
      timedOut: true,
      error: err instanceof Error ? err.message : String(err),
      agentName: opts.agentName,
    };
  }
}

export async function runAll(
  probes: ProbeRecord[],
  opts: RunnerOptions,
  seed: number,
): Promise<RunRecord> {
  const startedAt = new Date().toISOString();
  const results: ProbeResult[] = [];
  for (const p of probes) {
    opts.log?.(`runner: probe ${p.id} (${p.kind}, target=${p.targetSkill ?? "<neg>"})`);
    const r = await runProbe(p, opts);
    results.push(r);
  }
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    seed,
    agentName: opts.agentName,
    results,
  };
}
