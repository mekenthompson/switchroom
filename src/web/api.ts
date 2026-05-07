import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { AgentConfig, SwitchroomConfig } from "../config/schema.js";
import {
  getAllAgentStatuses,
  startAgent,
  stopAgent,
  restartAgent,
} from "../agents/lifecycle.js";
import { getAllAuthStatuses } from "../auth/manager.js";
import { getCollectionForAgent } from "../memory/hindsight.js";
import { captureEvent, captureException } from "../analytics/posthog.js";
import { resolveAgentsDir } from "../config/loader.js";
import { resolveAgentConfig } from "../config/merge.js";
import { getAccountInfos, type AccountInfo } from "../auth/account-store.js";
import {
  readAccountQuota,
  type AccountQuotaSnapshot,
} from "../auth/account-quota-store.js";
import {
  promoteAccountToPrimary,
  type PromoteOutcome,
} from "../auth/account-promote.js";
import { openTurnsDb, listTurnsForAgent, type Turn } from "../../telegram-plugin/registry/turns-schema.js";
import { applySubagentsSchema, listSubagents, type Subagent } from "../../telegram-plugin/registry/subagents-schema.js";

export interface AgentInfo {
  name: string;
  active: string;
  uptime: string | null;
  memory: string | null;
  extends: string;
  topic_name: string;
  topic_emoji?: string;
  auth: {
    authenticated: boolean;
    subscriptionType?: string;
    timeUntilExpiry?: string;
    expiresAt?: number;
  };
  memoryCollection: string;
}

export function handleGetAgents(config: SwitchroomConfig): AgentInfo[] {
  const statuses = getAllAgentStatuses(config);
  const authStatuses = getAllAuthStatuses(config);
  const agents: AgentInfo[] = [];

  for (const [name, agentConfig] of Object.entries(config.agents)) {
    const status = statuses[name];
    const auth = authStatuses[name];
    const collection = getCollectionForAgent(name, config);

    agents.push({
      name,
      active: status?.active ?? "unknown",
      uptime: status?.uptime ?? null,
      memory: status?.memory ?? null,
      extends: agentConfig.extends ?? "default",
      topic_name: agentConfig.topic_name,
      topic_emoji: agentConfig.topic_emoji,
      auth: {
        authenticated: auth?.authenticated ?? false,
        subscriptionType: auth?.subscriptionType,
        timeUntilExpiry: auth?.timeUntilExpiry,
        expiresAt: auth?.expiresAt,
      },
      memoryCollection: collection,
    });
  }

  return agents;
}

