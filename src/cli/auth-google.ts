/**
 * `switchroom auth google ...` — RFC G Phase 3a CLI verbs.
 *
 * Mirrors the `switchroom auth account ...` shape from `auth-accounts.ts`
 * exactly (per RFC G §4.5), but indexes per-Google-account rather than
 * per-Anthropic-account:
 *
 *   switchroom auth google enable <account> <agents...>
 *   switchroom auth google disable <account> <agents...>
 *   switchroom auth google list                              # accounts × agents matrix
 *
 * Phase 3a (this file) intentionally OMITS:
 *   - account add / remove (need OAuth flow refactor — Phase 3b)
 *   - share (one-shot enable + add) — Phase 3b
 *   - connect (wizard alias for first-run UX) — Phase 3b
 *   - drive connect/disconnect aliasing — Phase 3b
 *   - apply-time legacy-slot detector wiring — Phase 3b
 *
 * The reason for the split: the OAuth flow is currently inlined in
 * `src/cli/drive.ts:runConnect()` (lines 259–620, narrowly wired to the
 * Drive-only approval flow). Extracting it cleanly is its own piece of
 * work, and the load-bearing value of Phase 3 — letting operators
 * declare which agents share which Google account in YAML — is reachable
 * with just enable/disable/list. Operators can populate
 * `google_accounts.<email>.enabled_for[]` by hand or via these verbs;
 * Phase 3b adds the OAuth-driven `account add` that mints the vault
 * slot for them.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync } from "node:fs";

import {
  disableAgentsOnGoogleAccount,
  enableAgentsOnGoogleAccount,
  getEnabledAgentsForGoogleAccount,
  listGoogleAccounts,
} from "./google-accounts-yaml.js";
import { withConfigError, getConfig, getConfigPath } from "./helpers.js";
import type { SwitchroomConfig } from "../config/schema.js";

export function registerAuthGoogleSubcommands(
  program: Command,
  authParent: Command,
): void {
  const google = authParent
    .command("google")
    .description(
      "Manage Google Workspace accounts shared across agents (RFC G — see docs/rfcs/google-workspace-generalization.md)",
    );

  registerEnable(google, program);
  registerDisable(google, program);
  registerList(google, program);
}

function registerEnable(googleParent: Command, program: Command): void {
  googleParent
    .command("enable <account> <agents...>")
    .description(
      "Enable a Google account on one or more agents (appends to switchroom.yaml google_accounts.<account>.enabled_for[]). Use `all` to enable on every declared agent. Mirrors `auth enable` exactly.",
    )
    .action(
      withConfigError(async (account: string, agents: string[]) => {
        const normalizedAccount = validateAndNormalizeAccountEmail(account);
        const config = getConfig(program);
        agents = expandAllAgents(agents, config);

        // Verify all named agents exist in switchroom.yaml. Fail-fast
        // before touching the YAML.
        for (const name of agents) {
          if (!config.agents[name]) {
            throw new Error(
              `agent '${name}' is not declared in switchroom.yaml under 'agents:'`,
            );
          }
        }

        const yamlPath = getConfigPath(program);
        const before = readFileSync(yamlPath, "utf-8");
        const after = enableAgentsOnGoogleAccount(before, normalizedAccount, agents);
        const noop = after === before;
        if (!noop) {
          writeFileSync(yamlPath, after);
        }

        const enabledAfter = getEnabledAgentsForGoogleAccount(after, normalizedAccount) ?? [];
        const newlyEnabled = agents.filter((a) => !getEnabledAgentsBefore(before, normalizedAccount).includes(a));

        console.log();
        if (noop) {
          console.log(
            `No change — ${chalk.bold(normalizedAccount)} already enabled on: ${agents.join(", ")}`,
          );
        } else {
          console.log(
            `${chalk.green("✓")} Enabled ${chalk.bold(normalizedAccount)} on: ${newlyEnabled.join(", ")}`,
          );
        }
        console.log(
          `  ${chalk.gray("now enabled on:")} ${enabledAfter.join(", ") || "(none)"}`,
        );
        console.log();
        // Restart hint only when something actually changed — pure
        // no-op enables don't require a restart, and printing a
        // restart command with no agents to restart is misleading.
        if (newlyEnabled.length > 0) {
          console.log(
            `Next: ${chalk.bold(`switchroom agent restart ${newlyEnabled.join(" ")}`)} so the wrapper picks up the new ACL.`,
          );
          console.log();
        }
      }),
    );
}

function registerDisable(googleParent: Command, program: Command): void {
  googleParent
    .command("disable <account> <agents...>")
    .description(
      "Disable a Google account on one or more agents. Use `all` to disable on every declared agent. Leaves the account in google_accounts: with an empty enabled_for[] (dormant) — does NOT remove the vault slot. Use `auth google account remove` (Phase 3b) for full teardown.",
    )
    .action(
      withConfigError(async (account: string, agents: string[]) => {
        const normalizedAccount = validateAndNormalizeAccountEmail(account);
        const config = getConfig(program);
        agents = expandAllAgents(agents, config);
        const yamlPath = getConfigPath(program);
        const before = readFileSync(yamlPath, "utf-8");
        const enabledBefore = getEnabledAgentsBefore(before, normalizedAccount);

        if (enabledBefore.length === 0) {
          console.log();
          console.log(
            chalk.yellow(`Account ${chalk.bold(normalizedAccount)} is not currently enabled on any agent — nothing to do.`),
          );
          console.log();
          return;
        }

        const after = disableAgentsOnGoogleAccount(before, normalizedAccount, agents);
        const noop = after === before;
        if (!noop) {
          writeFileSync(yamlPath, after);
        }

        const enabledAfter = getEnabledAgentsForGoogleAccount(after, normalizedAccount) ?? [];
        const removed = enabledBefore.filter((a) => !enabledAfter.includes(a));

        console.log();
        if (removed.length === 0) {
          console.log(
            `No change — none of ${agents.join(", ")} were enabled on ${chalk.bold(normalizedAccount)}.`,
          );
        } else {
          console.log(
            `${chalk.green("✓")} Disabled ${chalk.bold(normalizedAccount)} from: ${removed.join(", ")}`,
          );
        }
        if (enabledAfter.length === 0) {
          console.log(
            `  ${chalk.gray("account is now")} ${chalk.bold("dormant")} ${chalk.gray("(empty enabled_for[])")}`,
          );
          console.log(
            `  Standing approval-kernel grants under removed agents become dormant (RFC G §4.4).`,
          );
        } else {
          console.log(
            `  ${chalk.gray("still enabled on:")} ${enabledAfter.join(", ")}`,
          );
        }
        console.log();
        if (removed.length > 0) {
          console.log(
            `Next: ${chalk.bold(`switchroom agent restart ${removed.join(" ")}`)} so the wrapper drops its access.`,
          );
          console.log();
        }
      }),
    );
}

function registerList(googleParent: Command, program: Command): void {
  googleParent
    .command("list")
    .description(
      "List every Google account configured in switchroom.yaml with its enabled_for[] agents. Matrix view of accounts × agents.",
    )
    .option("--json", "Emit raw JSON instead of a table")
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const yamlPath = getConfigPath(program);
        const yaml = readFileSync(yamlPath, "utf-8");
        const accounts = listGoogleAccounts(yaml);

        if (opts.json) {
          console.log(JSON.stringify(accounts, null, 2));
          return;
        }

        console.log();
        if (accounts.length === 0) {
          console.log(
            chalk.gray("No Google accounts configured."),
          );
          console.log(
            `Add one (Phase 3b): ${chalk.bold("switchroom auth google account add <email>")}`,
          );
          console.log(
            `Or hand-edit: add a ${chalk.bold("google_accounts:")} block to switchroom.yaml.`,
          );
          console.log();
          return;
        }

        const accountColWidth = Math.max(
          ...accounts.map((a) => a.account.length),
          "ACCOUNT".length,
        );
        console.log(
          `${pad("ACCOUNT", accountColWidth)}  AGENTS`,
        );
        console.log(
          `${pad("-".repeat(7), accountColWidth)}  ${"-".repeat(6)}`,
        );
        for (const { account, enabled_for } of accounts) {
          const agentList = enabled_for.length === 0
            ? chalk.gray("(dormant — empty enabled_for)")
            : enabled_for.join(", ");
          console.log(`${pad(account, accountColWidth)}  ${agentList}`);
        }
        console.log();
      }),
    );
}

// ────────────────────────────────────────────────────────────────────────
// helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Normalize an account email to the form used everywhere else in the
 * pipeline (lowercase + trim) — schema does this at parse time, vault
 * slot helpers do it on write/read, broker does it on lookup. Doing it
 * here too means the CLI accepts whatever case the operator types.
 *
 * Also enforces the same email-shape regex the schema uses, so
 * malformed input fails at the CLI layer with an actionable error
 * rather than getting written to YAML and rejected on the next
 * config-load (would force operators to hand-edit the YAML to
 * recover).
 */
