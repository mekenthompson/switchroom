/**
 * `switchroom up` — Phase 3b-3 default flip.
 *
 * On Linux with no prior runtime-mode marker, default to the Docker
 * runtime (Phase 3b's docker-compose-driven fleet). Hosts already
 * running the legacy systemd installation keep using systemd and see a
 * one-time advisory pointing to `switchroom migrate to-docker`. The
 * `--legacy` flag lets operators explicitly opt back into systemd
 * (silencing the advisory and pinning the marker so future invocations
 * route to systemd without re-checking).
 *
 * The actual fleet bring-up primitives (compose generation, compose-up,
 * systemd unit install/start) all live in modules this file imports
 * from — `up` is purely the decision-and-orchestration layer. Every
 * side-effecting call is injected via `UpDeps` so the unit tests can
 * exercise the full decision matrix without docker or systemctl on the
 * host.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { withConfigError, getConfig } from "./helpers.js";
import {
  decideRuntime,
  defaultRuntimeModePath,
  hasActiveSystemdInstall,
  legacyAdvisoryText,
  readRuntimeMode,
  type RunCommand,
} from "./runtime-detection.js";
import { defaultRunCommand } from "./migrate/preflight.js";
import type { SwitchroomConfig } from "../config/schema.js";

export interface UpDeps {
  /** `process.platform` override for tests. */
  platform?: NodeJS.Platform;
  /** Override the runtime-mode marker path. */
  runtimeModePath?: string;
  /** Subprocess runner (only used for systemctl probe). */
  runCommand?: RunCommand;
  /**
   * Bring up the docker fleet (compose generate + compose up). Default
   * shells out via the migrate executor's primitives. Tests inject a
   * stub.
   */
  startDockerFleet?: (config: SwitchroomConfig) => Promise<void>;
  /**
   * Install + start systemd units. Default delegates to
   * `installAllUnits` + `agent start all` semantics. Tests inject.
   */
  startSystemdFleet?: (config: SwitchroomConfig) => Promise<void>;
  /** stderr writer; defaults to `process.stderr.write`. */
  writeErr?: (s: string) => void;
  /** stdout writer; defaults to `process.stdout.write`. */
  writeOut?: (s: string) => void;
}

export interface UpOptions {
  legacy?: boolean;
}

export interface UpResult {
  /** Which runtime was used. */
  runtime: "docker" | "host";
  /** Did we print the legacy advisory this invocation? */
  printedAdvisory: boolean;
  /** What did we write the runtime-mode marker to (or null = unchanged)? */
  markerWritten: "host" | "docker" | null;
}

async function defaultStartDockerFleet(config: SwitchroomConfig): Promise<void> {
  const { generateCompose } = await import("../agents/compose.js");
  const composePath = join(homedir(), ".switchroom", "compose", "docker-compose.yml");
  const project = "switchroom";
  const content = generateCompose({ config });
  await mkdir(dirname(composePath), { recursive: true });
  await writeFile(composePath, content, { encoding: "utf8", mode: 0o600 });
  const run = defaultRunCommand;
  const r = await run("docker", [
    "compose",
    "-p",
    project,
    "-f",
    composePath,
    "up",
    "-d",
  ]);
  if (r.exitCode !== 0) {
    throw new Error(
      `docker compose up failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
}

async function defaultStartSystemdFleet(config: SwitchroomConfig): Promise<void> {
  const { installAllUnits } = await import("../agents/systemd.js");
  installAllUnits(config);
  const run = defaultRunCommand;
  for (const name of Object.keys(config.agents)) {
    const unit = `switchroom-${name}.service`;
    const r = await run("systemctl", ["--user", "enable", "--now", unit]);
    if (r.exitCode !== 0) {
      throw new Error(
        `systemctl --user enable --now ${unit} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
      );
    }
  }
}

async function writeMarker(path: string, mode: "host" | "docker"): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, mode + "\n", { encoding: "utf8", mode: 0o600 });
}

/**
 * Pure orchestrator — exported for tests. Does not parse CLI args.
 */
export async function runUp(
  config: SwitchroomConfig,
  options: UpOptions,
  deps: UpDeps = {},
): Promise<UpResult> {
  const platform = deps.platform ?? process.platform;
  const markerPath = deps.runtimeModePath ?? defaultRuntimeModePath();
  const run = deps.runCommand ?? defaultRunCommand;
  const writeErr = deps.writeErr ?? ((s) => process.stderr.write(s));
  const writeOut = deps.writeOut ?? ((s) => process.stdout.write(s));
  const startDocker = deps.startDockerFleet ?? defaultStartDockerFleet;
  const startSystemd = deps.startSystemdFleet ?? defaultStartSystemdFleet;

  const marker = readRuntimeMode(markerPath);
  // Only probe systemd if the marker doesn't already pin us — saves a
  // subprocess on docker-mode hosts.
  const hasSystemd =
    marker === null && platform === "linux"
      ? await hasActiveSystemdInstall(run)
      : false;

  const decision = decideRuntime({
    platform,
    marker,
    hasActiveSystemd: hasSystemd,
    legacy: !!options.legacy,
  });

  let printedAdvisory = false;
  if (decision.showLegacyAdvisory) {
    writeErr(chalk.yellow("\n" + legacyAdvisoryText() + "\n\n"));
    printedAdvisory = true;
  }

  if (decision.runtime === "docker") {
    writeOut(chalk.bold("Bringing up Switchroom (docker runtime)...\n"));
    await startDocker(config);
  } else {
    writeOut(chalk.bold("Bringing up Switchroom (systemd runtime)...\n"));
    await startSystemd(config);
  }

  let markerWritten: "host" | "docker" | null = null;
  if (decision.writeDockerMarkerAfter) {
    await writeMarker(markerPath, "docker");
    markerWritten = "docker";
  } else if (decision.writeHostMarkerAfter) {
    await writeMarker(markerPath, "host");
    markerWritten = "host";
  }

  return { runtime: decision.runtime, printedAdvisory, markerWritten };
}

export function registerUpCommand(program: Command): void {
  program
    .command("up")
    .description(
      "Bring up the Switchroom fleet. Defaults to Docker on Linux; pass --legacy to use systemd.",
    )
    .option(
      "--legacy",
      "Force the legacy systemd runtime instead of Docker (Linux-only override).",
    )
    .action(
      withConfigError(async (opts: { legacy?: boolean }) => {
        const config = getConfig(program);
        try {
          await runUp(config, { legacy: !!opts.legacy });
        } catch (err) {
          console.error(chalk.red(`switchroom up failed: ${(err as Error).message}`));
          process.exit(1);
        }
      }),
    );
}
