/**
 * One-time interactive login script for the UAT mtcute driver.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/865
 *
 * Run via `bun run uat:login` from `telegram-plugin/`. Prompts for
 * phone, login code, and 2FA password on stdin. Captures the session
 * string in memory and writes it to vault under
 * `telegram-uat-driver-session`. The session string is **never
 * printed** — not to stdout, not to stderr, not to logs. If you see
 * one in scrollback, file an incident.
 *
 * Required env:
 *   TELEGRAM_API_ID    — from https://my.telegram.org/apps
 *   TELEGRAM_API_HASH  — from https://my.telegram.org/apps
 *
 * Vault write: the script writes the session into a 0600 tmpfile and
 * spawns `switchroom vault set --file <tmpf> --allow test-harness`
 * with inherited stdio. The operator is prompted once for the vault
 * passphrase (the broker-mediated stdin path doesn't support `--allow`
 * scope flags; see `src/cli/vault.ts:331-356` for the rationale). The
 * tmpfile is `shred -u`'d after the spawn returns.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { MemoryStorage, TelegramClient } from "@mtcute/node";

export const VAULT_KEY = "telegram-uat-driver-session";
export const VAULT_SCOPE = "test-harness";

async function main(): Promise<void> {
  const apiId = Number.parseInt(process.env.TELEGRAM_API_ID ?? "", 10);
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  if (!Number.isFinite(apiId) || !apiHash) {
    fail(
      "TELEGRAM_API_ID and TELEGRAM_API_HASH must be set. See uat/SETUP.md §3.",
    );
  }

  const rl = createInterface({ input, output, terminal: true });

  const ack = await rl.question(
    [
      "",
      "About to mint a Telegram USER session string for the UAT driver.",
      "This is bearer-equivalent to the user account. It will be stored",
      "in vault under `" + VAULT_KEY + "` and NEVER printed.",
      "",
      "Type YES to proceed: ",
    ].join("\n"),
  );
  if (ack.trim() !== "YES") {
    fail("Aborted.");
  }

  const phone = (await rl.question("Phone number (E.164, e.g. +14155551234): ")).trim();
  if (!phone.startsWith("+")) fail("Phone must start with '+'.");

  // MemoryStorage so nothing lands on disk in this process. The
  // exported session string is the only durable output; everything
  // else is ephemeral.
  const client = new TelegramClient({
    apiId,
    apiHash,
    storage: new MemoryStorage(),
  });

  await client.start({
    phone: async () => phone,
    code: async () =>
      (await rl.question("Login code (from Telegram app or SMS): ")).trim(),
    password: async () =>
      (await rl.question("2FA password (leave blank if none): ")),
  });

  const session = await client.exportSession();
  await client.destroy();
  rl.close();

  await writeToVault(VAULT_KEY, session);

  process.stdout.write(
    `\nDone. Session stored in vault as \`${VAULT_KEY}\` (scope: allow=${VAULT_SCOPE}).\n` +
      "If you ever see the actual session string in your terminal, file an incident.\n",
  );
}

/**
 * Spawns `switchroom vault set --file <tmpf> --allow test-harness` so
 * the operator passphrase prompt works (broker-mediated stdin writes
 * reject `--allow`/`--deny`). The tmpfile is created 0700-mode dir,
 * 0600 file, and `shred -u`'d after the set returns regardless of
 * outcome.
 *
 * Exported so `tests/uat-login.test.ts` can pin the security-critical
 * invariants (mode 0600, `--allow test-harness`, cleanup on failure)
 * against the real implementation.
 */
export async function writeToVault(key: string, value: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "uat-session-"));
  const path = join(dir, "session");
  try {
    await writeFile(path, value, { mode: 0o600 });
    await runInherit("switchroom", [
      "vault",
      "set",
      key,
      "--file",
      path,
      "--format",
      "string",
      "--allow",
      VAULT_SCOPE,
    ]);
  } finally {
    // Best-effort secure delete. `shred -u` first (overwrites then
    // unlinks); fall back to plain rm if shred is missing.
    await runQuiet("shred", ["-u", path]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function runInherit(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "inherit" });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args[0] ?? ""} exited ${code}`));
    });
  });
}

function runQuiet(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: "ignore" });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}`));
    });
  });
}

function fail(msg: string): never {
  process.stderr.write(`uat:login: ${msg}\n`);
  process.exit(1);
}

// Only run the interactive flow when invoked directly (`bun run
// uat:login`). Tests that `import` this module for `writeToVault`
// otherwise trigger the prompt-for-phone-number flow on every load.
const invokedDirectly =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    // Defensive: if mtcute throws, the error MAY contain the session
    // string in some adapters. Strip anything that looks like a long
    // base64 blob before printing.
    const sanitized = String(err?.message ?? err).replace(
      /[A-Za-z0-9+/=_-]{64,}/g,
      "<redacted>",
    );
    process.stderr.write(`uat:login failed: ${sanitized}\n`);
    process.exit(1);
  });
}
