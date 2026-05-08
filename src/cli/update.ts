/**
 * `switchroom update` — removed in v0.7.
 *
 * Replaced by the explicit operator-driven flow:
 *
 *     docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull
 *     switchroom apply
 *     docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d
 *
 * This shim exists to keep v0.6 muscle memory + the v0.6 → v0.7 in-flight
 * upgrade path from hard-failing. It silently swallows the legacy flags
 * (`--force`, `--check`, `--no-restart`, `--resume`, `--phase`).
 *
 * `--phase=post-build` is the one case where we exit 0 — that path is
 * invoked by an in-flight v0.6 upgrade self-reexec mid-replace; failing
 * there would leave the operator's fleet in a half-deployed state.
 * Every other invocation exits 1.
 */
import type { Command } from "commander";
import chalk from "chalk";

const REMOVAL_MESSAGE = [
  "switchroom update is removed in v0.7+.",
  "Upgrade via:",
  "  docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml pull \\",
  "    && switchroom apply \\",
  "    && docker compose -p switchroom -f ~/.switchroom/compose/docker-compose.yml up -d",
].join("\n");

export function registerUpdateCommand(program: Command): void {
  program
    .command("update")
    .description(
      "[removed] Replaced by `docker compose pull && switchroom apply && docker compose up -d` (see message).",
    )
    // Legacy flags — accepted and silently ignored so the v0.6 → v0.7
    // self-reexec path doesn't crash on argv it no longer recognises.
    .option("--force", "[no-op]")
    .option("--check", "[no-op]")
    .option("--no-restart", "[no-op]")
    .option("--resume <file>", "[no-op]")
    .option("--phase <phase>", "[no-op]")
    .action(async (opts: { phase?: string }) => {
      // The in-flight v0.6 → v0.7 self-reexec path arrives here with
      // `--phase=post-build`. Failing in that window would leave the
      // operator's fleet half-deployed. Exit 0 with a hint so the
      // outer process keeps marching, and the operator finishes the
      // upgrade by hand.
      if (opts.phase === "post-build") {
        console.warn(
          chalk.yellow(
            "switchroom update --phase=post-build: upgrade-mode no longer supported. Restart manually with `docker compose ... up -d`.",
          ),
        );
        process.exit(0);
      }

      console.error(chalk.red(REMOVAL_MESSAGE));
      process.exit(1);
    });
}
