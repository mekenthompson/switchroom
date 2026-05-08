/**
 * `switchroom compose` — compose-file generation utilities.
 *
 * `switchroom compose generate` renders the docker-compose.yml for the
 * current fleet and writes it to a stable path. Operators then run
 * `docker compose -f <path> up -d` themselves; the CLI deliberately does
 * not bring up the fleet on the operator's behalf.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { withConfigError, getConfig } from "./helpers.js";
import { generateCompose } from "../agents/compose.js";
import type { SwitchroomConfig } from "../config/schema.js";

/** Stable on-disk path for the generated compose file. */
export const DEFAULT_COMPOSE_PATH = join(
  homedir(),
  ".switchroom",
  "compose",
  "docker-compose.yml",
);

/** Compose project name. Stable across regenerations so `docker compose
 *  -p switchroom ...` consistently targets the same fleet. */
export const COMPOSE_PROJECT = "switchroom";

export interface GenerateComposeOptions {
  buildLocal?: boolean;
  buildContext?: string;
  /** Override output path (defaults to {@link DEFAULT_COMPOSE_PATH}). */
  outPath?: string;
}

export interface GenerateComposeResult {
  path: string;
  bytes: number;
}

/**
 * Pure helper — renders the compose YAML and writes it to disk. Exported
 * for tests and for any caller that needs the same artifact without
 * going through commander.
 */
export async function writeComposeFile(
  config: SwitchroomConfig,
  options: GenerateComposeOptions = {},
): Promise<GenerateComposeResult> {
  const path = options.outPath ?? DEFAULT_COMPOSE_PATH;
  const content = generateCompose({
    config,
    buildMode: options.buildLocal ? "local" : "pull",
    buildContext: options.buildContext,
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
  return { path, bytes: Buffer.byteLength(content, "utf8") };
}

export function registerComposeCommand(program: Command): void {
  const compose = program
    .command("compose")
    .description("Compose-file generation utilities for the Docker fleet.");

  compose
    .command("generate")
    .description(
      "Generate ~/.switchroom/compose/docker-compose.yml from switchroom.yaml. Run `docker compose -f <path> up -d` to bring the fleet up.",
    )
    .option(
      "--build-local [context]",
      "Dev-only: emit `build:` blocks instead of GHCR `image:` refs so `docker compose up --build` rebuilds from in-tree Dockerfiles. Optional context path (defaults to cwd).",
    )
    .option(
      "-o, --out <path>",
      `Override output path (default: ${DEFAULT_COMPOSE_PATH}).`,
    )
    .action(
      withConfigError(
        async (opts: { buildLocal?: boolean | string; out?: string }) => {
          const config = getConfig(program);
          const buildLocal = !!opts.buildLocal;
          const buildContext =
            typeof opts.buildLocal === "string" ? opts.buildLocal : process.cwd();
          try {
            const res = await writeComposeFile(config, {
              buildLocal,
              buildContext: buildLocal ? buildContext : undefined,
              outPath: opts.out,
            });
            process.stdout.write(
              `${chalk.bold("Wrote")} ${res.path} ${chalk.dim(`(${res.bytes} bytes)`)}\n`,
            );
            process.stdout.write(
              `Bring the fleet up with:\n  docker compose -p ${COMPOSE_PROJECT} -f ${res.path} pull\n  docker compose -p ${COMPOSE_PROJECT} -f ${res.path} up -d\n`,
            );
          } catch (err) {
            console.error(
              chalk.red(`switchroom compose generate failed: ${(err as Error).message}`),
            );
            process.exit(1);
          }
        },
      ),
    );
}
