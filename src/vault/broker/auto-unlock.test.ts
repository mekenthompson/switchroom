/**
 * Unit tests for the _tryAutoUnlockFromCredentials path inside VaultBroker.
 *
 * The method is private, so we exercise it indirectly: start a real broker
 * with an actual vault file on disk, set/unset CREDENTIALS_DIRECTORY, and
 * assert the broker's unlocked state via getStatus().
 *
 * Four paths covered:
 *   1. CREDENTIALS_DIRECTORY unset → no-op, broker stays locked
 *   2. CREDENTIALS_DIRECTORY set + valid passphrase file → broker unlocks
 *   3. CREDENTIALS_DIRECTORY set + missing file → broker stays locked + alive
 *   4. CREDENTIALS_DIRECTORY set + corrupt passphrase → broker stays locked + alive
 *
 * This file transitively imports bun:sqlite (via VaultBroker → grants-db.ts).
 * It is excluded from vitest and run via `bun test` (see vitest.config.ts and
 * the test:bun script in package.json).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { VaultBroker } from "./server.js";
import { createVault } from "../vault.js";
import { migrateGrantsSchema } from "../grants.js";

const FIXTURE_PASSPHRASE = "correct-horse-battery-staple";

/**
 * Create an in-memory SQLite grants DB ready for use as _testGrantsDb.
 * Keeps tests hermetic — no writes to ~/.switchroom/vault-grants.db.
 */
function makeInMemoryGrantsDb(): Database {
  const db = new Database(":memory:");
  migrateGrantsSchema(db);
  return db;
}

function makeMinimalConfig(vaultPath: string) {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: vaultPath,
      broker: {
        socket: "~/.switchroom/vault-broker.sock",
        enabled: true,
      },
    },
    agents: {},
  } as any;
}

/**
 * Start a fresh broker against a real vault file.
 * Returns { broker, socketPath }.
 * Caller owns cleanup (broker.stop() + fs.rmSync(tmpDir)).
 */
async function startBroker(
  tmpDir: string,
  vaultPath: string,
  suffix = "",
): Promise<{ broker: VaultBroker; socketPath: string }> {
  const socketPath = path.join(tmpDir, `test${suffix}.sock`);
  const broker = new VaultBroker({
    _testConfig: makeMinimalConfig(vaultPath),
    _testGrantsDb: makeInMemoryGrantsDb(),
  });
  // SWITCHROOM_BROKER_ALLOW_NON_LINUX=1 so start() doesn't throw on non-Linux CI
  const prev = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
  process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
  try {
    await broker.start(socketPath, undefined, vaultPath);
  } finally {
    if (prev === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prev;
    }
  }
  return { broker, socketPath };
}

describe("_tryAutoUnlockFromCredentials", () => {
  let tmpDir: string;
  let credsDir: string;
  let vaultPath: string;
  let broker: VaultBroker | null = null;

  // Save/restore env vars touched across tests
  let prevCredsDir: string | undefined;
  let prevNonLinux: string | undefined;
  let prevAutoUnlockPath: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-unlock-test-"));
    credsDir = path.join(tmpDir, "creds");
    vaultPath = path.join(tmpDir, "vault.enc");
    fs.mkdirSync(credsDir, { recursive: true });

    // Create a fixture vault encrypted with FIXTURE_PASSPHRASE
    createVault(FIXTURE_PASSPHRASE, vaultPath);

    prevCredsDir = process.env.CREDENTIALS_DIRECTORY;
    prevNonLinux = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    prevAutoUnlockPath = process.env.SWITCHROOM_VAULT_BROKER_AUTO_UNLOCK_PATH;
    // Silence stderr noise from auto-unlock log lines
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";
    // Pin the machine-bound auto-unlock path inside the test's tmpDir so
    // the broker's `_tryAutoUnlockFromMachineBoundFile()` short-circuits
    // (file doesn't exist) and falls through to the systemd-credentials
    // path that this suite is actually exercising. Without this, on an
    // operator's machine where `~/.switchroom/vault-auto-unlock` IS
    // present, the broker reads the OPERATOR'S real blob, decrypts it
    // with the host's machine-id, applies the operator's real
    // passphrase to the test's fixture vault, and fails with a
    // misleading "vault rejected the passphrase" — case 2 was hard-red
    // on every developer machine running this suite for that reason.
    process.env.SWITCHROOM_VAULT_BROKER_AUTO_UNLOCK_PATH = path.join(
      tmpDir,
      "vault-auto-unlock-nonexistent",
    );
  });

  afterEach(() => {
    broker?.stop();
    broker = null;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    if (prevCredsDir === undefined) {
      delete process.env.CREDENTIALS_DIRECTORY;
    } else {
      process.env.CREDENTIALS_DIRECTORY = prevCredsDir;
    }
    if (prevNonLinux === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinux;
    }
    if (prevAutoUnlockPath === undefined) {
      delete process.env.SWITCHROOM_VAULT_BROKER_AUTO_UNLOCK_PATH;
    } else {
      process.env.SWITCHROOM_VAULT_BROKER_AUTO_UNLOCK_PATH = prevAutoUnlockPath;
    }
  });

  it("case 1: CREDENTIALS_DIRECTORY unset → broker stays locked", async () => {
    delete process.env.CREDENTIALS_DIRECTORY;

    const { broker: b, socketPath } = await startBroker(tmpDir, vaultPath, "-1");
    broker = b;

    const status = broker.getStatus();
    expect(status.unlocked).toBe(false);
  });

  it("case 2: CREDENTIALS_DIRECTORY set + valid passphrase file → broker unlocks", async () => {
    const credFile = path.join(credsDir, "vault-passphrase");
    fs.writeFileSync(credFile, FIXTURE_PASSPHRASE + "\n", { mode: 0o600 });
    process.env.CREDENTIALS_DIRECTORY = credsDir;

    const { broker: b } = await startBroker(tmpDir, vaultPath, "-2");
    broker = b;

    const status = broker.getStatus();
    expect(status.unlocked).toBe(true);
  });

  it("case 3: CREDENTIALS_DIRECTORY set + missing file → broker stays locked + alive", async () => {
    // credsDir exists but vault-passphrase file does NOT exist
    process.env.CREDENTIALS_DIRECTORY = credsDir;

    const { broker: b } = await startBroker(tmpDir, vaultPath, "-3");
    broker = b;

    const status = broker.getStatus();
    expect(status.unlocked).toBe(false);
    // Broker is alive: status RPC works
    expect(status.uptimeSec).toBeGreaterThanOrEqual(0);
  });

  it("case 4: CREDENTIALS_DIRECTORY set + corrupt passphrase → broker stays locked + alive (does not throw)", async () => {
    const credFile = path.join(credsDir, "vault-passphrase");
    fs.writeFileSync(credFile, "wrong-passphrase-totally-invalid\n", { mode: 0o600 });
    process.env.CREDENTIALS_DIRECTORY = credsDir;

    // start() must complete without throwing even when unlockFromPassphrase fails
    let startError: unknown = null;
    try {
      const result = await startBroker(tmpDir, vaultPath, "-4");
      broker = result.broker;
    } catch (err) {
      startError = err;
    }

    expect(startError).toBeNull();
    expect(broker).not.toBeNull();

    const status = broker!.getStatus();
    expect(status.unlocked).toBe(false);
    expect(status.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});
