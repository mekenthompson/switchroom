/**
 * Account promotion (move a label to position 0 of an agent's
 * `auth.accounts:` list — making it the new primary).
 *
 * This module is the single source of truth for the "promote" action.
 * Both the CLI verb (`switchroom auth promote`) and the web dashboard
 * (`POST /api/accounts/:label/promote`) call into here so the YAML
 * mutation + fanout sequence stays consistent and there's no shell-out
 * from the web server back into the CLI.
 *
 * Pure-ish: takes a config, a yaml path, a label and agents; mutates
 * disk (yaml + per-agent fanout) and returns a structured outcome.
 * Throws on validation failures.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

import type { SwitchroomConfig } from "../config/schema.js";
import { resolveAgentsDir } from "../config/loader.js";
import {
  accountExists,
  validateAccountLabel,
} from "./account-store.js";
import { fanoutAccountToAgents } from "./account-refresh.js";
import {
  getAccountsForAgent,
  promoteAccountForAgent,
} from "../cli/auth-accounts-yaml.js";

export interface PromoteOutcome {
  /** Agents whose YAML position-0 was changed by this call. */
  promoted: string[];
  /** Agents that already had this label at position 0 (no-op). */
  alreadyPrimary: string[];
  /** Agents that received a fanout of the new primary's credentials. */
  fanned: string[];
  /** Per-agent fanout failures with messages. */
  fanFails: Array<{ agent: string; error: string }>;
}

export interface PromoteOptions {
  /** Account label to promote. Must exist in the global account store. */
  label: string;
  /** Agents to promote on. Each must have `label` already in their auth.accounts. */
  agents: string[];
  /** Loaded switchroom config (used for resolveAgentsDir + agent existence). */
  config: SwitchroomConfig;
  /** Path to switchroom.yaml — read + rewritten in-place. */
  configPath: string;
  /** Override $HOME (tests). Defaults to homedir(). */
  home?: string;
}

/**
 * Promote `label` to position 0 (primary) on each of `agents`. Throws
 * on validation; partial failures during fanout are returned in the
 * outcome rather than thrown so a single bad agent dir doesn't roll
 * back the YAML mutation for the rest.
 *
 * Validation order:
 *   1. label format
 *   2. account exists on disk
 *   3. every agent declared in config
 *   4. every agent has the label in its current auth.accounts list
 *
 * Idempotent: agents already at position 0 are returned in
 * `alreadyPrimary`, the YAML is left untouched for them, and they
 * receive no fanout.
 */
export function promoteAccountToPrimary(opts: PromoteOptions): PromoteOutcome {
  const home = opts.home ?? homedir();
  validateAccountLabel(opts.label);
  if (!accountExists(opts.label, home)) {
    throw new Error(
      `Account "${opts.label}" does not exist. Add it first with 'switchroom auth account add ${opts.label}'.`,
    );
  }
  for (const name of opts.agents) {
    if (!opts.config.agents[name]) {
      throw new Error(`agent '${name}' is not declared in switchroom.yaml`);
    }
  }

  const before = readFileSync(opts.configPath, "utf-8");
  // Pre-validate every agent has the label in its list.
  for (const name of opts.agents) {
    const current = getAccountsForAgent(before, name);
    if (!current.includes(opts.label)) {
      throw new Error(
        `account '${opts.label}' is not enabled on agent '${name}' — enable it first with 'switchroom auth enable ${opts.label} ${name}'.`,
      );
    }
  }

  let after = before;
  const promoted: string[] = [];
  const alreadyPrimary: string[] = [];
  for (const name of opts.agents) {
    const current = getAccountsForAgent(after, name);
    if (current[0] === opts.label) {
      alreadyPrimary.push(name);
      continue;
    }
    after = promoteAccountForAgent(after, name, opts.label);
    promoted.push(name);
  }
  if (after !== before) {
    writeFileSync(opts.configPath, after);
  }

  const agentsDir = resolveAgentsDir(opts.config);
  const fanTargets = promoted.map((name) => ({
    name,
    agentDir: resolve(agentsDir, name),
  }));
  const outcomes =
    fanTargets.length > 0
      ? fanoutAccountToAgents(opts.label, fanTargets, { home })
      : [];
  const fanned = outcomes
    .filter((o) => o.kind === "fanned-out")
    .map((o) => o.agent);
  const fanFails = outcomes
    .filter((o): o is Extract<typeof o, { kind: "fanout-failed" }> =>
      o.kind === "fanout-failed",
    )
    .map((o) => ({ agent: o.agent, error: o.error }));

  return { promoted, alreadyPrimary, fanned, fanFails };
}
