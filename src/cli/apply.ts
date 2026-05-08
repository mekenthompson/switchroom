/**
 * `switchroom apply` — reconcile fleet to switchroom.yaml.
 *
 * Two responsibilities:
 *   1. Scaffold every agent declared in switchroom.yaml (creating the
 *      per-agent workspace under `agents_dir` if missing, refreshing
 *      bootstrap files if present).
 *   2. Generate `~/.switchroom/compose/docker-compose.yml` so the
 *      operator can bring the fleet up with `docker compose up -d`.
 *
 * `apply` does NOT shell out to docker. It deliberately stops at the
 * compose-file artifact so the operator owns the docker invocation
 * (daemon socket, rootless mode, sudo policy, etc.).
 *
 * The systemd path lives behind `switchroom agent` lifecycle verbs
 * (and their `--legacy` flags). `apply` is the docker-first verb.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { copyFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  loadConfig,
  resolveAgentsDir,
  findConfigFile,
  ConfigError,
} from "../config/loader.js";
import { scaffoldAgent } from "../agents/scaffold.js";
import { generateCompose } from "../agents/compose.js";
import type { SwitchroomConfig } from "../config/schema.js";
import { captureEvent, captureException } from "../analytics/posthog.js";

/** Stable on-disk path for the generated compose file. */
export const DEFAULT_COMPOSE_PATH = join(
  homedir(),
  ".switchroom",
  "compose",
  "docker-compose.yml",
);

/** Compose project name. Stable across regenerations so
 *  `docker compose -p switchroom ...` consistently targets the same fleet. */
export const COMPOSE_PROJECT = "switchroom";

export interface ApplyOptions {
  buildLocal?: boolean;
  buildContext?: string;
  /** Override compose output path (defaults to {@link DEFAULT_COMPOSE_PATH}). */
  outPath?: string;
  /** Optional example name to copy before applying (e.g. "minimal"). */
  example?: string;
}

export interface ApplyDeps {
  /** stdout writer; defaults to `process.stdout.write`. */
  writeOut?: (s: string) => void;
  /** stderr writer; defaults to `process.stderr.write`. */
  writeErr?: (s: string) => void;
}

export interface ApplyResult {
  scaffolded: number;
  agentsTotal: number;
  composePath: string;
  composeBytes: number;
}

/**
 * Pure orchestrator. Exported for unit tests and the deprecation aliases
 * (`switchroom up`, `switchroom init`) which forward straight to here.
 *
 * Ordering matters: scaffold first (so compose-generation sees a
 * well-formed agents directory), compose write second.
 */
export async function runApply(
  config: SwitchroomConfig,
  options: ApplyOptions,
  deps: ApplyDeps = {},
  switchroomConfigPath?: string,
): Promise<ApplyResult> {
  const writeOut = deps.writeOut ?? ((s) => process.stdout.write(s));

  const agentsDir = resolveAgentsDir(config);
  const agentNames = Object.keys(config.agents);

  writeOut(chalk.bold("\nApplying switchroom config...\n"));

  // ── 1. Scaffold each agent ────────────────────────────────────────
  let scaffolded = 0;
  for (const name of agentNames) {
    const agentConfig = config.agents[name];
    try {
      const result = scaffoldAgent(
        name,
        agentConfig,
        agentsDir,
        config.telegram,
        config,
        undefined,
        switchroomConfigPath,
      );
      const detail =
        result.created.length > 0
          ? `${result.created.length} files created`
          : "up to date";
      writeOut(
        chalk.green(`  + ${name}`) +
          chalk.gray(` (${agentConfig.extends ?? "default"}) — ${detail}\n`),
      );
      scaffolded++;
    } catch (err) {
      writeOut(chalk.red(`  x ${name}: ${(err as Error).message}\n`));
    }
  }

  // ── 2. Generate compose file ──────────────────────────────────────
  const composePath = options.outPath ?? DEFAULT_COMPOSE_PATH;
  const composeContent = generateCompose({
    config,
    buildMode: options.buildLocal ? "local" : "pull",
    buildContext: options.buildContext,
  });
  await mkdir(dirname(composePath), { recursive: true });
  await writeFile(composePath, composeContent, {
    encoding: "utf8",
    mode: 0o600,
  });
  const composeBytes = Buffer.byteLength(composeContent, "utf8");

  writeOut(
    chalk.bold(`\nWrote `) +
      composePath +
      chalk.gray(` (${composeBytes} bytes)\n`),
  );
  writeOut(
    `Bring the fleet up with:\n` +
      `  docker compose -p ${COMPOSE_PROJECT} -f ${composePath} pull && \\\n` +
      `    docker compose -p ${COMPOSE_PROJECT} -f ${composePath} up -d\n`,
  );

  writeOut(
    chalk.bold(
      `\nDone. Scaffolded ${scaffolded}/${agentNames.length} agents.\n`,
    ),
  );

  return {
    scaffolded,
    agentsTotal: agentNames.length,
    composePath,
    composeBytes,
  };
}

