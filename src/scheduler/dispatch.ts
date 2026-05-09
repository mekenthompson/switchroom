/**
 * Scheduler dispatch logic — pure-function core, mockable for tests.
 *
 * Phase 1a slice. Reads the cascade-resolved config, walks every agent's
 * `schedule[]`, registers each entry with node-cron against the same
 * cron expressions cronToOnCalendar parses today, and on fire dispatches
 * via `docker exec switchroom-<name> claude -p "<prompt>"`.
 *
 * The container name MUST match `container_name:` set by compose.ts —
 * `switchroom-<agent>` — not the compose service name `agent-<agent>`.
 * `docker exec` resolves against container names, not service names.
 *
 * Identity boundary: the scheduler container is privileged (it mounts
 * /var/run/docker.sock to invoke `docker exec`) but does NOT see secret
 * values. The agent resolves its own vault refs through the broker
 * socket inside its container. The scheduler only fires the dispatch
 * and audits the (when, agent, schedule_index, prompt_key, exit_code,
 * output_summary) row to scheduler.db.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { ScheduleEntry, SwitchroomConfig } from "../config/schema.js";

export interface SchedulerEntry {
  agent: string;
  scheduleIndex: number;
  cron: string;
  prompt: string;
  /** SHA-256 prefix of prompt — stable, non-reversible audit key. */
  promptKey: string;
}

/**
 * Walk the resolved config and produce a flat list of (agent, index)
 * schedule entries that the cron loop registers. Pure function: no IO.
 *
 * Deterministic order: agents sorted by name, then schedule entries by
 * declared index. Important for snapshot tests of the audit log shape.
 */
export function collectScheduleEntries(
  config: SwitchroomConfig,
): SchedulerEntry[] {
  const out: SchedulerEntry[] = [];
  const agentNames = Object.keys(config.agents).sort();
  for (const agent of agentNames) {
    const schedule: ScheduleEntry[] = config.agents[agent]?.schedule ?? [];
    for (let i = 0; i < schedule.length; i++) {
      const entry = schedule[i]!;
      out.push({
        agent,
        scheduleIndex: i,
        cron: entry.cron,
        prompt: entry.prompt,
        promptKey: createHash("sha256").update(entry.prompt).digest("hex").slice(0, 12),
      });
    }
  }
  return out;
}

export interface DispatchResult {
  agent: string;
  scheduleIndex: number;
  promptKey: string;
  exitCode: number;
  /** Trimmed stdout/stderr — first 200 chars only, for the audit row. */
  outputSummary: string;
  startedAt: number;
  finishedAt: number;
}

export type ExecRunner = (
  args: string[],
  stdin: string,
) => Promise<{ exitCode: number; output: string }>;

/**
 * Default exec runner — shells `docker exec -i switchroom-<name> claude -p`,
 * piping the prompt on stdin (avoids embedding the prompt in argv where
 * it'd show up in `ps` and shell history). Tests inject a mock.
 */
