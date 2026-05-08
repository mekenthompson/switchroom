/**
 * Deprecation shims for retired lifecycle verbs.
 *
 * Each shim prints a warning and forwards to `runApply`. They keep
 * v0.6 muscle memory (`switchroom up`, `switchroom init`) and the
 * v0.6 → v0.7 in-flight upgrade path working through one release
 * cycle, slated for removal in v0.8.
 */
import type { Command } from "commander";
import chalk from "chalk";
import {
  loadConfig,
  findConfigFile,
  ConfigError,
} from "../config/loader.js";
import { runApply } from "./apply.js";
import { captureException } from "../analytics/posthog.js";

function warn(retired: string, replacement: string): void {
  console.warn(
    chalk.yellow(
      `switchroom ${retired} is deprecated; use \`switchroom ${replacement}\` (will be removed in v0.8).`,
    ),
  );
}

async function forwardToApply(
  program: Command,
  opts: {
    buildLocal?: boolean | string;
    out?: string;
    example?: string;
    legacy?: boolean;
  },
  action: string,
): Promise<void> {
  if (opts.legacy) {
    console.warn(
      chalk.yellow(
        "  --legacy is no longer wired through the lifecycle CLI. Use `switchroom agent` verbs (start/restart/stop) for the systemd path.",
      ),
    );
  }

  try {
    const parentOpts = program.opts();
    const config = loadConfig(parentOpts.config);
    const switchroomConfigPath = parentOpts.config ?? findConfigFile();

    const buildLocal = !!opts.buildLocal;
    const buildContext =
      typeof opts.buildLocal === "string"
        ? opts.buildLocal
        : process.cwd();

    await runApply(
      config,
      {
        buildLocal,
        buildContext: buildLocal ? buildContext : undefined,
        outPath: opts.out,
        example: opts.example,
      },
      {},
      switchroomConfigPath,
    );
  } catch (err) {
    await captureException(err, { action });
    if (err instanceof ConfigError) {
      console.error(chalk.red(`Config error: ${err.message}`));
      if (err.details) {
        for (const d of err.details) {
          console.error(chalk.gray(d));
        }
      }
      process.exit(1);
    }
    console.error(
      chalk.red(`switchroom ${action} failed: ${(err as Error).message}`),
    );
    process.exit(1);
  }
}

/**
 * Deprecated `switchroom up` — forwards to `apply`. Kept so existing
 * scripts and muscle memory keep working through v0.7.
 */
export function registerUpCommand(program: Command): void {
  program
    .command("up")
    .description(
      "[deprecated] Alias for `switchroom apply`. Removed in v0.8.",
    )
    .option(
      "--build-local [context]",
      "Dev-only: build images locally instead of pulling from GHCR.",
    )
    .option("-o, --out <path>", "Override compose output path.")
    .option(
      "--legacy",
      "[no-op] Previously selected the systemd runtime; that path now lives behind `switchroom agent` verbs.",
    )
    .action(async (opts) => {
      warn("up", "apply");
      await forwardToApply(program, opts, "up");
    });
}

/**
 * Deprecated `switchroom init` — forwards to `apply`. Carries the
 * `--example <name>` flag forward (apply also accepts it).
 */
export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description(
      "[deprecated] Alias for `switchroom apply`. Removed in v0.8.",
    )
    .option(
      "--example <name>",
      "Copy an example config before applying (e.g., 'switchroom' or 'minimal').",
    )
    .option(
      "--build-local [context]",
      "Dev-only: build images locally instead of pulling from GHCR.",
    )
    .option("-o, --out <path>", "Override compose output path.")
    .action(async (opts) => {
      warn("init", "apply");
      await forwardToApply(program, opts, "init");
    });
}
