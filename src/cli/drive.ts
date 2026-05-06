/**
 * `switchroom drive connect <agent>` and `switchroom drive disconnect <agent>`.
 *
 * Composes the modules built in RFC C (oauth, vault-slots, onboarding,
 * disconnect) with the kernel-side `waitForApproval` helper from RFC B
 * follow-up so the operator gets a Telegram approval card after a successful
 * Google OAuth and the CLI blocks until they tap.
 *
 * Sourcing of inputs that aren't covered by the existing config schema:
 *   - Google OAuth client id/secret: env vars
 *       SWITCHROOM_GOOGLE_CLIENT_ID, SWITCHROOM_GOOGLE_CLIENT_SECRET.
 *   - Approver user id (Telegram numeric id, prefixed `user:` per the kernel
 *     canonicalization convention used elsewhere): env var
 *       SWITCHROOM_APPROVER_USER_ID
 *     (or pass `--approver` on the command).
 *
 * These deliberately avoid a schema change — the drive CLI ships before the
 * config-side wiring is settled. A follow-up will likely move both into
 * switchroom.yaml under a `drive:` block.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "node:readline";
import { loadConfig, resolvePath } from "../config/loader.js";
import {
  detectHeadless,
  selectInitialTier,
  nextTier,
  requestDeviceCode,
  pollDeviceToken,
  buildOobAuthUrl,
  exchangeOobCode,
  OAuthTierRejected,
  type OAuthClientConfig,
  type OAuthTier,
  type TokenResponse,
} from "../drive/oauth.js";
import {
  writeRefreshToken,
  writeStatus,
  deleteSlots,
} from "../drive/vault-slots.js";
import { buildOnboardingCard } from "../drive/onboarding.js";
import { disconnectDrive } from "../drive/disconnect.js";
import {
  waitForApproval,
  type WaitForApprovalResult,
} from "../vault/approvals/wait.js";

// ── Exit codes (documented in command help) ──────────────────────────────────
//   0 = success
//   1 = denied / general error
//   2 = approval timed out
//   3 = rate limited by broker
//   4 = broker / kernel error
// 130 = aborted (SIGINT)
const EXIT_OK = 0;
const EXIT_DENIED = 1;
const EXIT_TIMEOUT = 2;
const EXIT_RATE_LIMITED = 3;
const EXIT_ERROR = 4;
const EXIT_ABORTED = 130;

// Default Drive read-only scopes used by the wrapper. Keep in sync with
// onboarding's "Allow my Drive (read-only)" copy.
const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
];

export interface DriveCliDeps {
  /** Test seam: substitute the OAuth flow runner. */
  runOAuth?: (
    cfg: OAuthClientConfig,
    tier: OAuthTier,
    env: Record<string, string | undefined>,
  ) => Promise<TokenResponse>;
  /** Test seam: substitute the kernel wait helper. */
  waitForApproval?: typeof waitForApproval;
  /** Test seam: substitute the disconnect helper. */
  disconnectDrive?: typeof disconnectDrive;
  /** Test seam: substitute vault-slot writers. */
  writeRefreshToken?: typeof writeRefreshToken;
  writeStatus?: typeof writeStatus;
  deleteSlots?: typeof deleteSlots;
  /** Test seam: capture exits without killing the process. */
  exit?: (code: number) => void;
  /** Test seam: capture stdout. */
  log?: (...args: unknown[]) => void;
  /** Test seam: capture stderr. */
  err?: (...args: unknown[]) => void;
  /** Test seam: passphrase resolver (skips the TTY prompt). */
  getPassphrase?: () => Promise<string>;
  /** Test seam: AbortSignal wired in for SIGINT. */
  abortSignal?: AbortSignal;
}