export const defaultExecRunner: ExecRunner = (args, stdin) =>
  new Promise((resolveP) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    child.stdout.on("data", (c) => { buf += c.toString("utf8"); });
    child.stderr.on("data", (c) => { buf += c.toString("utf8"); });
    child.on("close", (code) => {
      resolveP({ exitCode: code ?? -1, output: buf });
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });

/**
 * Dispatch a single schedule entry. Pure-ish: takes an injectable runner
 * so tests can drive the full path without a live docker daemon.
 */
export async function dispatchEntry(
  entry: SchedulerEntry,
  runner: ExecRunner = defaultExecRunner,
): Promise<DispatchResult> {
  const startedAt = Date.now();
  // Must match compose.ts `container_name: switchroom-<agent>`. The
  // compose service name (`agent-<name>`) is not what `docker exec`
  // resolves against — it resolves against container names.
  const containerName = `switchroom-${entry.agent}`;
  // -i: keep stdin open so we can pipe the prompt in.
  // claude -p: print mode, single prompt, exits when done.
  const args = ["exec", "-i", containerName, "claude", "-p"];
  const { exitCode, output } = await runner(args, entry.prompt);
  const finishedAt = Date.now();
  return {
    agent: entry.agent,
    scheduleIndex: entry.scheduleIndex,
    promptKey: entry.promptKey,
    exitCode,
    outputSummary: output.trim().slice(0, 200),
    startedAt,
    finishedAt,
  };
}

// ───────────────────────────────────────────────────────────────────────
//  Phase 1: in-band cron synthesis primitive (no behaviour change yet)
// ───────────────────────────────────────────────────────────────────────
//
// The end-state for cron scheduling (see issue tracking the scheduler
// fold-in work) is to retire the `switchroom-cron` singleton container
// and run cron as a sibling of the gateway inside each agent container.
// Fires are delivered to the agent as synthesized `InboundMessage`s
// flowing the same path as Telegram messages and button-callback
// injections (gateway.ts:5217, :8796, :9226), discriminated by
// `meta.source = "cron"`. Reusing the existing envelope means the
// agent transcript and Hindsight see cron fires as ordinary turns
// tagged with `<channel source="cron">`, rather than as out-of-band
// one-shot `claude -p` runs that vanish from session history.
//
// `dispatchAsInbound` is the synthesis primitive. Phase 1 only adds it
// — nothing calls it yet. Phase 2 wires the in-agent scheduler.

/**
 * InboundMessage envelope, mirrored structurally from
 * `telegram-plugin/gateway/ipc-protocol.ts` so this module can build
 * one without crossing the src/ ↔ telegram-plugin/ tsconfig boundary.
 *
 * Keep this in sync with the source of truth — the bridge's
 * `validateGatewayMessage` validator (`telegram-plugin/bridge/ipc-client.ts`)
 * is what decides whether a wire-format message is accepted.
 */
export interface InboundMessageWire {
  type: "inbound";
  chatId: string;
  threadId?: number;
  messageId: number;
  user: string;
  userId: number;
  ts: number;
  text: string;
  imagePath?: string;
  attachment?: { fileId: string; mimeType: string; fileName?: string };
  meta: Record<string, string>;
}

/**
 * Minimum surface a dispatcher needs to deliver a synthesized inbound
 * to a connected agent client. Matches the shape of the gateway's
 * `IpcServer.sendToAgent` so a real gateway can be passed in directly,
 * and tests can pass a capturing fake.
 *
 * Returns true when an agent client was registered for `agentName` and
 * the message was written to its socket; false when the agent is not
 * currently connected (the caller decides whether to drop, queue, or
 * persist for replay-on-reconnect).
 */
export interface InboundDispatcher {
  sendToAgent(agentName: string, msg: InboundMessageWire): boolean;
}

export interface InboundDispatchOptions {
  /**
   * Required: the chat the synthesized turn belongs to. The Phase 2
   * in-agent scheduler resolves this from the agent's primary topic
   * mapping; tests pass it directly.
   */
  chatId: string;
  /** Optional Telegram topic / thread id when the chat has topics. */
  threadId?: number;
  /**
   * Synthetic timestamp source. Defaulted to `Date.now()`; tests inject
   * a fixed clock to make `messageId` and `ts` deterministic.
   */
  now?: () => number;
}

export interface InboundDispatchResult {
  /** False when no agent client was registered for `entry.agent`. */
  delivered: boolean;
  /** The exact wire message handed to the dispatcher. */
  message: InboundMessageWire;
}

/**
 * Build an `InboundMessage` from a `SchedulerEntry` and hand it to the
 * dispatcher. Pure synthesis — no clock, network, or filesystem unless
 * the dispatcher does it. Phase 1 ships this primitive; Phase 2 wires
 * it from the in-agent scheduler sibling.
 *
 * `meta.source = "cron"` is the only stable discriminator the bridge
 * uses to render the turn as `<channel source="cron">`. `schedule_index`
 * and `prompt_key` are carried for audit correlation against the
 * scheduler.jsonl ledger Phase 2 introduces — both as strings, since
 * `meta` is `Record<string, string>` on the wire.
 */
export function dispatchAsInbound(
  entry: SchedulerEntry,
  options: InboundDispatchOptions,
  dispatcher: InboundDispatcher,
): InboundDispatchResult {
  const ts = (options.now ?? Date.now)();
  const message: InboundMessageWire = {
    type: "inbound",
    chatId: options.chatId,
    ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
    // Synthetic id — cron fires don't have a Telegram message_id. The
    // bridge only uses messageId for telegram_reply context, which is
    // a no-op for cron-synthesized turns.
    messageId: ts,
    user: "cron",
    userId: 0,
    ts,
    text: entry.prompt,
    meta: {
      source: "cron",
      schedule_index: String(entry.scheduleIndex),
      prompt_key: entry.promptKey,
    },
  };
  const delivered = dispatcher.sendToAgent(entry.agent, message);
  return { delivered, message };
}
