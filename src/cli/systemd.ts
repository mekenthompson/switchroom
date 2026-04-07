import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, resolveAgentsDir, ConfigError } from "../config/loader.js";
import {
  installAllUnits,
  uninstallUnit,
  daemonReload,
} from "../agents/systemd.js";
import { getAllAgentStatuses } from "../agents/lifecycle.js";

function withConfigError(fn: (...args: any[]) => Promise<void>) {
  return async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(chalk.red(`Config error: ${err.message}`));
        if (err.details) {
          for (const d of err.details) {
            console.error(chalk.gray(d));
          }
        }
        process.exit(1);
      }
      throw err;
    }
  };
}

function getConfig(program: Command) {
  const parentOpts = program.opts();
  return loadConfig(parentOpts.config);
}

export function registerSystemdCommand(program: Command): void {
  const systemd = program
    .command("systemd")
    .description("Manage systemd user units for agents");

  // clerk systemd install
  systemd
    .command("install")
    .description("Generate and install systemd units for all agents")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const agentNames = Object.keys(config.agents);

        console.log(chalk.bold("\nInstalling systemd units...\n"));

        try {
          installAllUnits(config);
          for (const name of agentNames) {
            console.log(chalk.green(`  + clerk-${name}.service`));
          }
          console.log(
            chalk.bold(`\nInstalled ${agentNames.length} units. Daemon reloaded.`)
          );
          console.log(chalk.gray(`  Enable with: clerk agent start all\n`));
        } catch (err) {
          console.error(
            chalk.red(`Failed to install units: ${(err as Error).message}`)
          );
          process.exit(1);
        }
      })
    );

  // clerk systemd status
  systemd
    .command("status")
    .description("Show status of all agent systemd units")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const agentNames = Object.keys(config.agents);
        const statuses = getAllAgentStatuses(config);

        if (agentNames.length === 0) {
          console.log(chalk.yellow("No agents defined in clerk.yaml"));
          return;
        }

        console.log(chalk.bold("\nSystemd unit status:\n"));

        const nameWidth = 28;
        const statusWidth = 12;

        console.log(
          `  ${chalk.bold("Unit".padEnd(nameWidth))}  ${chalk.bold("Status".padEnd(statusWidth))}`
        );

        for (const name of agentNames) {
          const status = statuses[name];
          const unitName = `clerk-${name}.service`;
          const state = status?.active ?? "unknown";
          const stateStr =
            state === "running" || state === "active"
              ? chalk.green(state)
              : state === "stopped" || state === "inactive" || state === "dead"
                ? chalk.red(state)
                : chalk.yellow(state);

          console.log(
            `  ${unitName.padEnd(nameWidth)}  ${stateStr}`
          );
        }
        console.log();
      })
    );

  // clerk systemd uninstall
  systemd
    .command("uninstall")
    .description("Remove all agent systemd units")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const agentNames = Object.keys(config.agents);

        console.log(chalk.bold("\nUninstalling systemd units...\n"));

        for (const name of agentNames) {
          try {
            uninstallUnit(name);
            console.log(chalk.green(`  - clerk-${name}.service`));
          } catch (err) {
            console.error(
              chalk.red(
                `  Failed to remove clerk-${name}.service: ${(err as Error).message}`
              )
            );
          }
        }

        try {
          daemonReload();
        } catch {
          // best effort
        }

        console.log(chalk.bold(`\nRemoved ${agentNames.length} units.\n`));
      })
    );
}
