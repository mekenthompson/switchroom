import type { Command } from "commander";
import chalk from "chalk";
import { withConfigError, getConfig, getConfigPath } from "./helpers.js";
import { resolveAgentsDir } from "../config/loader.js";
import { restartAgent, writeRestartReasonMarker, getAgentStatus } from "../agents/lifecycle.js";
import { reconcileAndRestartAgent } from "./agent.js";
import { printHealthSummary } from "./version.js";

/**
 * `switchroom restart [agent]`
 *
 * With no agent argument: restart all agents.
 * With an agent name: restart just that agent.
 *
 * Drain semantics: by default we use the graceful-restart path which
 * waits for an in-flight claude turn to complete before cycling the
 * process (same as `agent restart --graceful-restart`).
 *
 * --force: skip drain, SIGTERM immediately (same as omitting graceful).
 *
 * Prints the one-line health summary when done.
 */
export function registerRestartCommand(program: Command): void {
  program
    .command("restart [agent]")
    .description(
      "Restart all agents (or a named agent). Drains in-flight turns by default; use --force to skip."
    )
    .option("--force", "Skip drain — SIGTERM immediately without waiting for turn to complete")
    .action(
      withConfigError(async (agentArg: string | undefined, opts: { force?: boolean }) => {
        const config = getConfig(program);
        const agentsDir = resolveAgentsDir(config);
        const configPath = getConfigPath(program);
        const allNames = Object.keys(config.agents);

        const names = agentArg
          ? agentArg === "all"
            ? allNames
            : [agentArg]
          : allNames;

        if (names.length === 0) {
          console.log(chalk.yellow("No agents defined in switchroom.yaml — nothing to restart."));
          return;
        }

        const graceful = !opts.force;

        for (const name of names) {
          if (!config.agents[name]) {
            console.error(chalk.red(`Agent "${name}" is not defined in switchroom.yaml`));
            continue;
          }

          try {
            writeRestartReasonMarker(name, "cli: switchroom restart", { preserveExisting: true });

            const res = await reconcileAndRestartAgent(
              name,
              config,
              agentsDir,
              configPath,
              { graceful },
            );

            if (graceful) {
              if (res.restarted) {
                console.log(chalk.green(`  ${name}: restarted`));
              } else if (res.waitingForTurn) {
                console.log(chalk.yellow(`  ${name}: restart scheduled (waiting for turn to complete)`));
              }
            } else {
              console.log(chalk.green(`  ${name}: restarted`));
            }
          } catch (err) {
            console.error(chalk.red(`  ${name}: restart failed: ${(err as Error).message}`));
          }
        }

        // Print health summary
        console.log();
        printHealthSummary(config);
      })
    );
}