function getVaultPath(configPath?: string): string {
  try {
    const config = loadConfig(configPath);
    return resolvePath(config.vault?.path ?? "~/.switchroom/vault.enc");
  } catch {
    return resolvePath("~/.switchroom/vault.enc");
  }
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
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
        } else if (char === "\u0003") {
          stdin.setRawMode(false);
          stdin.removeListener("data", onData);
          rl.close();
          process.stdout.write("\n");
          reject(new Error("Aborted"));
        } else if (char === "\u007F" || char === "\b") {
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

function promptLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function defaultGetPassphrase(): Promise<string> {
  const env = process.env.SWITCHROOM_VAULT_PASSPHRASE;
  if (env) return env;
  const v = await promptHidden("Vault passphrase: ");
  if (!v) throw new Error("Passphrase cannot be empty");
  return v;
}

/**
 * Run the OAuth tier chain (device-code → OOB-paste). Loopback is a future
 * extension; today we surface a helpful error if the headless detection
 * ruled out the only remaining tier.
 */
async function defaultRunOAuth(
  cfg: OAuthClientConfig,
  tier: OAuthTier,
  env: Record<string, string | undefined>,
): Promise<TokenResponse> {
  let current: OAuthTier | null = tier;
  while (current !== null) {
    try {
      if (current === "device_code") {
        const dc = await requestDeviceCode(cfg);
        console.log();
        console.log(chalk.bold("To authorize this agent, open:"));
        console.log("  " + chalk.cyan(dc.verification_url));
        console.log("And enter the code:");
        console.log("  " + chalk.bold.green(dc.user_code));
        console.log();
        console.log(chalk.dim("Waiting for you to approve..."));
        const tok = await pollDeviceToken(cfg, dc);
        return tok;
      }
      if (current === "oob_paste") {
        const url = buildOobAuthUrl(cfg);
        console.log();
        console.log(chalk.bold("Open this URL in any browser:"));
        console.log("  " + chalk.cyan(url));
        console.log();
        const code = (
          await promptLine("Paste the authorization code Google shows you: ")
        ).trim();
        if (!code) throw new Error("Auth code cannot be empty");
        return await exchangeOobCode(cfg, code);
      }
      // desktop_loopback: out of scope for this CLI cut.
      throw new Error(
        "Desktop loopback OAuth is not yet implemented. Re-run on a host " +
          "where device-code or OOB-paste works.",
      );
    } catch (e) {
      if (e instanceof OAuthTierRejected) {
        console.log(
          chalk.yellow(
            `OAuth tier '${current}' rejected by Google; falling through.`,
          ),
        );
        current = nextTier(current, env);
        continue;
      }
      throw e;
    }
  }
  throw new Error("All OAuth tiers exhausted with no path forward.");
}

interface ConnectArgs {
  agentName: string;
  approver?: string;
}

async function runConnect(args: ConnectArgs, deps: DriveCliDeps): Promise<void> {
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const log = deps.log ?? ((...a: unknown[]) => console.log(...a));
  const err = deps.err ?? ((...a: unknown[]) => console.error(...a));

  // 1. Validate agent exists.
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    err(chalk.red(`Config error: ${(e as Error).message}`));
    return exit(EXIT_ERROR);
  }
  if (!config.agents[args.agentName]) {
    err(
      chalk.red(
        `Unknown agent '${args.agentName}'. Known agents: ${Object.keys(config.agents).sort().join(", ") || "(none)"}`,
      ),
    );
    return exit(EXIT_ERROR);
  }

  // 2. Resolve OAuth client + approver.
  const clientId = process.env.SWITCHROOM_GOOGLE_CLIENT_ID;
  const clientSecret = process.env.SWITCHROOM_GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    err(
      chalk.red(
        "Error: SWITCHROOM_GOOGLE_CLIENT_ID and SWITCHROOM_GOOGLE_CLIENT_SECRET must be set.",
      ),
    );
    return exit(EXIT_ERROR);
  }
  const approver =
    args.approver ?? process.env.SWITCHROOM_APPROVER_USER_ID ?? "";
  if (!approver) {
    err(
      chalk.red(
        "Error: no approver configured. Pass --approver <user_id> or set " +
          "SWITCHROOM_APPROVER_USER_ID.",
      ),
    );
    return exit(EXIT_ERROR);
  }
  const approverPrincipal = approver.startsWith("user:")
    ? approver
    : `user:${approver}`;

  const oauthCfg: OAuthClientConfig = {
    client_id: clientId,
    client_secret: clientSecret,
    scopes: DEFAULT_SCOPES,
  };

  // 3. Pick OAuth tier and run the flow.
  const env = process.env as Record<string, string | undefined>;
  const tier = selectInitialTier(env);
  log(
    chalk.dim(
      `Host detected as ${detectHeadless(env) ? "headless" : "desktop"}; trying ${tier} first.`,
    ),
  );

  let tokens: TokenResponse;
  try {
    const runner = deps.runOAuth ?? defaultRunOAuth;
    tokens = await runner(oauthCfg, tier, env);
  } catch (e) {
    err(chalk.red(`OAuth failed: ${(e as Error).message}`));
    return exit(EXIT_ERROR);
  }
  if (!tokens.refresh_token) {
    err(
      chalk.red(
        "Google did not return a refresh_token. Re-run with prompt=consent to force one.",
      ),
    );
    return exit(EXIT_ERROR);
  }
  log(chalk.green("OAuth succeeded."));

  // 4. Write refresh token + status to vault.
  const vaultPath = getVaultPath();
  let passphrase: string;
  try {
    passphrase = await (deps.getPassphrase ?? defaultGetPassphrase)();
  } catch (e) {
    err(chalk.red(`Passphrase error: ${(e as Error).message}`));
    return exit(EXIT_ERROR);
  }

  const writeToken = deps.writeRefreshToken ?? writeRefreshToken;
  const writeStat = deps.writeStatus ?? writeStatus;
  const deleter = deps.deleteSlots ?? deleteSlots;

  try {
    writeToken({
      passphrase,
      vaultPath,
      agentUnit: args.agentName,
      refreshToken: tokens.refresh_token,
    });
    writeStat({
      passphrase,
      vaultPath,
      agentUnit: args.agentName,
      status: "connected",
    });
  } catch (e) {
    err(chalk.red(`Vault write failed: ${(e as Error).message}`));
    return exit(EXIT_ERROR);
  }

  // 5. Fire the approval card and block.
  const card = buildOnboardingCard(args.agentName);
  log();
  log(chalk.bold("Waiting for you to approve in Telegram..."));
  log(chalk.dim(`(scope: ${card.scope}, action: ${card.action})`));

  const ac = new AbortController();
  if (deps.abortSignal) {
    if (deps.abortSignal.aborted) ac.abort();
    else deps.abortSignal.addEventListener("abort", () => ac.abort(), { once: true });
  }
  const sigintHandler = () => ac.abort();
  process.once("SIGINT", sigintHandler);

  let result: WaitForApprovalResult;
  try {
    const wait = deps.waitForApproval ?? waitForApproval;
    result = await wait({
      agent_unit: args.agentName,
      scope: card.scope,
      action: card.action,
      approver_set: [approverPrincipal],
      why: card.body,
      signal: ac.signal,
    });
  } catch (e) {
    process.removeListener("SIGINT", sigintHandler);
    err(chalk.red(`Approval wait failed: ${(e as Error).message}`));
    deleter({ passphrase, vaultPath, agentUnit: args.agentName });
    return exit(EXIT_ERROR);
  }
  process.removeListener("SIGINT", sigintHandler);

  // 6. Act on the result.
  switch (result.kind) {
    case "decided":
      if (result.state === "granted") {
        log(chalk.green(`✓ Drive connected for ${args.agentName}.`));
        return exit(EXIT_OK);
      }
      err(
        chalk.yellow(
          `Approval denied. Cleaning up local credentials.`,
        ),
      );
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_DENIED);
    case "timeout":
      err(
        chalk.yellow(
          `Approval timed out. Re-run \`switchroom drive connect ${args.agentName}\` when ready.`,
        ),
      );
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_TIMEOUT);
    case "aborted":
      err(chalk.yellow(`Aborted. Cleaning up local credentials.`));
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_ABORTED);
    case "rate_limited":
      err(
        chalk.yellow(
          `Broker rate-limited the request. Retry in ${result.retry_after_ms}ms.`,
        ),
      );
      // No vault writes survived this branch in spec — but writes happened
      // above. Per RFC, rate_limited fires before request lands; clean up.
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_RATE_LIMITED);
    case "expired":
      err(chalk.yellow(`Approval request expired before decision.`));
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_TIMEOUT);
    case "drift_revoked":
      err(
        chalk.yellow(
          `Approver-set drifted; the request was auto-revoked. Re-run after fixing approver config.`,
        ),
      );
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_ERROR);
    case "error":
      err(chalk.red(`Broker error: ${result.reason}`));
      deleter({ passphrase, vaultPath, agentUnit: args.agentName });
      return exit(EXIT_ERROR);
  }
}

