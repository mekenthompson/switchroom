/**
 * `switchroom update` — bundle the host-update flow into one verb (#918).
 *
 * Pre-#918 the operator was told to invoke five commands across two
 * privilege levels:
 *
 *     git pull
 *     bun install
 *     npm run build
 *     sudo HOME=$HOME PATH=... bun /path/to/dist/cli/switchroom.js apply --non-interactive
 *     docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
 *
 * Each had failure modes — the sudo invocation alone (#920) had three
 * — and operators who didn't memorize the incantation got things half
 * deployed. `update` runs them in order, with idempotent skip-if-fresh
 * checks where possible and clean failure surfacing on each step.
 *
 * Steps (in order):
 *   1. Pull docker images (broker, kernel, agent) from GHCR.
 *   2. (--rebuild only) git pull upstream main + bun install + npm run build.
 *   3. switchroom apply (self-elevates via #920 if needed).
 *   4. docker compose up -d --remove-orphans (recreates containers
 *      whose image digest or compose entry changed).
 *   5. switchroom doctor — surface any FAIL diagnostics post-bounce.
 *
 * Flags:
 *   --check          dry-run; print the steps that would run, exit 0.
 *   --skip-images    skip step 1 (offline mode).
 *   --rebuild        run step 2 (source-checkout users; auto-skipped
 *                    when not in a git repo).
 *
 * Legacy `--phase=post-build` is still accepted as a no-op so any
 * in-flight v0.6 → v0.7 self-reexec path doesn't crash mid-flight.
 */
import type { Command } from "commander";
import chalk from "chalk";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

interface UpdateOptions {
  check?: boolean;
  skipImages?: boolean;
  rebuild?: boolean;
  /** Hidden / legacy flags — kept so v0.6-era invocations don't crash. */
  phase?: string;
  force?: boolean;
  /** Compose-file override for tests. */
  composePath?: string;
  /** stdout/stderr writers for tests. */
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
  /** Test seam — replace step.run with a fake. */
  runner?: (cmd: string, args: string[]) => { status: number };
}

interface UpdateStep {
  name: string;
  description: string;
  /** When true, step is skipped entirely (e.g. --skip-images). */
  skipReason?: string;
  /** Invoked when not in --check mode. Throws on failure. */
  run: () => void;
}

const DEFAULT_COMPOSE_PATH = join(
  homedir(),
  ".switchroom",
  "compose",
  "docker-compose.yml",
);

/**
 * Detect whether the running CLI lives inside a git checkout (so
 * `--rebuild` is meaningful) or is an installed binary (where a git
 * pull would be nonsensical).
 */
export function isGitCheckout(scriptPath: string): boolean {
  let dir = dirname(scriptPath);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return false;
}

/**
 * Build the ordered list of update steps. Pure function — no side
 * effects. The action handler iterates this list and either prints
 * (--check) or executes (default).
 */
