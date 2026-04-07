import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, ConfigError } from "../config/loader.js";
import { getCollectionForAgent, isStrictIsolation } from "../memory/hindsight.js";
import { searchMemory, getMemoryStats, reflectAcrossAgents } from "../memory/search.js";

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

export function registerMemoryCommand(program: Command): void {
  const memory = program
    .command("memory")
    .description("Hindsight memory operations");

  // clerk memory search <query>
  memory
    .command("search <query>")
    .description("Search agent memories via Hindsight")
    .option("-a, --agent <name>", "Search a specific agent's collection")
    .action(
      withConfigError(async (query: string, opts: { agent?: string }) => {
        const config = getConfig(program);

        if (opts.agent) {
          if (!config.agents[opts.agent]) {
            console.error(chalk.red(`Agent "${opts.agent}" is not defined in clerk.yaml`));
            process.exit(1);
          }
          const collection = getCollectionForAgent(opts.agent, config);
          console.log(chalk.bold(`\nSearch: ${opts.agent} (collection: ${collection})\n`));
          console.log(chalk.gray(`  $ ${searchMemory(query, collection)}`));
          console.log();
          return;
        }

        // Search all non-strict collections
        const agentNames = Object.keys(config.agents);
        console.log(chalk.bold(`\nSearching all eligible collections:\n`));

        for (const name of agentNames) {
          const collection = getCollectionForAgent(name, config);
          if (isStrictIsolation(name, config)) {
            console.log(chalk.gray(`  ${name} (${collection}) — skipped (strict isolation)`));
            continue;
          }
          console.log(chalk.cyan(`  ${name} (${collection}):`));
          console.log(chalk.gray(`    $ ${searchMemory(query, collection)}`));
        }
        console.log();
      }),
    );

  // clerk memory stats
  memory
    .command("stats")
    .description("List agents with their collection names and isolation mode")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const agentNames = Object.keys(config.agents);

        if (agentNames.length === 0) {
          console.log(chalk.yellow("No agents defined in clerk.yaml"));
          return;
        }

        const headers = ["Agent", "Collection", "Isolation", "Auto-recall"];
        const widths = [20, 20, 12, 12];

        const headerLine = headers
          .map((h, i) => chalk.bold(h.padEnd(widths[i])))
          .join("  ");
        console.log(`\n  ${headerLine}`);

        for (const name of agentNames) {
          const collection = getCollectionForAgent(name, config);
          const isolation = isStrictIsolation(name, config) ? "strict" : "default";
          const autoRecall = config.agents[name].memory?.auto_recall ?? true;

          const row = [
            name.padEnd(widths[0]),
            collection.padEnd(widths[1]),
            isolation.padEnd(widths[2]),
            (autoRecall ? "yes" : "no").padEnd(widths[3]),
          ].join("  ");
          console.log(`  ${row}`);
        }

        console.log();

        // Print stats commands
        console.log(chalk.bold("  Hindsight CLI commands:\n"));
        for (const name of agentNames) {
          const collection = getCollectionForAgent(name, config);
          console.log(chalk.gray(`    $ ${getMemoryStats(collection)}`));
        }
        console.log();
      }),
    );

  // clerk memory reflect
  memory
    .command("reflect")
    .description("Show cross-agent reflection plan")
    .action(
      withConfigError(async () => {
        const config = getConfig(program);
        const { eligible, excluded, commands } = reflectAcrossAgents(config);

        console.log(chalk.bold("\nCross-agent reflection plan\n"));

        if (eligible.length > 0) {
          console.log(chalk.green("  Eligible collections:"));
          for (const { agent, collection } of eligible) {
            console.log(chalk.white(`    ${agent} -> ${collection}`));
          }
        }

        if (excluded.length > 0) {
          console.log(chalk.red("\n  Excluded (strict isolation):"));
          for (const { agent, collection } of excluded) {
            console.log(chalk.gray(`    ${agent} -> ${collection}`));
          }
        }

        if (commands.length > 0) {
          console.log(chalk.bold("\n  Hindsight CLI commands:\n"));
          for (const cmd of commands) {
            console.log(chalk.gray(`    $ ${cmd}`));
          }
        } else {
          console.log(chalk.yellow("\n  No eligible collections for reflection."));
        }
        console.log();
      }),
    );
}
