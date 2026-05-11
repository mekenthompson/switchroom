/**
 * Load `telegram-plugin/uat/.env` into process.env at harness startup.
 *
 * The UAT harness needs four env vars (TELEGRAM_API_ID, TELEGRAM_API_HASH,
 * TELEGRAM_UAT_DRIVER_SESSION, TELEGRAM_TEST_BOT_USERNAME) that originate
 * in the operator's vault. Re-exporting them every shell session is fiddly,
 * so we let the operator stash them in a gitignored `.env` next to this
 * file. See `SETUP.md` §6 for the refresh workflow.
 *
 * Existing process.env values win — a CI run that supplies vars via the
 * job environment doesn't get clobbered by a stale local `.env`.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UAT_ENV_FILE = path.join(HERE, ".env");

export function loadUatEnv(envPath: string = UAT_ENV_FILE): void {
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
