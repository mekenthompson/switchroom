/**
 * `switchroom migrate {to-docker,to-host}` — host ↔ docker fleet migration.
 *
 * Phase 3b-2a (this PR): scaffolding only.
 *  - Both verbs accept --dry-run, --json, and (to-docker only) --shared-host.
 *  - --dry-run runs the pre-flight checks and prints the plan.
 *  - Without --dry-run, both verbs exit 2 with a "not yet implemented"
 *    message. The mutation paths land in 3b-2b (to-docker happy path)
 *    and 3b-2c (to-host reversal + e2e).
 */
import type { Command } from "commander";
import chalk from "chalk";
import { homedir } from "node:os";
import { join } from "node:path";
import { withConfigError, getConfig } from "../helpers.js";
import { runPreflight, type MigrateVerb } from "./preflight.js";
import { buildPlan, formatPlanJsonl, formatPlanText, type PlanState } from "./plan.js";
import { executePlan } from "./executor.js";

interface DryRunOpts {
  dryRun?: boolean;
  json?: boolean;
  sharedHost?: boolean;
}

async function runMigration(
  verb: MigrateVerb,
  opts: DryRunOpts,
  program: Command,
): Promise<void> {
  const config = getConfig(program);
  const agents = Object.keys(config.agents ?? {}).sort();
  const preflight = await runPreflight(verb, { sharedHost: !!opts.sharedHost });
  if (!preflight.ok) {
    const r = preflight.refusal!;
    console.error(chalk.red(`Pre-flight refused at check: ${r.name}`));
    console.error(`  reason: ${r.reason}`);
    if (r.fixHint) console.error(chalk.gray(`  fix:    ${r.fixHint}`));
    process.exit(1);
  }
  const composeProject = "switchroom-fleet";
  const composePath = join(homedir(), ".switchroom", "compose", "docker-compose.yml");
  const state: PlanState = {
    agents,
    composeProject,
    composePath,
    targetUid: verb === "to-docker" ? process.getuid?.() : undefined,
  };
  const plan = buildPlan(verb, state);
  const result = await executePlan(plan, {
    composeProject,
    composePath,
    onProgress: (m) => process.stderr.write(chalk.gray(`[migrate] ${m}\n`)),
  });
  if (!result.ok) {
    console.error(
      chalk.red(
        `migrate ${verb} FAILED at step ${result.failed!.index + 1}: ${result.failed!.error}`,
      ),
    );
    console.error(
      chalk.gray(
        `Rolled back ${result.rolledBack.length} step(s); see ~/.switchroom/migration.log for details.`,
      ),
    );
    process.exit(1);
  }
  console.log(chalk.green(`migrate ${verb} complete (${result.completed.length} steps).`));
}

async function runDryRun(
  verb: MigrateVerb,
  opts: DryRunOpts,
  program: Command,
): Promise<void> {
  const config = getConfig(program);
  const agents = Object.keys(config.agents ?? {}).sort();

  const preflight = await runPreflight(verb, { sharedHost: !!opts.sharedHost });
  if (!preflight.ok) {
    const r = preflight.refusal!;
    if (opts.json) {
      console.log(
        JSON.stringify({
          kind: "preflight-refusal",
          verb,
          check: r.name,
          reason: r.reason,
          fixHint: r.fixHint,
        }),
      );
    } else {
      console.error(chalk.red(`Pre-flight refused at check: ${r.name}`));
      console.error(`  reason: ${r.reason}`);
      if (r.fixHint) console.error(chalk.gray(`  fix:    ${r.fixHint}`));
    }
    process.exit(1);
  }

  const composeProject = "switchroom-fleet";
  const composePath = join(homedir(), ".switchroom", "compose", "docker-compose.yml");
  const state: PlanState = {
    agents,
    composeProject,
    composePath,
    targetUid: verb === "to-docker" ? process.getuid?.() : undefined,
  };
  const plan = buildPlan(verb, state);

  if (opts.json) {
    process.stdout.write(formatPlanJsonl(plan));
  } else {
    console.log(formatPlanText(plan));
  }
}

export function registerMigrateCommand(program: Command): void {
  const migrate = program
    .command("migrate")
    .description(
      "Migrate the switchroom fleet between host (systemd) and docker runtimes.",
    );

  migrate
    .command("to-docker")
    .description("Migrate the fleet from host systemd units to a docker compose stack.")
    .option("--dry-run", "Preview the plan without executing it")
    .option("--json", "Emit machine-readable JSONL output (with --dry-run)")
    .option(
      "--shared-host",
      "Acknowledge that this Docker daemon hosts foreign containers (Coolify, hindsight, etc.)",
    )
    .action(
      withConfigError(async (opts: DryRunOpts) => {
        if (opts.dryRun) {
          await runDryRun("to-docker", opts, program);
          return;
        }
        await runMigration("to-docker", opts, program);
      }),
    );

  migrate
    .command("to-host")
    .description("Roll the fleet back from docker compose to host systemd units.")
    .option("--dry-run", "Preview the plan without executing it")
    .option("--json", "Emit machine-readable JSONL output (with --dry-run)")
    .action(
      withConfigError(async (opts: DryRunOpts) => {
        if (opts.dryRun) {
          await runDryRun("to-host", opts, program);
          return;
        }
        await runMigration("to-host", opts, program);
      }),
    );
}
