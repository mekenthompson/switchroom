import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentConfig, SwitchroomConfig } from "../config/schema.js";
import {
  getAllAgentStatuses,
  startAgent,
  stopAgent,
  restartAgent,
  containerName,
} from "../agents/lifecycle.js";
import { getAllAuthStatuses } from "../auth/manager.js";
import { getCollectionForAgent } from "../memory/hindsight.js";
import {
  getHindsightStatus,
  isHindsightRunning,
} from "../setup/hindsight.js";
import {
  defaultAuditLogPath,
  readAndFilter,
  type AuditEntry,
} from "../host-control/audit-reader.js";
import {
  collectScheduleEntries,
  type SchedulerEntry,
  type DispatchResult,
} from "../scheduler/dispatch.js";
import { readRecentFires } from "../agent-scheduler/replay.js";
import {
  approvalList,
  resolveKernelOperatorSocket,
} from "../vault/approvals/client.js";
import type { ApprovalDecisionMeta } from "../vault/broker/protocol.js";
import { captureEvent, captureException } from "../analytics/posthog.js";
import { resolveAgentsDir } from "../config/loader.js";
import { resolveAgentConfig } from "../config/merge.js";
import { getAccountInfos, type AccountInfo } from "../auth/account-store.js";
import {
  AuthBrokerError,
  AuthBrokerUnreachableError,
  withAuthBrokerClient,
  type AccountState,
} from "../auth/broker/client.js";
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
  primaryAccount?: string;
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
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agentConfig);
    // RFC H schema: per-agent `auth.override:` wins, else fleet-wide
    // `auth.active`. No more per-agent fallback list.
    const primaryAccount = resolved.auth?.override ?? config.auth?.active;

    agents.push({
      name,
      active: status?.active ?? "unknown",
      uptime: status?.uptime ?? null,
      memory: status?.memory ?? null,
      extends: agentConfig.extends ?? "default",
      topic_name: agentConfig.topic_name,
      topic_emoji: agentConfig.topic_emoji,
      primaryAccount,
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
  // Agents are Docker containers since v0.7 — there is no
  // `switchroom-<name>` systemd user unit to journalctl against.
  // `docker logs` splits the container's stdout/stderr across the two
  // fds; a container can log to either, so merge both for a complete
  // view. spawnSync hands back both streams regardless of exit code.
  const res = spawnSync(
    "docker",
    ["logs", "--tail", String(lines), containerName(name)],
    { encoding: "utf-8", timeout: 5000 },
  );
  if (res.error) {
    return { ok: false, error: res.error.message };
  }
  if (res.status !== 0) {
    const stderr = (res.stderr ?? "").trim();
    return {
      ok: false,
      error: stderr || `docker logs exited ${res.status ?? "non-zero"}`,
    };
  }
  return { ok: true, logs: `${res.stdout ?? ""}${res.stderr ?? ""}` };
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
 * Per-account dashboard view: stock AccountInfo + broker-derived quota
 * state + which agents are currently bound to this account.
 *
 * Quota source post-RFC-H is the broker's `list-state` snapshot — there's
 * no more `~/.switchroom/accounts/<label>/quota.json`. When the broker
 * is unreachable the quota field is `null` and callers fall back to the
 * cached view (Decision 9: degraded, not catastrophic).
 */
export interface AccountDashboardInfo extends AccountInfo {
  /** Broker-derived quota / exhaustion state. `null` when broker unreachable. */
  quota: AccountState | null;
  /** Agents currently bound to this account (fleet active or per-agent override). */
  usedBy: string[];
}

export async function handleGetAccounts(
  config?: SwitchroomConfig,
  home?: string,
): Promise<AccountDashboardInfo[]> {
  const infos = getAccountInfos(Date.now(), home);
  const brokerAccounts = new Map<string, AccountState>();
  try {
    await withAuthBrokerClient(async (client) => {
      const state = await client.listState();
      for (const a of state.accounts) brokerAccounts.set(a.label, a);
    });
  } catch (err) {
    if (!(err instanceof AuthBrokerUnreachableError)) throw err;
    // Degraded mode — keep the account list, drop the quota rows.
  }
  return infos.map((info) => {
    const usedBy: string[] = [];
    if (config) {
      const fleetActive = config.auth?.active;
      for (const [name, agent] of Object.entries(config.agents)) {
        const resolved = resolveAgentConfig(
          config.defaults,
          config.profiles,
          agent,
        );
        const bound = resolved.auth?.override ?? fleetActive;
        if (bound === info.label) usedBy.push(name);
      }
      usedBy.sort();
    }
    return {
      ...info,
      quota: brokerAccounts.get(info.label) ?? null,
      usedBy,
    };
  });
}

export interface UseAccountResult {
  ok: boolean;
  error?: string;
  /** Resolved fleet-active label after the call. */
  active?: string;
  /** Agents whose per-agent mirror the broker rewrote. */
  fanned?: string[];
}

/**
 * Set the fleet-wide active account. Replaces the pre-RFC-H
 * `/api/accounts/:label/promote` endpoint. No YAML rewrite from this
 * code path — the broker owns mirror writes; the CLI handles YAML
 * when present.
 */
export async function handleUseAccount(label: string): Promise<UseAccountResult> {
  try {
    const data = await withAuthBrokerClient((client) => client.setActive(label));
    void captureEvent("auth_use", {
      account: label,
      fanned_count: data.fanned.length,
      source: "web_api",
    });
    return { ok: true, active: data.active, fanned: data.fanned };
  } catch (err) {
    void captureException(err, { action: "auth_use", account: label });
    let msg: string;
    if (err instanceof AuthBrokerUnreachableError) msg = err.message;
    else if (err instanceof AuthBrokerError) msg = `${err.code}: ${err.message}`;
    else msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export interface AgentAccountsResponse {
  /** Single bound account label — fleet active or per-agent override. */
  active: string | null;
  /** AccountInfo for the bound label when present in the global store. */
  details: AccountInfo[];
}

export function handleGetAgentAccounts(
  config: SwitchroomConfig,
  agentName: string,
  home?: string,
): AgentAccountsResponse {
  const agent = config.agents[agentName];
  const resolved = resolveAgentConfig(config.defaults, config.profiles, agent);
  const active = resolved.auth?.override ?? config.auth?.active ?? null;
  const allInfos = getAccountInfos(Date.now(), home);
  const byLabel = new Map(allInfos.map((info) => [info.label, info]));
  const details: AccountInfo[] = [];
  if (active) {
    const info = byLabel.get(active);
    if (info) details.push(info);
  }
  return { active, details };
}

export function handleGetAgentConfig(
  config: SwitchroomConfig,
  agentName: string,
): AgentConfig {
  const agent = config.agents[agentName];
  return resolveAgentConfig(config.defaults, config.profiles, agent);
}

/**
 * Fleet infrastructure health — the three singletons the dashboard
 * never surfaced (auth-broker, hindsight, hostd). All reads are
 * best-effort and degrade independently: a broker timeout doesn't
 * blank the hindsight panel and vice versa. This is observability,
 * not control — no mutating ops live here.
 */
export interface SystemHealth {
  broker: {
    reachable: boolean;
    active?: string;
    accounts?: number;
    agents?: number;
    consumers?: number;
    error?: string;
  };
  hindsight: {
    /** Raw `docker ps` Status string, or null when the container is absent. */
    containerStatus: string | null;
    running: boolean;
    /** Live values read from the running container's env (truth, not the
     *  compile-time default) — null when the container isn't inspectable. */
    model: string | null;
    provider: string | null;
    mcpStateless: boolean | null;
  };
  hostd: {
    auditLogPresent: boolean;
    /** Most-recent privileged-verb audit rows (newest last), capped. */
    recent: AuditEntry[];
    error?: string;
  };
}

/**
 * Pull a single env var out of `docker inspect`'s Config.Env array for
 * a container. Returns null when the container is absent or the var
 * isn't set — the caller renders that as "unknown" rather than guessing
 * from the compile-time default (the running container is the truth).
 */
function inspectEnv(
  container: string,
  keys: readonly string[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const k of keys) out[k] = null;
  const res = spawnSync(
    "docker",
    ["inspect", "--format", "{{json .Config.Env}}", container],
    { encoding: "utf-8", timeout: 4000 },
  );
  if (res.error || res.status !== 0 || !res.stdout) return out;
  try {
    const env = JSON.parse(res.stdout.trim()) as string[];
    for (const pair of env) {
      const eq = pair.indexOf("=");
      if (eq < 0) continue;
      const name = pair.slice(0, eq);
      if (name in out) out[name] = pair.slice(eq + 1);
    }
  } catch {
    /* malformed inspect output — leave nulls */
  }
  return out;
}

export async function handleGetSystemHealth(
  home?: string,
): Promise<SystemHealth> {
  // ── auth-broker ──────────────────────────────────────────────────
  const broker: SystemHealth["broker"] = { reachable: false };
  try {
    await withAuthBrokerClient(async (client) => {
      const state = await client.listState();
      broker.reachable = true;
      broker.active = state.active;
      broker.accounts = state.accounts.length;
      broker.agents = state.agents.length;
      broker.consumers = state.consumers.length;
    });
  } catch (err) {
    broker.reachable = false;
    if (err instanceof AuthBrokerUnreachableError) {
      broker.error = err.message;
    } else if (err instanceof AuthBrokerError) {
      broker.error = `${err.code}: ${err.message}`;
    } else {
      broker.error = err instanceof Error ? err.message : String(err);
    }
  }

  // ── hindsight ────────────────────────────────────────────────────
  const containerStatus = getHindsightStatus();
  const running = isHindsightRunning();
  const env = running
    ? inspectEnv("switchroom-hindsight", [
        "HINDSIGHT_API_LLM_MODEL",
        "HINDSIGHT_API_LLM_PROVIDER",
        "HINDSIGHT_API_MCP_STATELESS",
      ])
    : {
        HINDSIGHT_API_LLM_MODEL: null,
        HINDSIGHT_API_LLM_PROVIDER: null,
        HINDSIGHT_API_MCP_STATELESS: null,
      };
  const statelessRaw = env.HINDSIGHT_API_MCP_STATELESS;
  const hindsight: SystemHealth["hindsight"] = {
    containerStatus,
    running,
    model: env.HINDSIGHT_API_LLM_MODEL,
    provider: env.HINDSIGHT_API_LLM_PROVIDER,
    mcpStateless:
      statelessRaw == null ? null : statelessRaw.toLowerCase() === "true",
  };

  // ── hostd ────────────────────────────────────────────────────────
  const hostd: SystemHealth["hostd"] = {
    auditLogPresent: false,
    recent: [],
  };
  try {
    const logPath = defaultAuditLogPath(home);
    if (existsSync(logPath)) {
      hostd.auditLogPresent = true;
      const raw = readFileSync(logPath, "utf-8");
      hostd.recent = readAndFilter(raw, {}, 10);
    }
  } catch (err) {
    hostd.error = err instanceof Error ? err.message : String(err);
  }

  return { broker, hindsight, hostd };
}

/**
 * Google Workspace (RFC G) accounts. Live inventory (expiry / scope /
 * clientId) comes from the broker; the per-agent ACL is config-side
 * (`google_accounts[email].enabled_for`). Broker-unreachable degrades
 * to "config only" — the ACL still renders, live fields are null.
 */
export interface GoogleAccountDashboardInfo {
  account: string;
  expiresAt: number | null;
  scope: string | null;
  clientId: string | null;
  /** Agents allowed to use this account (config ACL). */
  enabledFor: string[];
  /** false when the broker couldn't confirm the slot exists. */
  brokerKnown: boolean;
}

export async function handleGetGoogleAccounts(
  config: SwitchroomConfig,
): Promise<GoogleAccountDashboardInfo[]> {
  const live = new Map<
    string,
    { expiresAt: number; scope: string; clientId: string }
  >();
  try {
    await withAuthBrokerClient(async (client) => {
      const data = await client.listGoogleAccounts();
      for (const a of data.accounts) {
        live.set(a.account.toLowerCase(), {
          expiresAt: a.expiresAt,
          scope: a.scope,
          clientId: a.clientId,
        });
      }
    });
  } catch (err) {
    if (!(err instanceof AuthBrokerUnreachableError)) throw err;
    // Degraded: ACL still renders from config; live fields stay null.
  }
  // Union of config-declared accounts and broker-known slots so an
  // account present in only one source is still visible.
  const cfgAccounts = config.google_accounts ?? {};
  const keys = new Set<string>([
    ...Object.keys(cfgAccounts).map((k) => k.toLowerCase()),
    ...live.keys(),
  ]);
  const out: GoogleAccountDashboardInfo[] = [];
  for (const key of [...keys].sort()) {
    const cfg = cfgAccounts[key];
    const l = live.get(key);
    out.push({
      account: key,
      expiresAt: l?.expiresAt ?? null,
      scope: l?.scope ?? null,
      clientId: l?.clientId ?? null,
      enabledFor: cfg?.enabled_for ? [...cfg.enabled_for].sort() : [],
      brokerKnown: l != null,
    });
  }
  return out;
}

/**
 * Cron schedule view: every cascade-resolved schedule entry plus the
 * most-recent fire rows from each agent's host-side `scheduler.jsonl`
 * (the bind source for the in-container `/state/agent/scheduler.jsonl`
 * ledger). No next-fire calculation — that needs a cron parser we
 * deliberately don't depend on; the cron expression + recent-fire
 * history is the high-signal data without the dep.
 */
export interface ScheduleDashboard {
  entries: SchedulerEntry[];
  /** agent → most-recent DispatchResult rows (newest last), capped. */
  recentByAgent: Record<string, DispatchResult[]>;
}

export function handleGetSchedule(
  config: SwitchroomConfig,
): ScheduleDashboard {
  const entries = collectScheduleEntries(config);
  const agentsDir = resolveAgentsDir(config);
  const recentByAgent: Record<string, DispatchResult[]> = {};
  const agents = new Set(entries.map((e) => e.agent));
  for (const agent of agents) {
    // Reuse the canonical ledger reader (existsSync + torn-line skip
    // baked in) so the dashboard and the boot-replay path can't drift.
    const rows = readRecentFires(
      resolve(agentsDir, agent, "scheduler.jsonl"),
    );
    if (rows.length > 0) recentByAgent[agent] = rows.slice(-10);
  }
  return { entries, recentByAgent };
}

/**
 * Approval-kernel decision ledger (RFC B) — the host read-only view
 * over the operator socket added in #1362. The kernel restricts that
 * socket to `approval_list`, so this is observation only: no grant /
 * consume / revoke is reachable from here by construction.
 *
 * Three states, each rendered distinctly rather than collapsed:
 *   - operator socket absent  → kernel not host-reachable on this
 *     install (pre-#1362 deploy, or operatorUid unset). `reachable:false`.
 *   - socket present, RPC null → kernel down / protocol error.
 *   - ok → decisions[] (newest first for the table).
 */
export interface ApprovalsDashboard {
  reachable: boolean;
  decisions: ApprovalDecisionMeta[];
  error?: string;
}

export async function handleGetApprovals(): Promise<ApprovalsDashboard> {
  const opSock = resolveKernelOperatorSocket();
  if (opSock === null) {
    return {
      reachable: false,
      decisions: [],
      error:
        "approval-kernel operator socket not present — host-side approval " +
        "listing needs operatorUid set (compose) and a post-#1362 deploy.",
    };
  }
  // No agent_unit filter → fleet-wide. Pin opts.socket to the operator
  // socket so the resolver doesn't fall through to the broker.
  const decisions = await approvalList(undefined, { socket: opSock });
  if (decisions === null) {
    return {
      reachable: false,
      decisions: [],
      error: "approval-kernel unreachable or returned an error",
    };
  }
  // Newest first — most relevant grant at the top of the table.
  const sorted = [...decisions].sort((a, b) => b.granted_at - a.granted_at);
  return { reachable: true, decisions: sorted };
}