export function planUpdate(opts: UpdateOptions): UpdateStep[] {
  const composePath = opts.composePath ?? DEFAULT_COMPOSE_PATH;
  const runner = opts.runner ?? defaultRunner;
  const steps: UpdateStep[] = [];

  steps.push({
    name: "pull-images",
    description: "Pull broker / kernel / agent images from GHCR",
    skipReason: opts.skipImages
      ? "--skip-images flag set"
      : !existsSync(composePath)
        ? `compose file not found at ${composePath} (run \`switchroom apply --compose-only\` first)`
        : undefined,
    run: () => {
      const r = runner("docker", [
        "compose", "-p", "switchroom", "-f", composePath, "pull",
      ]);
      if (r.status !== 0) throw new Error("docker compose pull failed");
    },
  });

  // Source-checkout step. Only added when --rebuild is explicit. If
  // the user passed --rebuild but the CLI isn't running from a git
  // checkout, the runUpdate dispatcher will fail loudly — the explicit
  // flag is treated as a hard intent, not a hint we can quietly drop
  // (#923 reviewer feedback).
  const scriptPath = process.argv[1] ?? "";
  if (opts.rebuild) {
    steps.push({
      name: "rebuild-source",
      description: "git pull upstream main + bun install + npm run build",
      run: () => {
        if (!isGitCheckout(scriptPath)) {
          throw new Error(
            `--rebuild requires a git checkout, but the CLI is running ` +
            `from ${scriptPath} which has no .git ancestor (looks like ` +
            `an installed binary). Drop --rebuild or invoke from a ` +
            `source checkout.`,
          );
        }
        // CWD matters: git/bun/npm run from process.cwd(). Operator
        // is expected to invoke `update --rebuild` from inside the
        // checkout. We don't chdir on their behalf because they may
        // have multiple worktrees and we shouldn't guess which.
        const pull = runner("git", ["pull", "--ff-only", "upstream", "main"]);
        if (pull.status !== 0) throw new Error("git pull failed");
        const install = runner("bun", ["install"]);
        if (install.status !== 0) throw new Error("bun install failed");
        const build = runner("npm", ["run", "build"]);
        if (build.status !== 0) throw new Error("npm run build failed");
      },
    });
  }

  steps.push({
    name: "apply-config",
    description: "switchroom apply — refresh per-agent scaffolds + compose",
    run: () => {
      // Re-exec ourselves to invoke the apply subcommand. apply will
      // self-elevate via #920 if needed.
      const r = runner(process.execPath, [
        scriptPath,
        "apply",
        "--non-interactive",
      ]);
      if (r.status !== 0) throw new Error("switchroom apply failed");
    },
  });

  steps.push({
    name: "recreate-containers",
    description:
      "docker compose up -d --remove-orphans (recreates services with new images / compose)",
    // No skipReason: apply-config (the prior step) regenerates compose
    // and per-agent scaffolds even with --skip-images. If the operator
    // added/removed/renamed an agent and we skipped recreate, the
    // running fleet would be out of sync with on-disk compose. Up-d
    // is cheap and idempotent — if nothing changed it's a no-op
    // (#923 reviewer feedback).
    run: () => {
      const r = runner("docker", [
        "compose", "-p", "switchroom", "-f", composePath, "up", "-d",
        "--remove-orphans",
      ]);
      if (r.status !== 0) throw new Error("docker compose up failed");
    },
  });

  steps.push({
    name: "doctor",
    description: "switchroom doctor — surface post-bounce diagnostics",
    run: () => {
      // Doctor returns non-zero on findings; don't propagate that as
      // an update failure (the update succeeded; the diagnostics are
      // informational). Just print and continue.
      runner(process.execPath, [scriptPath, "doctor"]);
    },
  });

  return steps;
}

function defaultRunner(cmd: string, args: string[]): { status: number } {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  return { status: r.status ?? 1 };
}

async function runUpdate(opts: UpdateOptions): Promise<number> {
  const stdout = opts.stdout ?? ((s) => process.stdout.write(s));
  const stderr = opts.stderr ?? ((s) => process.stderr.write(s));
  const steps = planUpdate(opts);

  if (opts.check) {
    stdout(chalk.bold("switchroom update --check (dry-run)\n\n"));
    for (const step of steps) {
      const status = step.skipReason
        ? chalk.gray(`[skip] ${step.skipReason}`)
        : chalk.green("[run]");
      stdout(`  ${status} ${step.name} — ${step.description}\n`);
    }
    stdout("\nDry-run only; nothing was changed. Re-run without --check to apply.\n");
    return 0;
  }

  for (const step of steps) {
    if (step.skipReason) {
      stdout(chalk.gray(`▸ ${step.name}: skipped (${step.skipReason})\n`));
      continue;
    }
    stdout(chalk.bold(`▸ ${step.name}\n`));
    try {
      step.run();
    } catch (err) {
      stderr(
        chalk.red(`✗ ${step.name} failed: ${(err as Error).message}\n`),
      );
      return 1;
    }
  }
  stdout(chalk.green("\n✓ update complete\n"));
  return 0;
}

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description(
      "Update switchroom on this host: pull images, refresh scaffolds, recreate containers. Wraps the full `pull && apply && up -d` flow.",
    )
    .option("--check", "Dry-run: print the steps that would execute, exit 0.")
    .option("--skip-images", "Skip the docker image pull (offline mode).")
    .option(
      "--rebuild",
      "Source-checkout users: also git pull + bun install + npm run build before applying. Auto-skipped when the CLI is an installed binary.",
    )
    // Legacy v0.6 flags — accepted as no-ops so a stale operator
    // muscle-memory invocation doesn't crash. The --phase=post-build
    // path was the in-flight v0.6→v0.7 self-reexec; that's dead now,
    // exit 0 with a hint instead of trying to do anything.
    .option("--force", "[legacy v0.6 no-op]")
    .option("--no-restart", "[legacy v0.6 no-op]")
    .option("--resume <file>", "[legacy v0.6 no-op]")
    .option("--phase <phase>", "[legacy v0.6 no-op]")
    .action(async (opts: UpdateOptions) => {
      if (opts.phase === "post-build") {
        console.warn(
          chalk.yellow(
            "switchroom update --phase=post-build: legacy v0.6 self-reexec path. " +
            "v0.7+ handles this end-to-end via `update` proper; nothing to do.",
          ),
        );
        process.exit(0);
      }
      const code = await runUpdate(opts);
      process.exit(code);
    });
}

export { runUpdate, defaultRunner, DEFAULT_COMPOSE_PATH };
