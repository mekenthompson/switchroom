/**
 * Tests for the SWITCHROOM_VAULT_PASSPHRASE deprecation warning (#969 P3).
 *
 * The env var path is still honoured (backwards compatibility AND the
 * canonical gateway-passphrase-attestation flow from P1a). The deprecation
 * warning targets the anti-pattern where a SKILL bakes the master
 * passphrase into the agent's environment.
 *
 * The hook fires on every `switchroom vault <subcommand>` invocation
 * BEFORE the subcommand runs — via commander's `preAction` lifecycle
 * hook on the parent `vault` command. The check runs once per process
 * (in case a long-running gateway invocation re-enters), and only when
 * SWITCHROOM_RUNTIME=docker (sandbox context).
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI_ENTRY = path.join(REPO_ROOT, "bin/switchroom.ts");

function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("bun", [CLI_ENTRY, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), "vault-deprecate-test-")),
      ...env,
    },
    timeout: 15000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

describe("SWITCHROOM_VAULT_PASSPHRASE deprecation (#969 P3)", () => {
  it("emits VAULT-DEPRECATION-WARNING when env var is set inside sandbox", () => {
    const r = runCli(["vault", "list"], {
      SWITCHROOM_RUNTIME: "docker",
      SWITCHROOM_VAULT_PASSPHRASE: "anything",
      SWITCHROOM_VAULT_BROKER_SOCK: "/tmp/not-a-real-socket-for-deprecation-test",
    });
    expect(r.stderr).toContain("VAULT-DEPRECATION-WARNING");
    // The warning's nudge to migrate must include both the docs pointer
    // and the canonical mint command — operators reading the warning
    // should be able to act on it immediately.
    expect(r.stderr).toContain("docs/vault-security.md");
    expect(r.stderr).toContain("switchroom vault grant");
  });

  it("does NOT warn on host context (no SWITCHROOM_RUNTIME)", () => {
    const r = runCli(["vault", "list"], {
      SWITCHROOM_RUNTIME: undefined,
      SWITCHROOM_VAULT_PASSPHRASE: "anything",
    });
    expect(r.stderr).not.toContain("VAULT-DEPRECATION-WARNING");
  });

  it("does NOT warn when env var is absent", () => {
    const r = runCli(["vault", "list"], {
      SWITCHROOM_RUNTIME: "docker",
      SWITCHROOM_VAULT_PASSPHRASE: undefined,
      SWITCHROOM_VAULT_BROKER_SOCK: "/tmp/not-a-real-socket-for-deprecation-test",
    });
    expect(r.stderr).not.toContain("VAULT-DEPRECATION-WARNING");
  });

  it("respects SWITCHROOM_NO_VAULT_DEPRECATION_WARNING=1 escape hatch", () => {
    const r = runCli(["vault", "list"], {
      SWITCHROOM_RUNTIME: "docker",
      SWITCHROOM_VAULT_PASSPHRASE: "anything",
      SWITCHROOM_NO_VAULT_DEPRECATION_WARNING: "1",
      SWITCHROOM_VAULT_BROKER_SOCK: "/tmp/not-a-real-socket-for-deprecation-test",
    });
    expect(r.stderr).not.toContain("VAULT-DEPRECATION-WARNING");
  });
});