interface DisconnectArgs {
  agentName: string;
}

async function runDisconnect(
  args: DisconnectArgs,
  deps: DriveCliDeps,
): Promise<void> {
  const exit = deps.exit ?? ((c: number) => process.exit(c));
  const log = deps.log ?? ((...a: unknown[]) => console.log(...a));
  const err = deps.err ?? ((...a: unknown[]) => console.error(...a));

  let config;
  try {
    config = loadConfig();
  } catch (e) {
    err(chalk.red(`Config error: ${(e as Error).message}`));
    return exit(EXIT_ERROR);
  }
  if (!config.agents[args.agentName]) {
    err(
      chalk.red(
        `Unknown agent '${args.agentName}'. Known agents: ${Object.keys(config.agents).sort().join(", ") || "(none)"}`,
      ),
    );
    return exit(EXIT_ERROR);
  }

  const vaultPath = getVaultPath();
  let passphrase: string;
  try {
    passphrase = await (deps.getPassphrase ?? defaultGetPassphrase)();
  } catch (e) {
    err(chalk.red(`Passphrase error: ${(e as Error).message}`));
    return exit(EXIT_ERROR);
  }

  const dis = deps.disconnectDrive ?? disconnectDrive;
  let result;
  try {
    result = await dis({
      passphrase,
      vaultPath,
      agentUnit: args.agentName,
    });
  } catch (e) {
    err(chalk.red(`Disconnect failed: ${(e as Error).message}`));
    return exit(EXIT_ERROR);
  }

  const grev =
    result.google_revoke === "ok"
      ? chalk.green("ok")
      : result.google_revoke === "skipped"
        ? chalk.dim("skipped (no token)")
        : chalk.yellow(
            `failed:${result.google_revoke_detail ?? "unknown"} — visit https://myaccount.google.com/permissions to confirm`,
          );

  log(
    `Disconnected gdrive for ${chalk.bold(args.agentName)} ` +
      `(local: ${result.local_revoked ? chalk.green("ok") : chalk.red("failed")}, ` +
      `Google revoke: ${grev})`,
  );
  return exit(EXIT_OK);
}

