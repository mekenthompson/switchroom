/**
 * Pre-flight checks for `switchroom migrate {to-docker,to-host}`.
 *
 * Each check is a pure async function that takes injected dependencies
 * (so tests can mock without spawning real subprocesses) and returns
 * `{ok: true}` or `{ok: false, reason, fixHint?}`. The composer
 * `runPreflight()` runs them in order and short-circuits on the first
 * refusal.
 *
 * NO docker side-effects here, even on the happy path: `docker ps` is
 * read-only and only invoked through the injected `runCommand` so unit
 * tests can stub it.
 */
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { statusViaBroker } from "../../vault/broker/client.js";
import type { BrokerStatus } from "../../vault/broker/protocol.js";

const execFileP = promisify(execFile);

export type MigrateVerb = "to-docker" | "to-host";

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: string; fixHint?: string };

export type RuntimeMode = "host" | "docker" | null;

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type RunCommand = (
  cmd: string,
  args: readonly string[],
) => Promise<RunCommandResult>;

export const defaultRunCommand: RunCommand = async (cmd, args) => {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
    };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : String(err),
      exitCode: typeof e.code === "number" ? e.code : 1,
    };
  }
};

export interface PreflightDeps {
  runCommand?: RunCommand;
  /** Override `git status` cwd; defaults to process.cwd(). */
  gitCwd?: string;
  /** Probe broker; defaults to {@link statusViaBroker}. */
  probeBroker?: () => Promise<BrokerStatus | null>;
  /** Override the runtime-mode marker path. Defaults to `~/.switchroom/runtime-mode`. */
  runtimeModePath?: string;
}

export interface PreflightOpts {
  sharedHost?: boolean;
}

/* ------------------------------------------------------------------ */
/* Individual checks                                                   */
/* ------------------------------------------------------------------ */

export async function checkGitClean(deps: PreflightDeps = {}): Promise<CheckResult> {
  const run = deps.runCommand ?? defaultRunCommand;
  const cwd = deps.gitCwd ?? process.cwd();
  const r = await run("git", ["-C", cwd, "status", "--porcelain"]);
  if (r.exitCode !== 0) {
    return {
      ok: false,
      reason: `git status failed in ${cwd}: ${r.stderr.trim() || "non-zero exit"}`,
      fixHint: "Run from inside the switchroom checkout and ensure git is installed.",
    };
  }
  if (r.stdout.trim().length > 0) {
    return {
      ok: false,
      reason: `Working tree has uncommitted changes in ${cwd}.`,
      fixHint: "Commit or stash your changes before migrating.",
    };
  }
  return { ok: true };
}

export async function checkVaultUnlocked(deps: PreflightDeps = {}): Promise<CheckResult> {
  const probe = deps.probeBroker ?? (() => statusViaBroker());
  let status: BrokerStatus | null;
  try {
    status = await probe();
  } catch (err) {
    return {
      ok: false,
      reason: `vault-broker probe threw: ${(err as Error).message}`,
      fixHint: "Start the vault-broker (`switchroom vault-broker start`) and unlock the vault.",
    };
  }
  if (status === null) {
    return {
      ok: false,
      reason: "vault-broker is not reachable.",
      fixHint: "Start it with `switchroom vault-broker start` and unlock with `switchroom vault unlock`.",
    };
  }
  if (!status.unlocked) {
    return {
      ok: false,
      reason: "vault-broker is reachable but locked.",
      fixHint: "Unlock with `switchroom vault unlock` (or via the Telegram unlock flow).",
    };
  }
  return { ok: true };
}

export async function checkSystemdHealthy(
  verb: MigrateVerb,
  deps: PreflightDeps = {},
): Promise<CheckResult> {
  if (verb === "to-host") {
    // Going TO systemd; failed units there are expected — don't gate on this.
    return { ok: true };
  }
  const run = deps.runCommand ?? defaultRunCommand;
  const r = await run("systemctl", [
    "--user",
    "list-units",
    "--type=service",
    "--state=failed",
    "--no-legend",
    "--plain",
    "switchroom-*",
  ]);
  // Non-zero from systemctl with no failed units is unexpected but not fatal —
  // treat empty stdout as "no failed units".
  const lines = r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const failed = lines
    .map((l) => l.split(/\s+/, 1)[0])
    .filter((u) => u.startsWith("switchroom-"));
  if (failed.length > 0) {
    return {
      ok: false,
      reason: `Found ${failed.length} failed switchroom-* systemd unit(s): ${failed.join(", ")}.`,
      fixHint:
        "Inspect with `systemctl --user status <unit>` and reset with `systemctl --user reset-failed <unit>` once resolved.",
    };
  }
  return { ok: true };
}

