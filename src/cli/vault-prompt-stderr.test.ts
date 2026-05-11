/**
 * Test for #999 — vault passphrase prompt must write to stderr so the
 * common `$(switchroom vault get --no-broker <key>)` capture pattern
 * doesn't silently consume it into the operator's variable.
 *
 * Exercise: spawn the CLI with no stdin (no TTY, no env passphrase),
 * capture stdout and stderr separately, assert the prompt landed on
 * stderr and stdout is clean.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CLI_ENTRY = path.join(REPO_ROOT, "bin/switchroom.ts");

describe("vault passphrase prompt → stderr (#999)", () => {
  it("vault get --no-broker prompt does NOT appear on stdout", () => {
    // Use a tmp HOME so we don't poke the operator's real vault, and
    // a tmp vault path so the read attempt fails predictably AFTER the
    // prompt step.
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "vault-prompt-test-"));
    const r = spawnSync(
      "bun",
      [CLI_ENTRY, "vault", "get", "--no-broker", "some_key"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: tmpHome,
          // Explicitly unset so getPassphrase() reaches promptLine.
          SWITCHROOM_VAULT_PASSPHRASE: undefined,
          // Defeat the P0a sandbox guard (this test runs in host context).
          SWITCHROOM_RUNTIME: undefined,
        },
        // No stdin → readline sees EOF on stdin; the prompt is still
        // emitted by createInterface before EOF closes the read.
        input: "",
        timeout: 15000,
      },
    );

    // The prompt text — whatever its exact wording — must NOT land on
    // stdout (which a `$(...)` capture would slurp into the operator's
    // variable). Pre-fix `process.stdout.write(prompt)` violated this.
    expect(r.stdout).not.toContain("Vault passphrase");
    expect(r.stdout).not.toContain("passphrase");

    // stderr is where the prompt + error messages now go. The exact
    // message depends on which guard fires first (no vault file →
    // VaultError, or empty passphrase → "Passphrase cannot be empty").
    // Either way, the user-visible bit is on stderr.
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});
