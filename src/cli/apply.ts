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
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
// Embed example configs as text imports so they survive `bun build --compile`.
// `import.meta.dirname` resolves to `/$bunfs/root` inside a compiled binary,
// which means resolve(import.meta.dirname, "../../examples/...") points at a
// path that doesn't exist on the host — apply --example would fail with
// ENOENT. Text imports are bundled into the binary at compile time.
import switchroomExample from "../../examples/switchroom.yaml" with { type: "text" };
import minimalExample from "../../examples/minimal.yaml" with { type: "text" };

/** Embedded example configs, keyed by name. Mirrors files under examples/. */
const EMBEDDED_EXAMPLES: Record<string, string> = {
  switchroom: switchroomExample,
  minimal: minimalExample,
};
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { isVaultReference } from "../vault/resolver.js";
import { resolvePath } from "../config/loader.js";
import {
  loadConfig,
  resolveAgentsDir,
  findConfigFile,
  ConfigError,
} from "../config/loader.js";
import { scaffoldAgent, alignAgentUid } from "../agents/scaffold.js";
import { generateCompose, allocateAgentUid } from "../agents/compose.js";
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
  /**
   * When true, skip any prompts (e.g. the sudo-chown explainer in
   * alignAgentUid) and assume yes. Required for CI / `apply` invoked
   * non-interactively. Default: prompts when stdin is a TTY.
   */
  nonInteractive?: boolean;
  /**
   * When true, treat a chown failure during UID alignment as a soft
   * warning instead of a hard error. Default false: an unaligned state
   * dir will silently break the agent on first boot, so we fail loudly
   * unless the operator opts into the unsafe path.
   */
  allowUnaligned?: boolean;
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
 * Walk a value recursively and return true if any string property is a
 * `vault:<key>` reference. Used by the preflight check below so we can
 * fail fast when the config wants vault-resolved secrets but the
 * vault hasn't been initialised yet.
 */
function hasVaultRefs(value: unknown): boolean {
  if (typeof value === "string") return isVaultReference(value);
  if (Array.isArray(value)) return value.some(hasVaultRefs);
  if (value && typeof value === "object") {
    return Object.values(value).some(hasVaultRefs);
  }
  return false;
}

/**
 * Pre-create every host directory that compose will bind-mount.
 *
 * Why: docker auto-creates a missing bind-mount source as an empty
 * directory owned by the dockerd UID (root). On v0.7 installs that
 * tripped twice — operators ended up with root-owned `~/.switchroom/vault`
 * and `~/.switchroom/vault-auto-unlock` stub directories that blocked
 * the real files from landing at the same path. Creating the
 * directories ourselves (as the current shell user) removes the
 * race entirely.
 *
 * The set of paths mirrors the volume mount sources emitted by
 * `generateCompose`. We mkdir directories only — files (vault.enc,
 * vault-auto-unlock blob) are managed by `switchroom setup` / vault
 * commands.
 */
async function ensureHostMountSources(config: SwitchroomConfig): Promise<void> {
  const home = homedir();
  const dirs = [
    join(home, ".switchroom", "approvals"),
    join(home, ".switchroom", "scheduler"),
    join(home, ".switchroom", "logs"),
    join(home, ".switchroom", "compose"),
  ];
  for (const name of Object.keys(config.agents)) {
    dirs.push(join(home, ".switchroom", "agents", name));
    dirs.push(join(home, ".switchroom", "logs", name));
    dirs.push(join(home, ".claude", "projects", name));
  }
  for (const dir of dirs) {
    await mkdir(dir, { recursive: true });
  }
}

/**
 * Detect whether `docker compose` (the v2 plugin, not the deprecated
 * `docker-compose` v1 binary) is installed. Returns a friendly error
 * string explaining how to upgrade if it isn't, otherwise null.
 */
