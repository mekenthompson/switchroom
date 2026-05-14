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
      "Manage Google account credentials in the auth-broker (add / remove / list).",
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
      "Mint a Google OAuth refresh token for <account> and register it with the auth-broker. Three-tier OAuth: device-code → OOB-paste → desktop-loopback (RFC D §3, RFC G §4.5).",
    )
    .option(
      "--replace",
      "Overwrite existing credentials for <account> (default refuses if account already registered)",
      false,
    )
    .action(
      withConfigError(async (account: string, opts: { replace?: boolean }) => {
        const normalizedAccount = validateAndNormalizeAccountEmail(account);

        // Lazy-import the OAuth flow + vault resolver — they pull in
        // sizeable trees (Drive scaffolding, AES vault) that the
        // sibling enable/disable/list verbs don't need.
        const [
          { runDriveOAuthFlow, DRIVE_READONLY_SCOPES },
          { selectInitialTier },
          { brokerCall },
          { loadConfig, resolvePath },
          { getSecret },
          { isVaultReference, parseVaultReference },
        ] = await Promise.all([
          import("./drive.js"),
          import("../drive/oauth.js"),
          import("./broker-call.js"),
          import("../config/loader.js"),
          import("../vault/vault.js"),
          import("../vault/resolver.js"),
        ]);

        const config = loadConfig();
        const gw = config.google_workspace;
        if (!gw) {
          throw new Error(
            "switchroom.yaml is missing a `google_workspace:` block. Add `google_workspace: { google_client_id: ..., google_client_secret: ... }` (vault:<key> refs supported) before connecting accounts.",
          );
        }

        // Resolve OAuth client id + secret. Env wins over config (one-
        // off overrides during operator debugging). vault:<key> refs
        // require the vault passphrase.
        let clientIdRaw =
          process.env.SWITCHROOM_GOOGLE_CLIENT_ID ?? gw.google_client_id;
        let clientSecretRaw =
          process.env.SWITCHROOM_GOOGLE_CLIENT_SECRET ??
          gw.google_client_secret;
        if (!clientIdRaw || !clientSecretRaw) {
          throw new Error(
            "Missing Google OAuth client credentials. Set google_workspace.google_client_id + google_client_secret in switchroom.yaml, or env SWITCHROOM_GOOGLE_CLIENT_ID + SWITCHROOM_GOOGLE_CLIENT_SECRET.",
          );
        }

        const needsVault =
          isVaultReference(clientIdRaw) || isVaultReference(clientSecretRaw);
        if (needsVault) {
          const vaultPath = resolvePath(
            config.vault?.path ?? "~/.switchroom/vault.enc",
          );
          const passphrase =
            process.env.SWITCHROOM_VAULT_PASSPHRASE ??
            (await readHiddenLine("Vault passphrase: "));
          const resolveRef = (raw: string, label: string): string => {
            if (!isVaultReference(raw)) return raw;
            const key = parseVaultReference(raw);
            const entry = getSecret(passphrase, vaultPath, key);
            if (!entry) {
              throw new Error(
                `${label} references vault key '${key}' but no such secret in vault.`,
              );
            }
            if (entry.kind !== "string") {
              throw new Error(
                `${label} vault entry '${key}' is not a string (kind=${entry.kind}).`,
              );
            }
            return entry.value;
          };
          clientIdRaw = resolveRef(clientIdRaw, "google_client_id");
          clientSecretRaw = resolveRef(clientSecretRaw, "google_client_secret");
        }

        const oauthCfg = {
          client_id: clientIdRaw,
          client_secret: clientSecretRaw,
          scopes: DRIVE_READONLY_SCOPES,
        };
        // OAuthEnv is a shaped subset of process.env — picking the
        // fields the selector reads (rather than passing process.env
        // wholesale) keeps the call typed.
        const oauthEnv = {
          DISPLAY: process.env.DISPLAY,
          WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
          SSH_CONNECTION: process.env.SSH_CONNECTION,
          SSH_TTY: process.env.SSH_TTY,
          SWITCHROOM_DRIVE_OAUTH_TIER:
            process.env.SWITCHROOM_DRIVE_OAUTH_TIER,
        };
        const initialTier = selectInitialTier(oauthEnv);

        console.log();
        console.log(
          chalk.bold(
            `Connecting Google account ${chalk.cyan(normalizedAccount)} to switchroom auth-broker.`,
          ),
        );
        console.log(
          chalk.gray(
            `  OAuth tier: ${initialTier} (will fall through if Google rejects)`,
          ),
        );
        console.log();

        const tokens = await runDriveOAuthFlow(
          oauthCfg,
          initialTier,
          process.env,
        );

        if (!tokens.refresh_token) {
          throw new Error(
            "Google did not return a refresh_token. Re-run after revoking prior consent at https://myaccount.google.com/permissions, or set OAUTH_PROMPT=consent in the environment.",
          );
        }

        const googleCreds = buildGoogleCredentials({
          tokens,
          clientId: clientIdRaw,
          accountEmail: normalizedAccount,
          fallbackScope: DRIVE_READONLY_SCOPES.join(" "),
        });

        await brokerCall(async (client) => {
          await client.addAccount(
            normalizedAccount,
            googleCreds,
            opts.replace ?? false,
            "google",
          );
        });

        console.log();
        console.log(
          chalk.green(
            `  ✓ Registered Google account ${chalk.bold(normalizedAccount)} with auth-broker.`,
          ),
        );
        console.log();
        console.log(`  Next: enable on one or more agents:`);
        console.log(
          chalk.cyan(
            `    switchroom auth google enable ${normalizedAccount} <agent> [...]`,
          ),
        );
        console.log();
      }),
    );
}

