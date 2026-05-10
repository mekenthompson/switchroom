/**
 * Sandbox-context guard tests for `switchroom vault` (issue #968 / #969 P0a).
 *
 * Inside an agent container `vault.enc` is not mounted — only the broker
 * socket is. Before this guard, every vault verb that fell through to
 * direct file IO surfaced the misleading "Vault file not found:
 * /state/agent/home/.switchroom/vault.enc" error. The guard refuses
 * early with a `VAULT-SANDBOX-CONTEXT` / `VAULT-NEEDS-APPROVAL` /
 * `VAULT-BROKER-UNREACHABLE` marker the Telegram gateway can route to
 * the right UX.
 *
 * These tests exercise the CLI as a subprocess with `SWITCHROOM_RUNTIME=docker`
 * set in the env to simulate sandbox context.
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
  opts: { stdin?: string; env?: Record<string, string | undefined> } = {},
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("bun", [CLI_ENTRY, ...args], {
    input: opts.stdin,
    encoding: "utf8",
    env: {
      ...process.env,
      // Avoid clobbering the operator's real vault by pointing
      // HOME at a tmp dir so `~/.switchroom/...` resolves elsewhere.
      HOME: fs.mkdtempSync(path.join(os.tmpdir(), "vault-sandbox-test-")),
      ...opts.env,
    },
    timeout: 15000,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

describe("vault sandbox guard", () => {
  describe("when SWITCHROOM_RUNTIME=docker", () => {
    it("init refuses with VAULT-SANDBOX-CONTEXT and exit code 7", () => {
      const r = runCli(["vault", "init"], {
        env: { SWITCHROOM_RUNTIME: "docker", SWITCHROOM_VAULT_PASSPHRASE: "x" },
      });
      expect(r.stderr).toContain("VAULT-SANDBOX-CONTEXT");
      expect(r.status).toBe(7);
    });

    it("remove refuses with VAULT-SANDBOX-CONTEXT and exit code 7", () => {
      const r = runCli(["vault", "remove", "some_key"], {
        env: { SWITCHROOM_RUNTIME: "docker", SWITCHROOM_VAULT_PASSPHRASE: "x" },
      });
      expect(r.stderr).toContain("VAULT-SANDBOX-CONTEXT");
      expect(r.status).toBe(7);
    });

    it("get --no-broker refuses with VAULT-SANDBOX-CONTEXT and exit code 7", () => {
      // --no-broker forces the direct-decrypt fall-through; the guard
      // must catch it before it tries to open vault.enc.
      const r = runCli(["vault", "get", "--no-broker", "some_key"], {
        env: { SWITCHROOM_RUNTIME: "docker", SWITCHROOM_VAULT_PASSPHRASE: "x" },
      });
      expect(r.stderr).toContain("VAULT-SANDBOX-CONTEXT");
      expect(r.status).toBe(7);
    });

    it("set --file refuses with VAULT-SANDBOX-CONTEXT and exit code 7", () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vault-sandbox-test-"));
      const filePath = path.join(tmp, "secret.txt");
      fs.writeFileSync(filePath, "hunter2");
      const r = runCli(["vault", "set", "some_key", "--file", filePath], {
        env: { SWITCHROOM_RUNTIME: "docker", SWITCHROOM_VAULT_PASSPHRASE: "x" },
      });
      expect(r.stderr).toContain("VAULT-SANDBOX-CONTEXT");
      expect(r.status).toBe(7);
    });

    it("set --allow refuses with VAULT-SANDBOX-CONTEXT and exit code 7", () => {
      const r = runCli(["vault", "set", "some_key", "--allow", "clerk"], {
        stdin: "v",
        env: { SWITCHROOM_RUNTIME: "docker", SWITCHROOM_VAULT_PASSPHRASE: "x" },
      });
      expect(r.stderr).toContain("VAULT-SANDBOX-CONTEXT");
      expect(r.status).toBe(7);
    });

    it("set with piped stdin + no broker reachable returns VAULT-BROKER-UNREACHABLE exit 6", () => {
      // Point broker socket env at a non-existent path so the broker
      // call returns `unreachable`. The sandbox path must surface the
      // dedicated marker rather than falling through to file IO.
      //
      // Note: this also tests that the env-passphrase (which the
      // Telegram gateway sets) NO LONGER short-circuits past the
      // broker-put path in sandbox context (issue #968 root cause).
      const r = runCli(["vault", "set", "new_key"], {
        stdin: "some-value",
        env: {
          SWITCHROOM_RUNTIME: "docker",
          SWITCHROOM_VAULT_PASSPHRASE: "x",
          SWITCHROOM_VAULT_BROKER_SOCK: "/tmp/definitely-not-a-real-socket-9696",
        },
      });
      expect(r.stderr).toContain("VAULT-BROKER-UNREACHABLE");
      expect(r.stderr).not.toContain("Vault file not found");
      expect(r.status).toBe(6);
    });
  });

  describe("when SWITCHROOM_RUNTIME is unset (host context)", () => {
    it("init does NOT trigger the sandbox guard (would prompt for passphrase)", () => {
      // We don't want to actually create a vault — just confirm the
      // sandbox guard is not the failure mode. With no passphrase env
      // and no TTY, init will fail at the passphrase prompt; whatever
      // it returns must not be the sandbox marker.
      const r = runCli(["vault", "init"], { env: { SWITCHROOM_RUNTIME: undefined } });
      expect(r.stderr).not.toContain("VAULT-SANDBOX-CONTEXT");
    });
  });
});