export function registerDriveCommand(program: Command, deps: DriveCliDeps = {}): void {
  const drive = program
    .command("drive")
    .description("Manage Google Drive OAuth + approval bindings for agents");

  drive
    .command("connect <agent>")
    .description(
      "Run Google OAuth for <agent>, persist refresh token to vault, then " +
        "block on a Telegram approval card. Requires SWITCHROOM_GOOGLE_CLIENT_ID, " +
        "SWITCHROOM_GOOGLE_CLIENT_SECRET, and either --approver or " +
        "SWITCHROOM_APPROVER_USER_ID.",
    )
    .option(
      "--approver <user_id>",
      "Telegram user id (numeric, or `user:<id>`) authorized to approve the onboarding card.",
    )
    .action(async (agent: string, opts: { approver?: string }) => {
      await runConnect({ agentName: agent, approver: opts.approver }, deps);
    });

  drive
    .command("disconnect <agent>")
    .description(
      "Killswitch: delete the local refresh token + status slot for <agent>, " +
        "then best-effort-revoke the token at Google. Always exits 0 on local " +
        "cleanup success even if Google revoke fails.",
    )
    .action(async (agent: string) => {
      await runDisconnect({ agentName: agent }, deps);
    });
}

// Exported for tests.
export const __test = {
  runConnect,
  runDisconnect,
  defaultRunOAuth,
};