function validateAndNormalizeAccountEmail(account: string): string {
  const normalized = account.trim().toLowerCase();
  // Same regex as src/config/schema.ts:google_accounts key validator
  // — must contain @ + dot, must NOT contain `:` (which would break
  // the broker's slot-key parser).
  if (!/^[^@\s:]+@[^@\s:]+\.[^@\s:]+$/.test(normalized)) {
    throw new Error(
      `'${account}' is not a valid Google account email. Expected format like 'alice@example.com' (colons not allowed).`,
    );
  }
  return normalized;
}

function getEnabledAgentsBefore(yamlText: string, account: string): string[] {
  return getEnabledAgentsForGoogleAccount(yamlText, account) ?? [];
}

/**
 * Expand the literal token `all` to every declared agent. Mirrors
 * `auth-accounts.ts:expandAllAgents` exactly — operators reasonably
 * try `auth google enable alice@example.com all`, and treating that as
 * literal-agent-named-`all` would be a confusing failure.
 *
 * Pass-through if `all` isn't in the list. Multiple `all`s are
 * harmless (deduplicated by the YAML mutator's idempotency).
 */
function expandAllAgents(agents: string[], config: SwitchroomConfig): string[] {
  if (!agents.includes("all")) return agents;
  const allNames = Object.keys(config.agents);
  if (allNames.length === 0) {
    throw new Error(
      "switchroom.yaml has no agents declared — `all` matches nothing.",
    );
  }
  return allNames;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

// Re-export for tests.
export const _testing = {
  validateAndNormalizeAccountEmail,
  getEnabledAgentsBefore,
  expandAllAgents,
};