/**
 * Read a single line from stdin without echoing characters. Mirrors
 * the inline implementations in drive.ts:121 and telegram.ts:584
 * exactly — manual `'data'` accumulation under setRawMode (so
 * keystrokes never reach stdout), `rl.question(prompt, …)` fallback
 * for the non-TTY/pipe case where echo isn't a concern.
 *
 * Extraction of the three duplicates into a shared module is its own
 * cleanup PR (would touch unrelated callsites).
 */
async function readHiddenLine(prompt: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  return await new Promise<string>((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    if (process.stdin.isTTY) {
      process.stdout.write(prompt);
      const stdin = process.stdin;
      stdin.setRawMode(true);
      stdin.resume();
      let input = "";
      const onData = (data: Buffer) => {
        const char = data.toString("utf8");
        if (char === "\n" || char === "\r") {
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          rl.close();
          process.stdout.write("\n");
          resolve(input);
        } else if (char === "") {
          // Ctrl-C
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          rl.close();
          process.stdout.write("\n");
          reject(new Error("Aborted"));
        } else if (char === "" || char === "\b") {
          if (input.length > 0) input = input.slice(0, -1);
        } else {
          input += char;
        }
      };
      stdin.on("data", onData);
    } else {
      rl.question(prompt, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
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
      "List Google accounts stored in the auth-broker. Distinct from `auth google list` (which shows the YAML google_accounts × agents matrix).",
    )
    .option("--json", "Emit raw JSON instead of a table")
    .action(
      withConfigError(async (_opts: { json?: boolean }) => {
        // The broker stores Google credentials per-account today
        // (#1272 / opGoogleAddAccount → google-storage.ts) but doesn't
        // yet expose a `list-google-accounts` op. Rather than return
        // a misleading empty list (which scripts would silently treat
        // as "no accounts"), refuse with NOT_IMPLEMENTED + a pointer
        // at the on-disk source of truth and the sibling YAML matrix
        // verb. A `list-google-accounts` broker op + this verb's
        // wiring is tracked as a follow-up.
        console.error();
        console.error(
          chalk.yellow(
            `  ⚠  \`auth google account list\` is not yet implemented — the broker has no list-google-accounts op.`,
          ),
        );
        console.error();
        console.error(`  To inspect Google accounts the broker holds:`);
        console.error(
          chalk.gray(`    ls ~/.switchroom/state/auth-broker/google/`),
        );
        console.error();
        console.error(`  For the YAML google_accounts × agents matrix:`);
        console.error(
          chalk.cyan(`    switchroom auth google list`),
        );
        console.error();
        process.exit(1);
      }),
    );
}

// ────────────────────────────────────────────────────────────────────────
// Pure helpers — extracted for unit testing
// ────────────────────────────────────────────────────────────────────────

interface BuildGoogleCredentialsArgs {
  tokens: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  clientId: string;
  accountEmail: string;
  /** Joined-with-spaces scope to fall back to if Google omits scope. */
  fallbackScope: string;
  /** Test seam — defaults to Date.now(). */
  now?: () => number;
}

interface GoogleAddAccountCredentialsLike {
  googleOauth: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scope: string;
    clientId: string;
    accountEmail: string;
    tokenType: "Bearer";
  };
}

/**
 * Construct the GoogleAddAccountCredentials payload the auth-broker
 * expects from a Google token-exchange response. Pure — easy to unit
 * test and reason about. Refuses tokens missing refresh_token (Google
 * only returns it on first consent or `prompt=consent` re-consent).
 */
export function buildGoogleCredentials(
  args: BuildGoogleCredentialsArgs,
): GoogleAddAccountCredentialsLike {
  const { tokens, clientId, accountEmail, fallbackScope, now } = args;
  if (!tokens.refresh_token) {
    throw new Error(
      "Google token-exchange did not return a refresh_token — re-consent required.",
    );
  }
  const epochMs = (now ?? Date.now)();
  return {
    googleOauth: {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: epochMs + tokens.expires_in * 1000,
      scope: tokens.scope ?? fallbackScope,
      clientId,
      accountEmail,
      tokenType: "Bearer",
    },
  };
}

// Re-export for tests.
export const _testing = {
  validateAndNormalizeAccountEmail,
  getEnabledAgentsBefore,
  expandAllAgents,
  buildGoogleCredentials,
};

