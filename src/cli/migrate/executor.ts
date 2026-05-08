/**
 * Migration plan executor — Phase 3b-2b.
 *
 * Walks a typed `MigrationPlan` (built by `buildPlan`), executing each
 * step against injected side-effect dependencies and appending a JSONL
 * entry to `~/.switchroom/migration.log` after every step.
 *
 * Failure → rollback. Each step that ran successfully has its inverse
 * issued in reverse order. After rollback we exit non-zero and the
 * fleet is in the pre-migration state (verifiable via the log).
 *
 * Phase 3b-2b only implements the `to-docker` direction. `to-host` is
 * still gated in `index.ts` and will land in 3b-2c.
 *
 * Side effects are injected as `ExecutorDeps` so the unit tests can
 * stub every primitive (run-command, fs writes, prompt, etc.) and
 * exercise both happy-path and forced-failure rollback paths without
 * touching the real host.
 */
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, rm, writeFile, chown } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type {
  MigrationPlan,
  PlanStep,
  MigrateVerb,
} from "./plan.js";
import type { RunCommand, RunCommandResult } from "./preflight.js";
import { defaultRunCommand } from "./preflight.js";
import {
  appendMigrationLogEntry,
  defaultMigrationLogPath,
} from "./log.js";

/** Read-only handle to a running `Date.now()` source — overridable in tests. */
export type NowFn = () => number;

export interface ExecutorDeps {
  /** Subprocess runner (systemctl, docker compose). */
  runCommand?: RunCommand;
  /**
   * Generate the compose file content. The default uses the project's
   * cascade and `generateCompose()` from `src/agents/compose.ts`. Tests
   * inject a stub.
   */
  generateComposeContent?: () => Promise<string> | string;
  /**
   * Probe broker reachability for a single agent. Default returns true
   * if `statusViaBroker` resolves with `unlocked`. Tests inject.
   */
  probeAgentBroker?: (agent: string) => Promise<boolean>;
  /**
   * Prompt for UID-align confirmation. Default returns false (skip)
   * when stdin is not a TTY. Tests inject.
   */
  confirmUidAlign?: (agent: string, fromUid: number, toUid: number) => Promise<boolean>;
  /** chown driver for uid-align. Default uses `node:fs/promises` chown. */
  chownPath?: (path: string, uid: number, gid: number) => Promise<void>;
  /** Override the log path (default `~/.switchroom/migration.log`). */
  logPath?: string;
  /** Override the runtime-mode marker path. */
  runtimeModePath?: string;
  /** Override the watchdog-pause sentinel path. */
  watchdogPausePath?: string;
  /** Override the agent workspace root (default `~/.switchroom/agents`). */
  agentsRoot?: string;
  /** Time source for log entries; not used here directly but reserved. */
  now?: NowFn;
}

export interface ExecutorOpts {
  /** Compose project name (matches the plan). */
  composeProject: string;
  /** Compose file path (matches the plan). */
  composePath: string;
  /** Stream human-friendly progress to stderr. */
  onProgress?: (msg: string) => void;
}

export interface ExecutorResult {
  ok: boolean;
  /** Indices (0-based into plan.steps) of steps that ran successfully. */
  completed: number[];
  /** When ok=false, the failing step's index + error message. */
  failed?: { index: number; step: PlanStep; error: string };
  /** Steps reverted during rollback (0-based original indices, in rollback order). */
  rolledBack: number[];
}

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export function defaultRuntimeModePath(): string {
  return join(homedir(), ".switchroom", "runtime-mode");
}

export function defaultWatchdogPausePath(): string {
  return join(homedir(), ".switchroom", "watchdog.paused");
}

export function defaultAgentsRoot(): string {
  return join(homedir(), ".switchroom", "agents");
}

async function defaultProbeBroker(_agent: string): Promise<boolean> {
  // The default real implementation lives in src/vault/broker/client.ts.
  // We import lazily to avoid a hard dependency for tests that override
  // this hook.
  const { statusViaBroker } = await import("../../vault/broker/client.js");
  const status = await statusViaBroker();
  return !!status?.unlocked;
}

async function defaultGenerateComposeContent(): Promise<string> {
  const { loadConfig } = await import("../../config/loader.js");
  const { generateCompose } = await import("../../agents/compose.js");
  const config = loadConfig();
  return generateCompose({ config });
}

async function defaultConfirmUidAlign(
  agent: string,
  fromUid: number,
  toUid: number,
): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  // Lazy-load readline so non-interactive contexts don't pay the cost.
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const a = await rl.question(
      `chown agent "${agent}" workspace from UID ${fromUid} → ${toUid}? [y/N] `,
    );
    return /^y(es)?$/i.test(a.trim());
  } finally {
    rl.close();
  }
}

/* ------------------------------------------------------------------ */
/* Step executors                                                      */
/* ------------------------------------------------------------------ */