export async function checkSharedHost(
  opts: PreflightOpts,
  deps: PreflightDeps = {},
): Promise<CheckResult> {
  const run = deps.runCommand ?? defaultRunCommand;
  const total = await run("docker", ["ps", "-aq"]);
  if (total.exitCode !== 0) {
    return {
      ok: false,
      reason: `docker ps failed: ${total.stderr.trim() || "non-zero exit"}`,
      fixHint: "Ensure Docker is installed and the daemon is running.",
    };
  }
  const fleet = await run("docker", [
    "ps",
    "-aq",
    "--filter",
    "label=switchroom.fleet=",
  ]);
  if (fleet.exitCode !== 0) {
    return {
      ok: false,
      reason: `docker ps --filter failed: ${fleet.stderr.trim() || "non-zero exit"}`,
    };
  }
  const totalCount = total.stdout.split("\n").filter((s) => s.trim()).length;
  const fleetCount = fleet.stdout.split("\n").filter((s) => s.trim()).length;
  const foreign = totalCount - fleetCount;
  if (foreign > 0 && !opts.sharedHost) {
    return {
      ok: false,
      reason: `Detected ${foreign} foreign container(s) on this Docker daemon (Coolify, hindsight, etc.).`,
      fixHint:
        "Pass --shared-host to acknowledge label-discipline responsibility for the switchroom fleet.",
    };
  }
  return { ok: true };
}

export function readRuntimeMode(path?: string): RuntimeMode {
  const p = path ?? join(homedir(), ".switchroom", "runtime-mode");
  if (!existsSync(p)) return null;
  const v = readFileSync(p, "utf8").trim();
  if (v === "host" || v === "docker") return v;
  return null;
}

export async function checkRuntimeMode(
  verb: MigrateVerb,
  deps: PreflightDeps = {},
): Promise<CheckResult> {
  const mode = readRuntimeMode(deps.runtimeModePath);
  if (verb === "to-docker") {
    if (mode === "docker") {
      return {
        ok: false,
        reason: "Runtime mode is already 'docker' per ~/.switchroom/runtime-mode.",
        fixHint: "Use `switchroom migrate to-host` to revert before re-migrating.",
      };
    }
    return { ok: true };
  }
  // to-host
  if (mode === "host" || mode === null) {
    return {
      ok: false,
      reason:
        mode === null
          ? "Runtime mode marker missing — nothing to roll back."
          : "Runtime mode is already 'host'.",
      fixHint: "to-host only makes sense when the fleet is currently running under Docker.",
    };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Composer                                                            */
/* ------------------------------------------------------------------ */

export interface PreflightResult {
  ok: boolean;
  /** Per-check outcomes, in the order they ran. */
  checks: Array<{ name: string; result: CheckResult }>;
  /** First failing reason, for convenient display. */
  refusal?: { name: string; reason: string; fixHint?: string };
}

export async function runPreflight(
  verb: MigrateVerb,
  opts: PreflightOpts,
  deps: PreflightDeps = {},
): Promise<PreflightResult> {
  const order: Array<{ name: string; run: () => Promise<CheckResult> }> = [
    { name: "git-clean", run: () => checkGitClean(deps) },
    { name: "vault-unlocked", run: () => checkVaultUnlocked(deps) },
    { name: "systemd-healthy", run: () => checkSystemdHealthy(verb, deps) },
    { name: "shared-host", run: () => checkSharedHost(opts, deps) },
    { name: "runtime-mode", run: () => checkRuntimeMode(verb, deps) },
  ];
  const checks: Array<{ name: string; result: CheckResult }> = [];
  for (const c of order) {
    const result = await c.run();
    checks.push({ name: c.name, result });
    if (!result.ok) {
      return {
        ok: false,
        checks,
        refusal: { name: c.name, reason: result.reason, fixHint: result.fixHint },
      };
    }
  }
  return { ok: true, checks };
}