/**
 * Copy an example switchroom.yaml into cwd. Mirrors the previous
 * `switchroom init --example <name>` behaviour so users (and the
 * `init` deprecation alias) keep working.
 */
function copyExampleConfig(name: string): void {
  if (!/^[a-z0-9_-]+$/.test(name)) {
    throw new Error(
      `Invalid example name: ${name} (must match /^[a-z0-9_-]+$/)`,
    );
  }
  const exampleFile = resolve(
    import.meta.dirname,
    `../../examples/${name}.yaml`,
  );
  const dest = resolve(process.cwd(), "switchroom.yaml");

  if (!existsSync(exampleFile)) {
    throw new Error(
      `Example config not found: ${name}.yaml (available: switchroom, minimal)`,
    );
  }

  if (existsSync(dest)) {
    console.error(
      chalk.yellow(
        "switchroom.yaml already exists — skipping example copy",
      ),
    );
    return;
  }

  copyFileSync(exampleFile, dest);
  console.log(chalk.green(`Copied ${name}.yaml -> switchroom.yaml`));
}

export function registerApplyCommand(program: Command): void {
  program
    .command("apply")
    .description(
      "Apply switchroom.yaml: scaffold every agent and (re)generate the compose file. Run `docker compose -f <path> up -d` afterwards to bring the fleet up.",
    )
    .option(
      "--build-local [context]",
      "Dev-only: emit `build:` blocks instead of GHCR `image:` refs so `docker compose up --build` rebuilds from in-tree Dockerfiles. Optional context path (defaults to cwd).",
    )
    .option(
      "-o, --out <path>",
      `Override compose output path (default: ${DEFAULT_COMPOSE_PATH}).`,
    )
    .option(
      "--example <name>",
      "Copy an example config into cwd before applying (e.g., 'switchroom' or 'minimal').",
    )
    .action(
      async (opts: {
        buildLocal?: boolean | string;
        out?: string;
        example?: string;
      }) => {
        try {
          if (opts.example) {
            copyExampleConfig(opts.example);
          }

          const parentOpts = program.opts();
          const config = loadConfig(parentOpts.config);
          const switchroomConfigPath =
            parentOpts.config ?? findConfigFile();

          const buildLocal = !!opts.buildLocal;
          const buildContext =
            typeof opts.buildLocal === "string"
              ? opts.buildLocal
              : process.cwd();

          const result = await runApply(
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

          await captureEvent("apply_completed", {
            agents_total: result.agentsTotal,
            agents_scaffolded: result.scaffolded,
            build_local: buildLocal,
            example: opts.example ?? null,
          });
        } catch (err) {
          await captureException(err, { action: "apply" });
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
            chalk.red(`switchroom apply failed: ${(err as Error).message}`),
          );
          process.exit(1);
        }
      },
    );
}