function detectComposeV2(): string | null {
  try {
    const out = execFileSync("docker", ["compose", "version"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    // v2 output looks like: "Docker Compose version v2.27.0".
    // v1 (`docker-compose`) wouldn't be invoked via this subcommand —
    // `docker compose` exits non-zero if only v1 is on PATH — so any
    // successful return here implies v2.
    if (!/Docker Compose version v?\d/.test(out)) {
      return `\`docker compose version\` returned unexpected output:\n${out.trim()}`;
    }
    return null;
  } catch {
    return (
      "`docker compose` (v2) not found. switchroom requires the Docker " +
      "Compose v2 plugin (the `docker compose` subcommand), not the " +
      "deprecated standalone `docker-compose` v1 binary.\n" +
      "Upgrade: https://docs.docker.com/compose/install/linux/"
    );
  }
}

/**
 * Run the preflight gate. Fail fast (throws) when the config requires
 * vault-resolved secrets but ~/.switchroom/vault.enc is missing, or
 * when `docker compose` v2 is unavailable. Both conditions would have
 * surfaced as cryptic mid-apply / mid-up failures otherwise.
 */
export function runApplyPreflight(config: SwitchroomConfig): void {
  const vaultPath = resolvePath(
    config.vault?.path ?? "~/.switchroom/vault.enc",
  );
  if (hasVaultRefs(config) && !existsSync(vaultPath)) {
    throw new Error(
      `Config references vault keys (vault:<name>) but ${vaultPath} is missing. ` +
      `Run \`switchroom setup\` first to initialise the vault.`,
    );
  }
  const composeErr = detectComposeV2();
  if (composeErr) {
    throw new Error(composeErr);
  }
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

  // Fail-fast on missing prerequisites before we touch anything.
  // Both checks throw with operator-actionable messages; the action
  // wrapper catches and prints them red.
  runApplyPreflight(config);

  const agentsDir = resolveAgentsDir(config);
  const agentNames = Object.keys(config.agents);

  writeOut(chalk.bold("\nApplying switchroom config...\n"));

  // ── 1. Scaffold each agent ────────────────────────────────────────
  let scaffolded = 0;
  // Sentinel-typed error class so the outer per-agent try/catch can
  // re-raise UID alignment failures without swallowing them as a soft
  // `x ${name}` log line.
  class UidAlignmentAbort extends Error {}
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
      // Align per-agent dir ownership with the container UID assigned
      // by compose.ts. Without this the bind-mount lands read-only
      // for the in-container UID and the agent fails on first write.
      try {
        const uid = allocateAgentUid(name);
        alignAgentUid(name, join(agentsDir, name), uid, {
          confirm: !options.nonInteractive,
          writeOut,
        });
      } catch (alignErr) {
        const msg = (alignErr as Error).message;
        if (options.allowUnaligned) {
          writeOut(
            chalk.yellow(
              `    ! could not chown ${name} state dir: ${msg}\n` +
              `      continuing because --allow-unaligned was passed; agent may fail on first write.\n`,
            ),
          );
        } else {
          writeOut(
            chalk.red(
              `    x could not chown ${name} state dir: ${msg}\n` +
              `      The bind-mounted state dir must be owned by the container's UID or the agent will fail on first write.\n` +
              `      Fix: run \`switchroom apply\` from a TTY so it can prompt for sudo, OR run the suggested chown manually, OR re-run with --allow-unaligned to skip this check.\n`,
            ),
          );
          throw new UidAlignmentAbort(
            `UID alignment failed for agent ${name}; aborting apply (pass --allow-unaligned to override).`,
          );
        }
      }
      scaffolded++;
    } catch (err) {
      if (err instanceof UidAlignmentAbort) throw err;
      writeOut(chalk.red(`  x ${name}: ${(err as Error).message}\n`));
    }
  }

  // ── 2. Pre-create host mount sources ──────────────────────────────
  // Why: docker auto-creates a missing bind-mount source as an empty
  // directory owned by ROOT (because dockerd runs as root). That has
  // bitten v0.7 installs twice — root-owned `~/.switchroom/vault` and
  // `~/.switchroom/vault-auto-unlock` stubs that then blocked the user
  // from moving the real files into place. Eagerly mkdir'ing as the
  // current shell user keeps the source dirs operator-owned.
  // Files (vault.enc, vault-auto-unlock blob) are NOT created here —
  // they're written by `switchroom setup` / vault commands and we
  // shouldn't fabricate empty placeholders. If they're missing, the
  // broker handles that gracefully (vault.enc missing => apply
  // preflight already errors; auto-unlock missing => broker falls
  // back to interactive unlock).
  await ensureHostMountSources(config);

  // ── 3. Generate compose file ──────────────────────────────────────
  const composePath = options.outPath ?? DEFAULT_COMPOSE_PATH;
  const composeContent = generateCompose({
    config,
    buildMode: options.buildLocal ? "local" : "pull",
    buildContext: options.buildContext,
    // Bake the operator's HOME absolute path into volume sources at
    // apply time. Avoids `${HOME}` resolving to /root under sudo.
    homeDir: homedir(),
    // Bind-mount the resolved switchroom.yaml directly into the broker,
    // approval-kernel, and scheduler containers so they don't restart-loop
    // on `ConfigError: No switchroom.yaml found` when the operator's
    // config lives outside ~/.switchroom (v0.7 P0 install-path bug).
    switchroomConfigPath,
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
      `    docker compose -p ${COMPOSE_PROJECT} -f ${composePath} up -d --remove-orphans\n`,
  );
  writeOut(
    chalk.gray(
      `  (If pull returns 401, login to ghcr.io first: see docs/operators/install.md#ghcr-auth)\n`,
    ),
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

  const dest = resolve(process.cwd(), "switchroom.yaml");

  if (existsSync(dest)) {
    console.error(
      chalk.yellow(
        "switchroom.yaml already exists — skipping example copy",
      ),
    );
    return;
  }

  // Prefer embedded examples (works under both `bun run` and `bun build
  // --compile`). Fall back to disk lookup so contributors can add new
  // examples in-tree without rebuilding — only relevant in dev because
  // the compiled binary's `import.meta.dirname` is the bunfs virtual root.
  const embedded = EMBEDDED_EXAMPLES[name];
  if (embedded !== undefined) {
    writeFileSync(dest, embedded, { encoding: "utf8" });
    console.log(chalk.green(`Copied ${name}.yaml -> switchroom.yaml`));
    return;
  }

  const exampleFile = resolve(
    import.meta.dirname,
    `../../examples/${name}.yaml`,
  );
  if (!existsSync(exampleFile)) {
    throw new Error(
      `Example config not found: ${name}.yaml (available: ${Object.keys(EMBEDDED_EXAMPLES).join(", ")})`,
    );
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
    .option(
      "--non-interactive",
      "Skip prompts (e.g. sudo-chown explainer for UID alignment). Use in CI / scripts.",
    )
    .option(
      "--allow-unaligned",
      "Treat UID-alignment chown failures as warnings instead of hard errors. Unsafe: an unaligned state dir will break the agent on first write. Use only if you know you'll fix ownership out-of-band.",
    )
    .action(
      async (opts: {
        buildLocal?: boolean | string;
        out?: string;
        example?: string;
        nonInteractive?: boolean;
        allowUnaligned?: boolean;
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
              nonInteractive: opts.nonInteractive ?? false,
              allowUnaligned: opts.allowUnaligned ?? false,
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
