/**
 * Tests for `resolveBrokerSocketPath` — the canonical broker socket
 * resolver shared by every broker client (CLI, secret-guard hook,
 * boot-card probeBroker).
 *
 * The resolver's precedence order is documented at the top of
 * `client.ts` and load-bearing for the multi-container deploy:
 *
 *   1. opts.socket      — explicit caller override
 *   2. SWITCHROOM_VAULT_BROKER_SOCK env — set by compose into agents
 *   3. opts.vaultBrokerSocket — config-derived path
 *   4. ~/.switchroom/vault-broker.sock — legacy default
 *
 * Pre-fix the CLI (`src/cli/vault.ts`, `vault-broker.ts`,
 * `vault-doctor.ts`, `vault-grant.ts`, `vault-auto-unlock.ts`) all
 * skipped step 2 entirely and went straight from caller-override to
 * config-or-legacy. Inside agent containers — where the env is set
 * but the legacy path is a dangling symlink (#910) — that meant the
 * CLI saw "broker not running" even when the broker was reachable
 * via the canonical env path. The 2026-05-10 incident: clerk's
 * calendar skill failing every `switchroom vault get` while the
 * broker WAS reachable on `/run/switchroom/broker/sock` per the env
 * var.
 *
 * These tests pin the precedence so a future refactor that drops the
 * env step (or reorders it) breaks the test rather than the agent
 * fleet.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveBrokerSocketPath } from "./client.js";

const ENV_KEY = "SWITCHROOM_VAULT_BROKER_SOCK";
const LEGACY_DEFAULT = join(homedir(), ".switchroom", "vault-broker.sock");

describe("resolveBrokerSocketPath", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it("opts.socket wins over everything else", () => {
    process.env[ENV_KEY] = "/from-env";
    const result = resolveBrokerSocketPath({
      socket: "/from-opts",
      vaultBrokerSocket: "/from-config",
    });
    expect(result).toBe("/from-opts");
  });

  it("env wins over config and legacy default (the regression fix)", () => {
    // The 2026-05-10 incident's root cause was every CLI helper
    // skipping this step. Pin it.
    process.env[ENV_KEY] = "/run/switchroom/broker/sock";
    const result = resolveBrokerSocketPath({
      vaultBrokerSocket: "/from-config",
    });
    expect(result).toBe("/run/switchroom/broker/sock");
  });

  it("config wins over the legacy default when env is unset", () => {
    const result = resolveBrokerSocketPath({
      vaultBrokerSocket: "/from-config",
    });
    expect(result).toBe("/from-config");
  });

  it("falls back to ~/.switchroom/vault-broker.sock when nothing else is set", () => {
    const result = resolveBrokerSocketPath();
    expect(result).toBe(LEGACY_DEFAULT);
  });

  it("treats empty SWITCHROOM_VAULT_BROKER_SOCK env as unset", () => {
    process.env[ENV_KEY] = "";
    const result = resolveBrokerSocketPath({ vaultBrokerSocket: "/from-config" });
    expect(result).toBe("/from-config");
  });

  it("undefined opts works (zero-arg call from CLI helpers)", () => {
    process.env[ENV_KEY] = "/from-env";
    const result = resolveBrokerSocketPath();
    expect(result).toBe("/from-env");
  });
});
