/**
 * Vault auto-unlock setup — shared logic between the
 * `vault broker enable-auto-unlock` CLI command and the `switchroom setup`
 * wizard.
 *
 * The auto-unlock blob is encrypted with a key derived from /etc/machine-id.
 * The broker decrypts it itself at boot — no sudo, no systemd-creds, no
 * polkit, no TPM groups. See `src/vault/auto-unlock.ts` for the crypto and
 * threat model. This module just glues that crypto to the CLI flow:
 *
 *   1. encryptCredential — write the blob to disk (mode 0600).
 *   2. applyAutoUnlock — flip vault.broker.autoUnlock=true in
 *      switchroom.yaml, reconcile units, restart broker, poll status to
 *      verify the vault came up unlocked.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import YAML from "yaml";

import { findConfigFile, loadConfig, resolvePath } from "../config/loader.js";
import { installAllUnits } from "../agents/systemd.js";
import { statusViaBroker } from "../vault/broker/client.js";
import {
  AutoUnlockDecryptError,
  DEFAULT_AUTO_UNLOCK_PATH,
  MachineIdUnavailableError,
  readMachineId,
  writeAutoUnlockFile,
} from "../vault/auto-unlock.js";

export class EncryptFailedError extends Error {
  constructor(public detail: string) {
    super(detail);
    this.name = "EncryptFailedError";
  }
}

/**
 * Detect whether auto-unlock can be set up on this host. We don't need
 * sudo, polkit, systemd-creds, or any group membership — just a readable
 * machine-id. Returns null on hosts that don't have one.
 */
export function autoUnlockSupported(): { supported: true } | null {
  try {
    readMachineId();
    return { supported: true };
  } catch {
    return null;
  }
}

/**
 * Encrypt the vault passphrase to the configured auto-unlock blob path.
 * Throws EncryptFailedError on machine-id unavailable; the caller is
 * expected to catch and present a clear error.
 *
 * The passphrase is held in this function only as long as it takes to
 * encrypt; we don't keep a reference. (V8 won't let us truly zero a
 * string, but we don't pin it either.)
 */
export function encryptCredential(passphrase: string, credPath: string): void {
  try {
    writeAutoUnlockFile(passphrase, credPath);
  } catch (err) {
    if (err instanceof MachineIdUnavailableError) {
      throw new EncryptFailedError(err.message);
    }
    throw new EncryptFailedError(
      `Failed to write auto-unlock blob to ${credPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Set `vault.broker.autoUnlock: <value>` in the user's switchroom.yaml,
 * preserving comments, key ordering, and surrounding formatting. Mirrors
 * the YAML.parseDocument pattern used by `updateAgentExtendsInConfig` in
 * src/cli/agent.ts.
 */
export function setVaultBrokerAutoUnlock(configPath: string, value: boolean): void {
  const raw = readFileSync(configPath, "utf-8");
  const doc = YAML.parseDocument(raw);
  doc.setIn(["vault", "broker", "autoUnlock"], value);
  writeFileSync(configPath, doc.toString(), "utf-8");
}

export interface ApplyOptions {
  configPath?: string;
  log?: (line: string) => void;
  err?: (line: string) => void;
  /** Override systemctl invocation in tests. */
  runSystemctl?: (args: string[]) => { status: number | null };
  /** Override status polling in tests. */
  pollStatus?: () => Promise<{ unlocked: boolean } | null>;
  /** How long to wait for the broker to come up unlocked. */
  verifyTimeoutMs?: number;
}

/**
 * Flip vault.broker.autoUnlock=true in switchroom.yaml, regenerate units,
 * restart the broker, and poll status to confirm the vault came up
 * unlocked. The whole thing is one call so callers don't have to
 * re-implement the 3-step "Next steps" list.
 */
export async function applyAutoUnlock(opts: ApplyOptions = {}): Promise<void> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const err = opts.err ?? ((s: string) => console.error(s));
  const runSystemctl =
    opts.runSystemctl ?? ((args: string[]) => spawnSync("systemctl", args, { stdio: "inherit" }));
  // 10s default — generous enough for cold-cache decrypt on slow boxes,
  // short enough that a real auto-unlock failure surfaces before the user
  // gives up.
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? 10000;

  const configPath = opts.configPath ?? findConfigFile();
  setVaultBrokerAutoUnlock(configPath, true);
  log(`✓ Set vault.broker.autoUnlock=true in ${configPath}`);

  // Reload the config from disk so installAllUnits sees the freshly-flipped
  // value (broker unit content depends on it indirectly via downstream
  // consumers; today the unit shape is identical, but reloading keeps the
  // call site honest if that ever changes).
  const config = loadConfig(configPath);
  installAllUnits(config);
  log("✓ Reconciled broker unit");

  runSystemctl(["--user", "daemon-reload"]);
  const restart = runSystemctl(["--user", "restart", "switchroom-vault-broker.service"]);
  if (restart.status !== 0) {
    err(
      "Broker restart failed. Check:\n" +
        "  systemctl --user status switchroom-vault-broker.service\n" +
        "  journalctl --user -u switchroom-vault-broker.service -e",
    );
    throw new Error(`broker restart exited ${restart.status}`);
  }
  log("✓ Restarted switchroom-vault-broker.service");

  const socket = resolvePath(config.vault?.broker?.socket ?? "~/.switchroom/vault-broker.sock");
  const poll = opts.pollStatus ?? (() => statusViaBroker({ socket }));

  const deadline = Date.now() + verifyTimeoutMs;
  while (Date.now() < deadline) {
    const status = await poll();
    if (status?.unlocked) {
      log("✓ Vault unlocked via auto-unlock blob");
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  err(
    "Broker restarted but vault did not unlock within " +
      `${verifyTimeoutMs}ms. Check:\n` +
      "  systemctl --user status switchroom-vault-broker.service\n" +
      "  journalctl --user -u switchroom-vault-broker.service -e",
  );
  throw new Error("verification timeout: broker did not unlock");
}

/** Re-export the path constant so the broker CLI doesn't have to import twice. */
export { AutoUnlockDecryptError, DEFAULT_AUTO_UNLOCK_PATH };
