/**
 * `switchroom up` — bring up the Switchroom fleet.
 *
 * Linux + Docker is the default; `--legacy` is a plain branch selector
 * for the systemd path (no marker write, no advisory). Non-Linux always
 * uses the systemd path (Docker Desktop is best-effort on Mac/Win and
 * not the production runtime — see Phase 3d declaration in README).
 *
 * The actual fleet bring-up primitives (compose generation, compose-up,
 * systemd unit install/start) all live in modules this file imports
 * from — `up` is purely the decision-and-orchestration layer. Every
 * side-effecting call is injected via `UpDeps` so the unit tests can
 * exercise the decision tree without docker or systemctl on the host.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { withConfigError, getConfig } from "./helpers.js";
import type { SwitchroomConfig } from "../config/schema.js";

const execFileP = promisify(execFile);

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

export interface UpDeps {
  /** `process.platform` override for tests. */
  platform?: NodeJS.Platform;
  /**
   * Bring up the docker fleet (compose generate + compose up). Default
   * shells out to `docker compose up -d`. Tests inject a stub.
   */
  startDockerFleet?: (
    config: SwitchroomConfig,
    options: { buildLocal?: boolean; buildContext?: string },
  ) => Promise<void>;
  /**
   * Install + start systemd units. Default delegates to
   * `installAllUnits` + `agent start all` semantics. Tests inject.
   */
  startSystemdFleet?: (config: SwitchroomConfig) => Promise<void>;
  /** stdout writer; defaults to `process.stdout.write`. */
  writeOut?: (s: string) => void;
}

export interface UpOptions {
  legacy?: boolean;
  /**
   * Dev-only: emit `build:` blocks instead of GHCR `image:` refs so
   * `docker compose up --build` rebuilds from the local Dockerfiles.
   * Ignored on the systemd path. Requires `buildContext` (the absolute
   * path to the switchroom checkout containing `docker/Dockerfile.*`).
   */
  buildLocal?: boolean;
  buildContext?: string;
}

export interface UpResult {
  /** Which runtime was used. */
  runtime: "docker" | "host";
}

async function defaultStartDockerFleet(
  config: SwitchroomConfig,
  options: { buildLocal?: boolean; buildContext?: string } = {},
): Promise<void> {
  const { generateCompose } = await import("../agents/compose.js");
  const composePath = join(homedir(), ".switchroom", "compose", "docker-compose.yml");
  const project = "switchroom";
  const content = generateCompose({
    config,
    buildMode: options.buildLocal ? "local" : "pull",
    buildContext: options.buildContext,
  });
  await mkdir(dirname(composePath), { recursive: true });
  await writeFile(composePath, content, { encoding: "utf8", mode: 0o600 });
  const upArgs = [
    "compose",
    "-p",
    project,
    "-f",
    composePath,
    "up",
    "-d",
    ...(options.buildLocal ? ["--build"] : []),
  ];
  const r = await defaultRunCommand("docker", upArgs);
  if (r.exitCode !== 0) {
    throw new Error(
      `docker compose up failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
    );
  }
}

async function defaultStartSystemdFleet(config: SwitchroomConfig): Promise<void> {
  const { installAllUnits } = await import("../agents/systemd.js");
  installAllUnits(config);
  for (const name of Object.keys(config.agents)) {
    const unit = `switchroom-${name}.service`;
    const r = await defaultRunCommand("systemctl", [
      "--user",
      "enable",
      "--now",
      unit,
    ]);
    if (r.exitCode !== 0) {
      throw new Error(
        `systemctl --user enable --now ${unit} failed (exit ${r.exitCode}): ${r.stderr.trim() || r.stdout.trim()}`,
      );
    }
  }
}

/**
 * Pure orchestrator — exported for tests. Does not parse CLI args.
 *
 * Decision tree:
 *   - non-Linux        → systemd path (Docker Desktop is best-effort,
 *                        not the production runtime; see README)
 *   - Linux + --legacy → systemd path
 *   - Linux (default)  → docker path
 */
export async function runUp(
  config: SwitchroomConfig,
  options: UpOptions,
  deps: UpDeps = {},
): Promise<UpResult> {
  const platform = deps.platform ?? process.platform;
  const writeOut = deps.writeOut ?? ((s) => process.stdout.write(s));
  const startDocker = deps.startDockerFleet ?? defaultStartDockerFleet;
  const startSystemd = deps.startSystemdFleet ?? defaultStartSystemdFleet;

  const useDocker = platform === "linux" && !options.legacy;

  if (useDocker) {
    const modeNote = options.buildLocal ? " [build-local]" : "";
    writeOut(chalk.bold(`Bringing up Switchroom (docker runtime)${modeNote}...\n`));
    await startDocker(config, {
      buildLocal: options.buildLocal,
      buildContext: options.buildContext,
    });
    return { runtime: "docker" };
  }

  writeOut(chalk.bold("Bringing up Switchroom (systemd runtime)...\n"));
  await startSystemd(config);
  return { runtime: "host" };
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
    .option(
      "--build-local [context]",
      "Dev-only: build images locally from in-tree Dockerfiles instead of pulling from GHCR. Optional context path (defaults to cwd).",
    )
    .action(
      withConfigError(async (opts: { legacy?: boolean; buildLocal?: boolean | string }) => {
        const config = getConfig(program);
        const buildLocal = !!opts.buildLocal;
        const buildContext = typeof opts.buildLocal === "string" ? opts.buildLocal : process.cwd();
        try {
          await runUp(config, {
            legacy: !!opts.legacy,
            buildLocal,
            buildContext: buildLocal ? buildContext : undefined,
          });
        } catch (err) {
          console.error(chalk.red(`switchroom up failed: ${(err as Error).message}`));
          process.exit(1);
        }
      }),
    );
}
