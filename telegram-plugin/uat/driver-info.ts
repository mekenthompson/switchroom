/**
 * `bun uat/driver-info.ts` — prints the driver user account's
 * numeric `user_id` to stdout. Used during one-shot `test-harness`
 * agent creation (see uat/SETUP.md §5) to populate `--allow-from`.
 *
 * Issue: https://github.com/switchroom/switchroom/issues/866
 *
 * Reads vault credentials via `switchroom vault get --no-broker`
 * (the operator already has `SWITCHROOM_VAULT_PASSPHRASE` set per
 * the runbook). The session string lives in-process only; never
 * printed.
 */

import { execFileSync } from "node:child_process";
import { Driver } from "./driver.js";

async function main(): Promise<void> {
  const apiIdRaw = vaultGet("telegram-uat-api-id");
  const apiHash = vaultGet("telegram-uat-api-hash");
  const session = vaultGet("telegram-uat-driver-session");

  const apiId = Number.parseInt(apiIdRaw, 10);
  if (!Number.isFinite(apiId)) {
    process.stderr.write(
      `uat/driver-info: invalid TELEGRAM_API_ID in vault (got '${apiIdRaw}')\n`,
    );
    process.exit(1);
  }

  const driver = new Driver({ apiId, apiHash, session });
  try {
    await driver.connect();
    const uid = await driver.getMyUserId();
    process.stdout.write(`${uid}\n`);
  } finally {
    await driver.disconnect().catch(() => undefined);
  }
}

function vaultGet(key: string): string {
  const out = execFileSync(
    "switchroom",
    ["vault", "get", "--no-broker", key],
    { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
  );
  return out.trim();
}

main().catch((err) => {
  // Strip any long base64 blob defensively (same posture as login.ts).
  const sanitized = String(err?.message ?? err).replace(
    /[A-Za-z0-9+/=_-]{64,}/g,
    "<redacted>",
  );
  process.stderr.write(`uat/driver-info failed: ${sanitized}\n`);
  process.exit(1);
});