export function handleStartAgent(name: string): { ok: boolean; error?: string } {
  try {
    startAgent(name);
    void captureEvent("agent_started", { agent: name, source: "web_api" });
    return { ok: true };
  } catch (err) {
    void captureException(err, { action: "start_agent", agent: name });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function handleStopAgent(name: string): { ok: boolean; error?: string } {
  try {
    stopAgent(name);
    void captureEvent("agent_stopped", { agent: name, source: "web_api" });
    return { ok: true };
  } catch (err) {
    void captureException(err, { action: "stop_agent", agent: name });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function handleRestartAgent(name: string): { ok: boolean; error?: string } {
  try {
    restartAgent(name);
    void captureEvent("agent_restarted", { agent: name, source: "web_api" });
    return { ok: true };
  } catch (err) {
    void captureException(err, { action: "restart_agent", agent: name });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function handleGetLogs(
  name: string,
  lines: number = 50
): { ok: boolean; logs?: string; error?: string } {
  try {
    const output = execFileSync(
      "journalctl",
      ["--user", "-u", `switchroom-${name}`, "--no-pager", "-n", String(lines)],
      { encoding: "utf-8", timeout: 5000 }
    );
    return { ok: true, logs: output };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function handleGetTurns(
  config: SwitchroomConfig,
  agentName: string,
  limit: number,
): { ok: boolean; turns?: Turn[]; error?: string } {
  try {
    const agentsDir = resolveAgentsDir(config);
    const agentDir = resolve(agentsDir, agentName);
    const db = openTurnsDb(agentDir);
    try {
      const turns = listTurnsForAgent(db, { limit });
      return { ok: true, turns };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function handleGetSubagents(
  config: SwitchroomConfig,
  agentName: string,
  status: string | undefined,
): { ok: boolean; subagents?: Subagent[]; error?: string } {
  try {
    const agentsDir = resolveAgentsDir(config);
    const agentDir = resolve(agentsDir, agentName);
    const db = openTurnsDb(agentDir);
    try {
      applySubagentsSchema(db);
      const subagents = listSubagents(db, { status });
      return { ok: true, subagents };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Per-account dashboard view: stock AccountInfo + cached quota snapshot
 * + which agents have this label at slot 0 (primary) vs as a fallback.
 *
 * Quota source is the on-disk snapshot at
 * `~/.switchroom/accounts/<label>/quota.json` (#708) — never a live API
 * call. Snapshots are populated by the gateway/boot card flow.
 */
export interface AccountDashboardInfo extends AccountInfo {
  /** Cached quota snapshot, null when no snapshot has been written. */
  quota: AccountQuotaSnapshot | null;
  /** Agents whose `auth.accounts:[0]` is this label (primary). */
  primaryFor: string[];
  /** Agents that list this label at index >= 1 (fallback only). */
  fallbackFor: string[];
}

export function handleGetAccounts(
  config?: SwitchroomConfig,
  home?: string,
): AccountDashboardInfo[] {
  const infos = getAccountInfos(Date.now(), home);
  return infos.map((info) => {
    const primaryFor: string[] = [];
    const fallbackFor: string[] = [];
    if (config) {
      for (const [name, agent] of Object.entries(config.agents)) {
        const resolved = resolveAgentConfig(
          config.defaults,
          config.profiles,
          agent,
        );
        const list = resolved.auth?.accounts ?? [];
        const idx = list.indexOf(info.label);
        if (idx === 0) primaryFor.push(name);
        else if (idx > 0) fallbackFor.push(name);
      }
      primaryFor.sort();
      fallbackFor.sort();
    }
    return {
      ...info,
      quota: readAccountQuota(info.label, home),
      primaryFor,
      fallbackFor,
    };
  });
}

export interface PromoteAccountResult {
  ok: boolean;
  error?: string;
  /** Agents whose YAML primary changed; the caller should restart these. */
  promoted?: string[];
  alreadyPrimary?: string[];
  fanned?: string[];
  fanFails?: Array<{ agent: string; error: string }>;
}

/**
 * Promote an account to primary on one or more agents. Mirrors
 * `switchroom auth promote` exactly — no shell-out, same code path.
 */
export function handlePromoteAccount(
  config: SwitchroomConfig,
  configPath: string,
  label: string,
  agents: string[],
  home?: string,
): PromoteAccountResult {
  try {
    const outcome: PromoteOutcome = promoteAccountToPrimary({
      label,
      agents,
      config,
      configPath,
      home,
    });
    void captureEvent("account_promoted", {
      account: label,
      agents: agents.join(","),
      promoted_count: outcome.promoted.length,
      source: "web_api",
    });
    return {
      ok: true,
      promoted: outcome.promoted,
      alreadyPrimary: outcome.alreadyPrimary,
      fanned: outcome.fanned,
      fanFails: outcome.fanFails,
    };
  } catch (err) {
    void captureException(err, { action: "promote_account", account: label });
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface AgentAccountsResponse {
  /** Account labels declared in `agents.<name>.auth.accounts` (cascaded). */
  assigned: string[];
  /** AccountInfo for each label in `assigned` that exists in the global store, in order. */
  details: AccountInfo[];
}

export function handleGetAgentAccounts(
  config: SwitchroomConfig,
  agentName: string,
  home?: string,
): AgentAccountsResponse {
  const agent = config.agents[agentName];
  const resolved = resolveAgentConfig(config.defaults, config.profiles, agent);
  const assigned = resolved.auth?.accounts ?? [];
  const allInfos = getAccountInfos(Date.now(), home);
  const byLabel = new Map(allInfos.map((info) => [info.label, info]));
  const details = assigned
    .map((label) => byLabel.get(label))
    .filter((info): info is AccountInfo => info !== undefined);
  return { assigned, details };
}

export function handleGetAgentConfig(
  config: SwitchroomConfig,
  agentName: string,
): AgentConfig {
  const agent = config.agents[agentName];
  return resolveAgentConfig(config.defaults, config.profiles, agent);
}
