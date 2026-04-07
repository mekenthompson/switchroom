import type { Command } from "commander";
import chalk from "chalk";
import { loadConfig, ConfigError } from "../config/loader.js";
import { syncTopics, listTopics, resolveBotToken, TopicSyncError } from "../telegram/topic-manager.js";

function withError(fn: (...args: any[]) => Promise<void>) {
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
      if (err instanceof TopicSyncError) {
        console.error(chalk.red(`Topic sync error: ${err.message}`));
        if (err.agent) {
          console.error(chalk.gray(`  Agent: ${err.agent}`));
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

function printTable(
  headers: string[],
  rows: string[][],
  widths: number[]
): void {
  const headerLine = headers
    .map((h, i) => chalk.bold(h.padEnd(widths[i])))
    .join("  ");
  console.log(`  ${headerLine}`);

  for (const row of rows) {
    const line = row.map((cell, i) => cell.padEnd(widths[i])).join("  ");
    console.log(`  ${line}`);
  }
}

export function registerTopicsCommand(program: Command): void {
  const topics = program
    .command("topics")
    .description("Manage Telegram forum topics for agents");

  // clerk topics sync
  topics
    .command("sync")
    .description("Create forum topics for agents that don't have one yet")
    .action(
      withError(async () => {
        const config = getConfig(program);

        // Warn about vault reference early
        resolveBotToken(config.telegram.bot_token);

        const agentNames = Object.keys(config.agents);
        if (agentNames.length === 0) {
          console.log(chalk.yellow("No agents defined in clerk.yaml"));
          return;
        }

        console.log(chalk.bold("\nSyncing forum topics...\n"));

        const results = await syncTopics(config);

        if (results.length === 0) {
          console.log(chalk.yellow("  No agents with topic_name found."));
          console.log();
          return;
        }

        const headers = ["Agent", "Topic", "ID", "Status"];
        const widths = [20, 20, 14, 10];

        const rows = results.map((r) => [
          r.agent,
          r.topic_name,
          String(r.topic_id),
          r.status === "created"
            ? chalk.green(r.status)
            : chalk.gray(r.status),
        ]);

        printTable(headers, rows, widths);

        const created = results.filter((r) => r.status === "created").length;
        const existing = results.filter((r) => r.status === "existing").length;
        console.log();
        console.log(
          chalk.gray(`  ${created} created, ${existing} already existed`)
        );
        console.log();
      })
    );

  // clerk topics list
  topics
    .command("list")
    .description("List agent topic mappings")
    .action(
      withError(async () => {
        const config = getConfig(program);

        const agentNames = Object.keys(config.agents);
        if (agentNames.length === 0) {
          console.log(chalk.yellow("No agents defined in clerk.yaml"));
          return;
        }

        const results = listTopics(config);

        if (results.length === 0) {
          console.log(chalk.yellow("  No agents with topic_name found."));
          return;
        }

        console.log();
        const headers = ["Agent", "Topic", "ID"];
        const widths = [20, 20, 14];

        const rows = results.map((r) => [
          r.agent,
          r.topic_name,
          r.topic_id !== null ? String(r.topic_id) : chalk.gray("(not synced)"),
        ]);

        printTable(headers, rows, widths);
        console.log();
      })
    );
}