interface StepCtx {
  verb: MigrateVerb;
  deps: Required<
    Pick<
      ExecutorDeps,
      | "runCommand"
      | "generateComposeContent"
      | "probeAgentBroker"
      | "confirmUidAlign"
      | "chownPath"
      | "logPath"
      | "runtimeModePath"
      | "watchdogPausePath"
      | "agentsRoot"
    >
  >;
  opts: ExecutorOpts;
  /**
   * Per-step rollback hooks recorded as we go (LIFO). Each hook records
   * the original `plan.steps` index it reverses so audit-log entries can
   * name the step accurately even when some completed steps push no hook
   * (e.g. `vault-broker-handshake` is idempotent, `watchdog-resume` has
   * nothing to undo).
   */
  rollback: Array<{ stepIndex: number; fn: () => Promise<void> }>;
}

async function runSystemctl(
  ctx: StepCtx,
  verb: "stop" | "start" | "enable" | "disable",
  unit: string,
): Promise<void> {
  const r = await ctx.deps.runCommand("systemctl", ["--user", verb, unit]);
  if (r.exitCode !== 0) {
    throw new Error(
      `systemctl --user ${verb} ${unit} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
}

async function runComposeUp(ctx: StepCtx, project: string, path: string): Promise<void> {
  const r = await ctx.deps.runCommand("docker", [
    "compose",
    "-p",
    project,
    "-f",
    path,
    "up",
    "-d",
  ]);
  if (r.exitCode !== 0) {
    throw new Error(
      `docker compose up failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
}

async function runComposeDown(ctx: StepCtx, project: string, path: string): Promise<void> {
  const args = ["compose", "-p", project];
  if (existsSync(path)) {
    args.push("-f", path);
  }
  args.push("down");
  const r = await ctx.deps.runCommand("docker", args);
  if (r.exitCode !== 0) {
    throw new Error(
      `docker compose down failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
}

async function writeMarker(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content + "\n", { encoding: "utf8", mode: 0o600 });
}

async function executeStep(ctx: StepCtx, step: PlanStep, stepIndex: number): Promise<void> {
  const pushRollback = (fn: () => Promise<void>) =>
    ctx.rollback.push({ stepIndex, fn });
  switch (step.kind) {
    case "watchdog-pause": {
      await writeMarker(ctx.deps.watchdogPausePath, "paused-by=migrate");
      pushRollback(async () => {
        await rm(ctx.deps.watchdogPausePath, { force: true });
      });
      return;
    }
    case "watchdog-resume": {
      await rm(ctx.deps.watchdogPausePath, { force: true });
      // No rollback for resume — re-pausing on failure during resume is
      // pointless (if we're resuming we're at the tail of the plan).
      return;
    }
    case "systemd-stop": {
      await runSystemctl(ctx, "stop", step.unit);
      const unit = step.unit;
      pushRollback(async () => {
        await runSystemctl(ctx, "start", unit).catch(() => undefined);
      });
      return;
    }
    case "systemd-disable": {
      await runSystemctl(ctx, "disable", step.unit);
      const unit = step.unit;
      pushRollback(async () => {
        await runSystemctl(ctx, "enable", unit).catch(() => undefined);
      });
      return;
    }
    case "systemd-enable": {
      await runSystemctl(ctx, "enable", step.unit);
      const unit = step.unit;
      pushRollback(async () => {
        await runSystemctl(ctx, "disable", unit).catch(() => undefined);
      });
      return;
    }
    case "systemd-start": {
      await runSystemctl(ctx, "start", step.unit);
      const unit = step.unit;
      pushRollback(async () => {
        await runSystemctl(ctx, "stop", unit).catch(() => undefined);
      });
      return;
    }
    case "compose-generate": {
      const content = await ctx.deps.generateComposeContent();
      await mkdir(dirname(step.path), { recursive: true });
      await writeFile(step.path, content, { encoding: "utf8", mode: 0o600 });
      const path = step.path;
      pushRollback(async () => {
        await rm(path, { force: true });
      });
      return;
    }
    case "compose-up": {
      await runComposeUp(ctx, step.project, step.path);
      const project = step.project;
      const path = step.path;
      pushRollback(async () => {
        await runComposeDown(ctx, project, path).catch(() => undefined);
      });
      return;
    }
    case "compose-down": {
      await runComposeDown(ctx, step.project, step.path);
      // No automatic rollback (recreating compose-up requires the file
      // to still exist; the caller's rollback chain will handle that
      // when applicable in to-host).
      return;
    }
    case "marker-write": {
      const prev = await readMarkerSafe(ctx.deps.runtimeModePath);
      await writeMarker(ctx.deps.runtimeModePath, step.mode);
      pushRollback(async () => {
        if (prev === null) {
          await rm(ctx.deps.runtimeModePath, { force: true });
        } else {
          await writeMarker(ctx.deps.runtimeModePath, prev);
        }
      });
      return;
    }
    case "vault-broker-handshake": {
      const ok = await ctx.deps.probeAgentBroker(step.agent);
      if (!ok) {
        throw new Error(
          `vault-broker handshake failed for agent "${step.agent}" (broker unreachable or locked).`,
        );
      }
      // Idempotent — no rollback.
      return;
    }
    case "uid-align": {
      const dir = join(ctx.deps.agentsRoot, step.agent);
      if (!existsSync(dir)) {
        // Nothing to align; treat as no-op.
        return;
      }
      const st = statSync(dir);
      if (st.uid === step.targetUid) {
        return;
      }
      const confirmed = await ctx.deps.confirmUidAlign(step.agent, st.uid, step.targetUid);
      if (!confirmed) {
        throw new Error(
          `UID alignment refused for agent "${step.agent}" (was ${st.uid}, target ${step.targetUid}).`,
        );
      }
      const fromUid = st.uid;
      const fromGid = st.gid;
      await ctx.deps.chownPath(dir, step.targetUid, step.targetUid);
      pushRollback(async () => {
        await ctx.deps.chownPath(dir, fromUid, fromGid).catch(() => undefined);
      });
      return;
    }
  }
}

async function readMarkerSafe(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path, "utf8");
    return buf.trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Top-level executor                                                  */
/* ------------------------------------------------------------------ */

function describeStepShort(step: PlanStep): string {
  switch (step.kind) {
    case "systemd-stop":
    case "systemd-start":
    case "systemd-enable":
    case "systemd-disable":
      return `${step.kind}:${step.unit}`;
    case "compose-generate":
      return `compose-generate:${step.path}`;
    case "compose-up":
      return `compose-up:${step.project}`;
    case "compose-down":
      return `compose-down:${step.project}`;
    case "marker-write":
      return `marker-write:${step.mode}`;
    case "vault-broker-handshake":
      return `vault-broker-handshake:${step.agent}`;
    case "uid-align":
      return `uid-align:${step.agent}->${step.targetUid}`;
    case "watchdog-pause":
      return "watchdog-pause";
    case "watchdog-resume":
      return "watchdog-resume";
  }
}

export async function executePlan(
  plan: MigrationPlan,
  opts: ExecutorOpts,
  rawDeps: ExecutorDeps = {},
): Promise<ExecutorResult> {
  const deps: StepCtx["deps"] = {
    runCommand: rawDeps.runCommand ?? defaultRunCommand,
    generateComposeContent: rawDeps.generateComposeContent ?? defaultGenerateComposeContent,
    probeAgentBroker: rawDeps.probeAgentBroker ?? defaultProbeBroker,
    confirmUidAlign: rawDeps.confirmUidAlign ?? defaultConfirmUidAlign,
    chownPath: rawDeps.chownPath ?? ((p, u, g) => chown(p, u, g)),
    logPath: rawDeps.logPath ?? defaultMigrationLogPath(),
    runtimeModePath: rawDeps.runtimeModePath ?? defaultRuntimeModePath(),
    watchdogPausePath: rawDeps.watchdogPausePath ?? defaultWatchdogPausePath(),
    agentsRoot: rawDeps.agentsRoot ?? defaultAgentsRoot(),
  };
  const ctx: StepCtx = { verb: plan.verb, deps, opts, rollback: [] };
  const completed: number[] = [];
  const rolledBack: number[] = [];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i]!;
    const label = describeStepShort(step);
    opts.onProgress?.(`step ${i + 1}/${plan.steps.length}: ${label}`);
    try {
      await executeStep(ctx, step, i);
      await appendMigrationLogEntry(
        { verb: plan.verb, step: label, status: "ok" },
        deps.logPath,
      );
      completed.push(i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await appendMigrationLogEntry(
        { verb: plan.verb, step: label, status: "error", error: msg },
        deps.logPath,
      );
      // Run rollback hooks (LIFO). Each hook carries the step index it
      // reverses so the audit-log entry names the right step even when
      // some completed steps push no hook (e.g. vault-broker-handshake,
      // watchdog-resume).
      const hooks = ctx.rollback.slice().reverse();
      for (const hook of hooks) {
        const stepIdx = hook.stepIndex;
        const stepLabel =
          stepIdx >= 0 && stepIdx < plan.steps.length
            ? describeStepShort(plan.steps[stepIdx]!)
            : `hook-${stepIdx}`;
        try {
          await hook.fn();
          await appendMigrationLogEntry(
            {
              verb: plan.verb,
              step: stepLabel,
              status: "rollback",
              detail: "reverted",
            },
            deps.logPath,
          );
          if (stepIdx >= 0) rolledBack.push(stepIdx);
        } catch (rerr) {
          const rmsg = rerr instanceof Error ? rerr.message : String(rerr);
          await appendMigrationLogEntry(
            {
              verb: plan.verb,
              step: stepLabel,
              status: "rollback",
              detail: "FAILED",
              error: rmsg,
            },
            deps.logPath,
          );
        }
      }
      return {
        ok: false,
        completed,
        failed: { index: i, step, error: msg },
        rolledBack,
      };
    }
  }

  return { ok: true, completed, rolledBack };
}
