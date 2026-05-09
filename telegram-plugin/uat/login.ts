/**
 * One-time interactive login script for the UAT mtcute driver.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/865
 *
 * Run via `bun run uat:login` from telegram-plugin/. Prompts for
 * phone, login code, and (optionally) 2FA password on stdin. Captures
 * the session string in memory and writes it to vault under
 * `telegram-uat-driver-session`. The session string is **never
 * printed** — not to stdout, not to stderr, not to logs. If you see
 * one in scrollback, file an incident.
 *
 * Required env:
 *   TELEGRAM_API_ID    — from https://my.telegram.org/apps
 *   TELEGRAM_API_HASH  — from https://my.telegram.org/apps
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "@mtcute/node";

const VAULT_KEY = "telegram-uat-driver-session";

async function main(): Promise<void> {
  const apiId = Number.parseInt(process.env.TELEGRAM_API_ID ?? "", 10);
  const apiHash = process.env.TELEGRAM_API_HASH ?? "";
  if (!Number.isFinite(apiId) || !apiHash) {
    fail(
      "TELEGRAM_API_ID and TELEGRAM_API_HASH must be set. See uat/SETUP.md §3.",
    );
  }

  const rl = createInterface({ input, output, terminal: true });

  // Confirm the operator understands the security posture before we
  // mint a bearer-equivalent credential.
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

  const client = new TelegramClient({ apiId, apiHash });

  // mtcute exposes a `start()` flow that takes async callbacks for
  // each interactive step. Exact callback names may shift across
  // versions — verify against the pinned mtcute version before first
  // run.
  await client.start({
    phone: async () => phone,
    code: async () =>
      (await rl.question("Login code (from Telegram app or SMS): ")).trim(),
    password: async () =>
      (await rl.question("2FA password (leave blank if none): ")),
  });

  // TODO(#865): mtcute v0.27 exports sessions via the
  // `@mtcute/core/utils.js` `StringSessionStorage` adapter; the
  // exact call is `await client.exportSession()` only when that
  // storage is configured, otherwise sessions live in the SQLite
  // file at `client.session`. Phase 2 wires the string-session
  // storage so this script can mint a string. For now we throw
  // before producing a value so the operator never gets a half-
  // baked session in vault.
  const session: string = await Promise.reject(
    new Error(
      "uat:login: Phase 1 stub — Phase 2 wires StringSessionStorage. See uat/SETUP.md §3.",
    ),
  );

  await client.destroy();
  rl.close();

  // Write to vault via the switchroom CLI's stdin path so the
  // session never appears in argv (which would land in `ps` output).
  await writeToVault(VAULT_KEY, session);

  // Belt-and-suspenders: zero out the local copy.
  scrub(session);

  process.stdout.write(
    `\nDone. Session stored in vault as \`${VAULT_KEY}\`.\n` +
      "If you ever see the actual session string in your terminal, file an incident.\n",
  );
}

function writeToVault(key: string, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("switchroom", ["vault", "set", key], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`switchroom vault set exited ${code}`));
    });
    proc.stdin.end(value + "\n");
  });
}

function scrub(_s: string): void {
  // JS strings are immutable — best we can do is drop the reference
  // and trust the GC. Documented here so a future hardening pass
  // (e.g. SecureBuffer) has a hook.
}

function fail(msg: string): never {
  process.stderr.write(`uat:login: ${msg}\n`);
  process.exit(1);
}

main().catch((err) => {
  // Defensive: if mtcute throws, the error MAY contain the session
  // string in some adapters. Strip anything that looks like a base64
  // blob > 64 chars before printing.
  const sanitized = String(err?.message ?? err).replace(
    /[A-Za-z0-9+/=_-]{64,}/g,
    "<redacted>",
  );
  process.stderr.write(`uat:login failed: ${sanitized}\n`);
  process.exit(1);
});
