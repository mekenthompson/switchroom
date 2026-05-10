/**
 * Vault-locked pre-flight check for `switchroom agent restart`.
 *
 * Restarting an agent whose `bot_token` is a `vault:` reference while the
 * vault broker is locked produces a dead agent: the gateway boots, can't
 * resolve the token, can't reach Telegram, and the operator has to dig
 * through journal logs to figure out why their bot went silent. This
 * pre-flight catches that before issuing the systemctl restart.
 *
 * Plaintext bot_token values are unaffected — the check only fires when
 * the effective token (per-agent override → global) starts with `vault:`.
 *
 * Broker-unreachable is treated as locked: if we can't ask the broker
 * whether it's unlocked, we don't know if the restart will succeed, and
 * the safe default is to refuse rather than risk a silent outage.
 */
import type { SwitchroomConfig } from "../config/schema.js";
import { isVaultReference } from "../vault/resolver.js";
import { statusViaBroker } from "../vault/broker/client.js";
import type { BrokerStatus } from "../vault/broker/protocol.js";
import { isDockerRuntime } from "../runtime-mode.js";

export type VaultPreflightVerdict =
  | { kind: "ok" }
  | { kind: "skip"; reason: "plaintext-token" | "no-token" }
  | { kind: "locked"; reachable: boolean };

/**
 * Resolve the effective bot_token string for an agent, applying the
 * per-agent override → global fallback contract documented in
 * `src/telegram/materialize-bot-token.ts`.
 */
export function effectiveBotToken(
  config: SwitchroomConfig,
  agentName: string,
): string | undefined {
  const agent = config.agents?.[agentName] as { bot_token?: string } | undefined;
  if (agent?.bot_token && agent.bot_token.length > 0) return agent.bot_token;
  return config.telegram?.bot_token;
}

export interface VaultPreflightDeps {
  /** Test seam — defaults to the real broker client. */
  status?: () => Promise<BrokerStatus | null>;
}

/**
 * Run the vault-locked pre-flight for a single agent. Returns a verdict
 * the caller turns into a CLI message + exit code.
 */
export async function checkVaultPreflight(
  config: SwitchroomConfig,
  agentName: string,
  deps: VaultPreflightDeps = {},
): Promise<VaultPreflightVerdict> {
  const token = effectiveBotToken(config, agentName);
  if (!token) return { kind: "skip", reason: "no-token" };
  if (!isVaultReference(token)) return { kind: "skip", reason: "plaintext-token" };

  const fetch = deps.status ?? (() => statusViaBroker());
  const status = await fetch();
  if (status === null) {
    // Broker unreachable. We can't verify; treat as locked.
    return { kind: "locked", reachable: false };
  }
  if (!status.unlocked) {
    return { kind: "locked", reachable: true };
  }
  return { kind: "ok" };
}

/**
 * Run the pre-flight against multiple agents in one pass. The broker
 * status RPC is made once and shared — bulk restart shouldn't ping the
 * broker N times. Returns the list of agents whose restart would be
 * blocked by a locked vault.
 */
export async function checkVaultPreflightBulk(
  config: SwitchroomConfig,
  agentNames: string[],
  deps: VaultPreflightDeps = {},
): Promise<{
  blocked: { agent: string; verdict: Extract<VaultPreflightVerdict, { kind: "locked" }> }[];
  reachable: boolean;
}> {
  // Decide whether ANY agent has a vault: token. If none do, skip the
  // broker call entirely.
  const vaultAgents = agentNames.filter((n) => {
    const t = effectiveBotToken(config, n);
    return typeof t === "string" && isVaultReference(t);
  });
  if (vaultAgents.length === 0) {
    return { blocked: [], reachable: true };
  }

  const fetch = deps.status ?? (() => statusViaBroker());
  const status = await fetch();
  if (status === null) {
    return {
      blocked: vaultAgents.map((agent) => ({
        agent,
        verdict: { kind: "locked", reachable: false } as const,
      })),
      reachable: false,
    };
  }
  if (status.unlocked) {
    return { blocked: [], reachable: true };
  }
  return {
    blocked: vaultAgents.map((agent) => ({
      agent,
      verdict: { kind: "locked", reachable: true } as const,
    })),
    reachable: true,
  };
}

/**
 * Format a refusal message for a single locked-vault verdict. Exported
 * so the CLI command and tests share one source of truth for wording.
 */
/**
 * Build the unlock-instruction lines, runtime-aware.
 *
 * Pre-fix this always said "Run: switchroom vault broker unlock". That
 * verb dispatches via the broker socket — which under v0.7 docker mode
 * was unreachable from the host shell, so following the instruction
 * just looped back to the same "broker unreachable" error. Now: if the
 * broker is reachable (locked path), the verb works the same in both
 * runtimes. If the broker is unreachable (the failure mode that
 * historically pointed at this message), we surface the docker-mode
 * paths the architecture actually supports — Telegram /vault unlock
 * or `docker exec` into the broker container.
 */
function unlockInstructionLines(reachable: boolean): string[] {
  if (reachable) {
    return ["  Run: switchroom vault broker unlock"];
  }
  if (isDockerRuntime()) {
    return [
      "  Broker container appears down. Bring the project up first:",
      "    docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d",
      "  Then unlock from any agent's Telegram chat (`/vault unlock`) or via:",
      "    docker exec -it switchroom-vault-broker switchroom vault broker unlock",
    ];
  }
  return ["  Run: switchroom vault broker unlock"];
}

export function formatLockedRefusal(
  agentName: string,
  verdict: Extract<VaultPreflightVerdict, { kind: "locked" }>,
): string {
  const head = verdict.reachable
    ? `Cannot restart ${agentName}: bot_token is a vault reference (vault:...) but vault is locked.`
    : `Cannot restart ${agentName}: bot_token is a vault reference (vault:...) and the vault broker is unreachable (treating as locked).`;
  return [
    head,
    "",
    ...unlockInstructionLines(verdict.reachable),
    `  Then retry: switchroom agent restart ${agentName}`,
    "",
    `  To restart anyway (will hard-fail with cleaner error): switchroom agent restart ${agentName} --force-locked`,
  ].join("\n");
}

export function formatLockedRefusalBulk(
  blocked: { agent: string }[],
  reachable: boolean,
): string {
  const head = reachable
    ? `Cannot restart: vault is locked and the following agents have vault: bot_token references:`
    : `Cannot restart: vault broker is unreachable and the following agents have vault: bot_token references (treating as locked):`;
  return [
    head,
    ...blocked.map((b) => `    ${b.agent}`),
    "",
    ...unlockInstructionLines(reachable),
    "  Then retry the restart.",
    "",
    "  To restart anyway (will hard-fail with cleaner error): re-run with --force-locked",
  ].join("\n");
}
