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

  // RFC G Phase 3b.3 — account-lifecycle verbs (auth-broker thin clients).
  const account = google
    .command("account")
    .description(
      "Manage Google account credentials (RFC G Phase 3b.3 — broker storage path lands in 3b.2c)",
    );
  registerAccountAdd(account);
  registerAccountRemove(account);
  registerAccountList(account);
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

// ────────────────────────────────────────────────────────────────────────
// RFC G Phase 3b.3 — `auth google account add | remove | list`
// Thin clients over the auth-broker (RFC H), with provider="google"
// passed through. Storage path itself lives in the broker — Phase 3b.2c
// wires it via the vault-broker per RFC G v3 §4.4. Today these verbs
// produce clear errors pointing operators at the next-PR deferral.
// ────────────────────────────────────────────────────────────────────────

function registerAccountAdd(accountParent: Command): void {
  accountParent
    .command("add <account>")
    .description(
      "Mint a Google OAuth refresh token for <account> and register it with the auth-broker. Phase 3b.3 ships the CLI shape; OAuth flow extraction lives in Phase 3b.2c. For now use `switchroom drive connect <agent>` (the v0.6.0 verb).",
    )
    .action(
      withConfigError(async (account: string) => {
        const normalizedAccount = validateAndNormalizeAccountEmail(account);
        console.log();
        console.log(
          chalk.yellow(
            `  ⚠  Phase 3b.3 ships the CLI shape only; the OAuth flow extraction + broker storage path land in Phase 3b.2c.`,
          ),
        );
        console.log();
        console.log(`  For now, use the v0.6.0 verb to mint the token:`);
        console.log(
          chalk.cyan(`    switchroom drive connect <agent-with-google-config>`),
        );
        console.log();
        console.log(
          `  Once the broker storage path lands, this verb will:`,
        );
        console.log(
          chalk.gray(`    1. Run the OAuth device-code / OOB-paste / loopback flow`),
        );
        console.log(
          chalk.gray(`    2. Exchange code for refresh + access tokens`),
        );
        console.log(
          chalk.gray(`    3. Call auth-broker.add-account({provider: "google", account: ${normalizedAccount}, credentials: {...}})`),
        );
        console.log(
          chalk.gray(`    4. Operator runs \`auth google enable ${normalizedAccount} <agents>\` to enable on agents`),
        );
        console.log();
      }),
    );
}

function registerAccountRemove(accountParent: Command): void {
  accountParent
    .command("remove <account>")
    .alias("rm")
    .description(
      "Revoke + delete the Google OAuth credentials for <account>. Refused if any agent is still enabled on the account (run `auth google disable <account> all` first).",
    )
    .action(
      withConfigError(async (account: string) => {
        const normalizedAccount = validateAndNormalizeAccountEmail(account);
        // Use the shared brokerCall helper so error UX matches every
        // other broker-touching verb (operator-actionable
        // "broker unreachable" hint, exit code 2; broker error code
        // + message to stderr, exit code 1).
        const { brokerCall } = await import("./broker-call.js");
        await brokerCall(async (client) => {
          await client.rmAccount(normalizedAccount, "google");
        });
        console.log();
        console.log(
          chalk.green(
            `  ✓ Removed Google account ${chalk.bold(normalizedAccount)} from broker.`,
          ),
        );
        console.log();
      }),
    );
}

function registerAccountList(accountParent: Command): void {
  accountParent
    .command("list")
    .description(
      "List Google accounts known to the auth-broker. Distinct from `auth google list` (which shows the YAML google_accounts × agents matrix).",
    )
    .option("--json", "Emit raw JSON instead of a table")
    .action(
      withConfigError(async (opts: { json?: boolean }) => {
        const { brokerCall } = await import("./broker-call.js");
        // Phase 3b.3 — broker doesn't yet surface per-provider lists.
        // For Google specifically the broker doesn't yet store accounts
        // (Phase 3b.2c lands the storage path); the call below succeeds
        // but only Anthropic accounts come back in `state.accounts`.
        // Verb is scoped to Google — we DON'T leak Anthropic state into
        // the output. JSON mode emits an empty list with the deferral
        // note; human mode prints the deferral + a pointer at the
        // sibling `auth google list` for the YAML matrix view.
        await brokerCall(async (client) => {
          // Trip the broker connection (validates the socket is
          // reachable) but discard the Anthropic-only result — Google
          // listing lands in Phase 3b.2c.
          await client.listState();
        });
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                google_accounts: [],
                note: "Phase 3b.2c will surface Google accounts stored in the broker. Today the broker stores Anthropic only; this verb returns an empty list.",
              },
              null,
              2,
            ),
          );
          return;
        }
        console.log();
        console.log(
          chalk.gray(
            `  Google accounts surfaced via the broker land in Phase 3b.2c.`,
          ),
        );
        console.log(
          `  For the YAML google_accounts × agents matrix, use: ${chalk.bold("switchroom auth google list")}`,
        );
        console.log();
      }),
    );
}

// Re-export for tests.
export const _testing = {
  validateAndNormalizeAccountEmail,
  getEnabledAgentsBefore,
  expandAllAgents,
};

